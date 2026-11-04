import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ApiError, audit } from "../context.js";
import { assertReleaseAllowed, finance } from "../core.js";
import { sha256 } from "../security.js";
import { row } from "./common.js";
export async function lockListing(c: PoolClient, id: string, release = false) {
  const snapshot = row(
    (await c.query("SELECT * FROM market_listings WHERE id=$1", [id])).rows[0],
  );
  let source: any;
  if (snapshot.animal_project_id) {
    source = row(
      (
        await c.query(
          "SELECT * FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE",
          [snapshot.farm_id, snapshot.animal_project_id],
        )
      ).rows[0],
    );
    if (release) await assertReleaseAllowed(c, snapshot.farm_id, source.id);
  } else {
    const stock = row(
      (
        await c.query(
          "SELECT project_id FROM stock_items WHERE farm_id=$1 AND id=$2",
          [snapshot.farm_id, snapshot.stock_item_id],
        )
      ).rows[0],
    );
    if (stock.project_id) {
      await c.query(
        "SELECT id FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE",
        [snapshot.farm_id, stock.project_id],
      );
      if (release)
        await assertReleaseAllowed(c, snapshot.farm_id, stock.project_id);
    }
    source = row(
      (
        await c.query(
          "SELECT * FROM stock_items WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE",
          [snapshot.farm_id, snapshot.stock_item_id],
        )
      ).rows[0],
    );
  }
  const listing = row(
    (
      await c.query("SELECT * FROM market_listings WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0],
  );
  return { listing, source, animal: !!listing.animal_project_id };
}
export async function reserveOrder(
  c: PoolClient,
  o: {
    id: string;
    listingId: string;
    buyerId: string;
    quantity: number;
    identityIds?: string[];
    payloadHash: string;
    amount?: number;
    currency?: string;
    offerId?: string;
  },
) {
  const {
    listing: l,
    source: s,
    animal,
  } = await lockListing(c, o.listingId, true);
  if (
    l.status !== "active" ||
    (l.expires_at && new Date(l.expires_at).getTime() <= Date.now()) ||
    (l.availability_at && new Date(l.availability_at).getTime() > Date.now())
  )
    throw new ApiError("listing_unavailable", 409);
  if (l.expected_harvest)
    throw new ApiError("expected_harvest_not_available", 409);
  if (animal && (s.status !== "active" || s.current_count === null))
    throw new ApiError("opening_count_required", 409);
  const unit = animal
    ? s.enterprise_type.startsWith("fish")
      ? "fish"
      : s.enterprise_type.startsWith("rabbit")
        ? "rabbit"
        : "bird"
    : s.unit;
  if (!["kg", "g", "l", "ml"].includes(unit) && !Number.isInteger(o.quantity))
    throw new ApiError("whole_count_required");
  if (
    o.quantity <= 0 ||
    o.quantity > Number(l.remaining_quantity) ||
    o.quantity >
      Number(animal ? s.current_count : s.quantity) -
        Number(animal ? s.reserved_count : s.reserved_quantity)
  )
    throw new ApiError("insufficient_stock", 409);
  const amount =
      o.amount ??
      Math.round(
        ((o.quantity * Number(l.price)) / Number(l.price_quantity)) * 100,
      ) / 100,
    code = o.currency ?? l.currency;
  if (amount > 999999999) throw new ApiError("amount_too_large");
  if (code !== l.currency) throw new ApiError("currency_mismatch", 409);
  let ids = o.identityIds ?? [];
  if (!animal && ids.length) throw new ApiError("unexpected_animal_identities");
  if (animal) {
    if (ids.length) {
      if (ids.length !== o.quantity || new Set(ids).size !== ids.length)
        throw new ApiError("identity_count_mismatch");
      const found = await c.query(
        "SELECT a.id FROM animal_identities a WHERE a.farm_id=$1 AND a.project_id=$2 AND a.id=ANY($3::uuid[]) AND a.status='active' AND NOT EXISTS(SELECT 1 FROM animal_market_reservations r WHERE r.identity_id=a.id) FOR UPDATE",
        [l.farm_id, s.id, ids],
      );
      if (found.rowCount !== ids.length)
        throw new ApiError("animal_identity_unavailable", 409);
    } else {
      const counts = (
        await c.query(
          "SELECT count(*)::int AS active,count(r.identity_id)::int AS reserved FROM animal_identities a LEFT JOIN animal_market_reservations r ON r.identity_id=a.id WHERE a.farm_id=$1 AND a.project_id=$2 AND a.status='active'",
          [l.farm_id, s.id],
        )
      ).rows[0];
      const unidentified =
        Number(s.current_count) -
        counts.active -
        (Number(s.reserved_count) - counts.reserved);
      const needed = Math.max(0, o.quantity - unidentified);
      if (needed)
        ids = (
          await c.query(
            "SELECT a.id FROM animal_identities a WHERE a.farm_id=$1 AND a.project_id=$2 AND a.status='active' AND NOT EXISTS(SELECT 1 FROM animal_market_reservations r WHERE r.identity_id=a.id) ORDER BY a.id LIMIT $3 FOR UPDATE",
            [l.farm_id, s.id, needed],
          )
        ).rows.map((r) => r.id);
      if (ids.length !== needed)
        throw new ApiError("animal_reconciliation_required", 409);
    }
    await c.query(
      "UPDATE projects SET reserved_count=reserved_count+$3,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2",
      [l.farm_id, s.id, o.quantity],
    );
  } else
    await c.query(
      "UPDATE stock_items SET reserved_quantity=reserved_quantity+$2,version=version+1 WHERE id=$1",
      [s.id, o.quantity],
    );
  await c.query(
    "UPDATE market_listings SET remaining_quantity=remaining_quantity-$2,version=version+1,updated_at=now() WHERE id=$1",
    [l.id, o.quantity],
  );
  const order = (
    await c.query(
      "INSERT INTO market_orders(id,listing_id,buyer_id,quantity,unit,amount,currency,payload_hash,identity_ids,offer_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,LEAST(clock_timestamp()+interval '24 hours',COALESCE($11::timestamptz,'infinity'::timestamptz))) RETURNING *",
      [
        o.id,
        l.id,
        o.buyerId,
        o.quantity,
        unit,
        amount,
        code,
        o.payloadHash,
        ids,
        o.offerId ?? null,
        l.expires_at,
      ],
    )
  ).rows[0];
  for (const id of ids)
    await c.query(
      "INSERT INTO animal_market_reservations(identity_id,order_id,farm_id) VALUES($1,$2,$3)",
      [id, order.id, l.farm_id],
    );
  await audit(
    c,
    l.farm_id,
    o.buyerId,
    "market_order",
    order.id,
    "reserved",
    "explicit_commercial_request",
    null,
    { listingId: l.id, quantity: o.quantity, expiresAt: order.expires_at },
  );
  return order;
}
export async function changeOrder(
  c: PoolClient,
  id: string,
  status: "cancelled" | "fulfilled",
  actor: string,
  reason = "requested",
) {
  const snapshot = row(
    (await c.query("SELECT listing_id FROM market_orders WHERE id=$1", [id]))
      .rows[0],
  );
  const {
    listing: l,
    source: s,
    animal,
  } = await lockListing(c, snapshot.listing_id, status === "fulfilled");
  const order = row(
    (await c.query("SELECT * FROM market_orders WHERE id=$1 FOR UPDATE", [id]))
      .rows[0],
  );
  if (order.status === status) return order;
  if (order.status !== "reserved")
    throw new ApiError("invalid_transition", 409);
  if (status === "fulfilled" && Date.parse(order.expires_at) <= Date.now())
    throw new ApiError("reservation_expired", 409);
  if (
    Number(animal ? s.reserved_count : s.reserved_quantity) <
    Number(order.quantity)
  )
    throw new ApiError("stock_reconciliation_required", 409);
  const n = Number(order.quantity);
  let eventId: string | null = null;
  if (status === "cancelled") {
    if (animal)
      await c.query(
        "UPDATE projects SET reserved_count=reserved_count-$2,version=version+1 WHERE id=$1",
        [s.id, n],
      );
    else
      await c.query(
        "UPDATE stock_items SET reserved_quantity=reserved_quantity-$2,version=version+1 WHERE id=$1",
        [s.id, n],
      );
    await c.query(
      "UPDATE market_listings SET remaining_quantity=remaining_quantity+$2,version=version+1,updated_at=now() WHERE id=$1",
      [l.id, n],
    );
  } else {
    if (animal) {
      if (s.status !== "active") throw new ApiError("project_closed", 409);
      eventId = randomUUID();
      if (order.identity_ids.length) {
        const found = await c.query(
          "SELECT id FROM animal_identities WHERE farm_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) AND status='active' FOR UPDATE",
          [l.farm_id, s.id, order.identity_ids],
        );
        if (found.rowCount !== order.identity_ids.length)
          throw new ApiError("animal_reconciliation_required", 409);
        await c.query(
          "UPDATE animal_identities SET status='sold' WHERE id=ANY($1::uuid[])",
          [order.identity_ids],
        );
      }
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM animal_identities WHERE farm_id=$1 AND project_id=$2 AND status='active'",
              [l.farm_id, s.id],
            )
          ).rows[0].n,
        ) >
        Number(s.current_count) - n
      )
        throw new ApiError("animal_reconciliation_required", 409);
      await c.query(
        "UPDATE projects SET current_count=current_count-$2,reserved_count=reserved_count-$2,version=version+1,updated_at=now() WHERE id=$1",
        [s.id, n],
      );
      const metadata = {
        marketOrderId: id,
        identityIds: order.identity_ids,
        provenance: "fulfilled_market_order",
      };
      await c.query(
        "INSERT INTO animal_events(id,farm_id,project_id,actor_id,type,observed_at,count,note,metadata,payload_hash,source_project_version) VALUES($1,$2,$3,$4,'sale',clock_timestamp(),$5,$6,$7,$8,$9)",
        [
          eventId,
          l.farm_id,
          s.id,
          actor,
          n,
          `market_order:${id}`,
          JSON.stringify(metadata),
          sha256(JSON.stringify(metadata)),
          s.version + 1,
        ],
      );
    } else {
      await c.query(
        "UPDATE stock_items SET quantity=quantity-$2,reserved_quantity=reserved_quantity-$2,version=version+1 WHERE id=$1",
        [s.id, n],
      );
      await c.query(
        "INSERT INTO stock_movements(id,farm_id,stock_item_id,project_id,actor_id,kind,quantity,unit,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,$5,'sale',-$6::numeric,$7,'market_order',$8,clock_timestamp())",
        [randomUUID(), l.farm_id, s.id, s.project_id, actor, n, order.unit, id],
      );
    }
    await finance(c, {
      farmId: l.farm_id,
      projectId: animal ? s.id : s.project_id,
      actorId: actor,
      kind: "revenue",
      amount: Number(order.amount),
      currency: order.currency,
      sourceType: "market_order",
      sourceId: id,
      observedAt: new Date().toISOString(),
    });
  }
  await c.query("DELETE FROM animal_market_reservations WHERE order_id=$1", [
    id,
  ]);
  const next = (
    await c.query(
      "UPDATE market_orders SET status=$2,fulfilment_event_id=$3,cancellation_reason=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [id, status, eventId, status === "cancelled" ? reason : null],
    )
  ).rows[0];
  await audit(
    c,
    l.farm_id,
    actor,
    "market_order",
    id,
    status,
    reason,
    order,
    next,
  );
  return next;
}
// The caller holds the project lock. Recording a physical loss must remain possible;
// affected commitments are cancelled, with a visible reason, before reducing counts.
export async function reconcileAnimalReservations(
  c: PoolClient,
  farmId: string,
  projectId: string,
  nextCount: number,
  identityIds: string[],
  actor: string,
) {
  const orders = (
    await c.query(
      "SELECT o.id,o.quantity,o.identity_ids FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE l.farm_id=$1 AND l.animal_project_id=$2 AND o.status='reserved' ORDER BY o.created_at DESC,o.id",
      [farmId, projectId],
    )
  ).rows;
  let reserved = orders.reduce((sum, o) => sum + Number(o.quantity), 0);
  for (const order of orders) {
    if (
      reserved <= nextCount &&
      !order.identity_ids.some((id: string) => identityIds.includes(id))
    )
      continue;
    await changeOrder(
      c,
      order.id,
      "cancelled",
      actor,
      "physical_loss_or_count_correction",
    );
    reserved -= Number(order.quantity);
  }
}
export async function runMarketMaintenance(c: PoolClient) {
  const candidates = (
    await c.query(
      "SELECT o.id,o.listing_id,o.buyer_id,COALESCE(l.animal_project_id,s.project_id) AS project_id,l.stock_item_id FROM market_orders o JOIN market_listings l ON l.id=o.listing_id LEFT JOIN stock_items s ON s.id=l.stock_item_id WHERE o.status='reserved' AND (o.expires_at<=clock_timestamp() OR l.expires_at<=clock_timestamp()) ORDER BY o.id LIMIT 500",
    )
  ).rows;
  // Multi-order maintenance follows the same project -> stock -> listing -> order
  // lock order as release/transfer operations, then rechecks each expired state.
  const projects = [
      ...new Set(candidates.map((o) => o.project_id).filter(Boolean)),
    ].sort(),
    stocks = [
      ...new Set(candidates.map((o) => o.stock_item_id).filter(Boolean)),
    ].sort(),
    listings = [...new Set(candidates.map((o) => o.listing_id))].sort();
  if (projects.length)
    await c.query(
      "SELECT id FROM projects WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
      [projects],
    );
  if (stocks.length)
    await c.query(
      "SELECT id FROM stock_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
      [stocks],
    );
  if (listings.length)
    await c.query(
      "SELECT id FROM market_listings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [listings],
    );
  let expired = 0;
  for (const o of candidates) {
    const check = (
      await c.query(
        "SELECT o.status,(o.expires_at<=clock_timestamp() OR l.expires_at<=clock_timestamp()) AS expired FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE o.id=$1 FOR UPDATE OF o",
        [o.id],
      )
    ).rows[0];
    if (check?.status === "reserved" && check.expired) {
      await changeOrder(
        c,
        o.id,
        "cancelled",
        o.buyer_id,
        "reservation_expired",
      );
      expired++;
    }
  }
  await c.query(
    "UPDATE market_listings SET status='archived',version=version+1,updated_at=now() WHERE status='active' AND expires_at<=clock_timestamp()",
  );
  await c.query(
    "UPDATE market_offers SET status='expired',version=version+1 WHERE status='pending' AND expires_at<=clock_timestamp()",
  );
  await c.query(
    "UPDATE buying_requests SET status='closed',version=version+1,updated_at=now() WHERE status='open' AND expires_at<=clock_timestamp()",
  );
  return { expiredOrders: expired };
}
