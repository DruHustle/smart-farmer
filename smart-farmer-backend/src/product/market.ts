import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import sharp from "sharp";
import { guardAccountingSource, managedSourceBalance } from "../accounting/bridge.js";
import { ApiError, audit, manageRoles, type Context } from "../context.js";
import {
  uuid,
  when,
  money,
  currency,
  quantity,
  assertReleaseAllowed,
  finance,
} from "../core.js";
import { sha256 } from "../security.js";
import { getObjectStore } from "../integrations/media.js";
import {
  auth,
  idempotent,
  listQuery,
  page,
  row,
  text,
  project,
} from "./common.js";
import { lockListing, reserveOrder, changeOrder } from "./market-ledger.js";
const positive = quantity.refine((v) => v > 0),
  category = z.enum(["produce", "input", "animal", "equipment", "other"]);
const listingInput = z
  .object({
    id: uuid,
    stockItemId: uuid.nullable().default(null),
    animalProjectId: uuid.nullable().default(null),
    title: z.string().trim().min(1).max(150),
    quantity: positive,
    price: money,
    currency,
    collectionArea: z.string().trim().min(1).max(150),
    terms: z.string().max(1500).default(""),
    category: category.default("produce"),
    grade: z.string().max(100).default(""),
    condition: z.string().max(1000).default(""),
    priceBasis: z.string().trim().min(1).max(100).default("unit"),
    priceQuantity: positive.optional(),
    availabilityAt: when.nullable().default(null),
    expiresAt: when.nullable().default(null),
    expectedHarvest: z.boolean().default(false),
    photoMediaIds: z.array(uuid).max(10).default([]),
  })
  .strict()
  .refine(
    (b) => !!b.stockItemId !== !!b.animalProjectId,
    "one_listing_source_required",
  );
const publicSelect = `SELECT l.id,l.title,l.price,l.currency,l.collection_area,l.terms,l.category,l.grade,l.condition,l.price_basis,l.price_quantity,l.availability_at,l.expires_at,l.expected_harvest,l.photo_media_ids,l.version,l.created_at,f.name AS seller_name,CASE WHEN l.animal_project_id IS NOT NULL THEN p.count_basis ELSE NULL END AS count_basis,CASE WHEN l.animal_project_id IS NOT NULL THEN CASE WHEN p.enterprise_type LIKE 'fish%' THEN 'fish' WHEN p.enterprise_type LIKE 'rabbit%' THEN 'rabbit' ELSE 'bird' END ELSE s.unit END AS unit,CASE WHEN l.expected_harvest THEN 0 ELSE GREATEST(0,LEAST(l.remaining_quantity,CASE WHEN l.animal_project_id IS NOT NULL THEN p.current_count-p.reserved_count ELSE s.quantity-s.reserved_quantity END)) END AS available_quantity,CASE WHEN l.expected_harvest THEN l.remaining_quantity ELSE NULL END AS expected_quantity FROM market_listings l JOIN farms f ON f.id=l.farm_id LEFT JOIN stock_items s ON s.id=l.stock_item_id LEFT JOIN projects p ON p.id=l.animal_project_id`;
const publicWhere = `l.status='active' AND (l.expires_at IS NULL OR l.expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM treatment_restrictions r WHERE r.farm_id=l.farm_id AND r.project_id=COALESCE(l.animal_project_id,s.project_id) AND r.starts_at<=clock_timestamp() AND r.ends_at>clock_timestamp() AND r.scope IN('all','sale'))`;
async function validatePhotos(c: PoolClient, farmId: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new ApiError("duplicate_photo");
  for (const id of ids)
    row(
      (
        await c.query(
          "SELECT m.id FROM private_media m LEFT JOIN activities a ON a.farm_id=m.farm_id AND a.id=m.activity_id WHERE m.farm_id=$1 AND m.id=$2 AND m.mime_type IN('image/jpeg','image/png','image/webp') AND NOT m.financial AND COALESCE(a.kind,'')<>'cost' AND a.amount IS NULL AND NOT EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=m.farm_id AND f.receipt_activity_id=a.id)",
          [farmId, id],
        )
      ).rows[0],
      "photo_not_publishable",
    );
}
async function isSeller(ctx: Context, farmId: string, user: string) {
  return ctx.member(farmId, user, manageRoles);
}
const globalModerator = (id: string) =>
  (process.env.MARKET_MODERATOR_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(id);
export function registerMarket(app: FastifyInstance, ctx: Context) {
  app.get("/v1/farms/:farmId/listings", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const q = listQuery.parse(req.query);
    return page(
      (
        await ctx.db.query(
          "SELECT l.*,COALESCE(s.unit,CASE WHEN p.enterprise_type LIKE 'fish%' THEN 'fish' WHEN p.enterprise_type LIKE 'rabbit%' THEN 'rabbit' ELSE 'bird' END) AS unit FROM market_listings l LEFT JOIN stock_items s ON s.id=l.stock_item_id LEFT JOIN projects p ON p.id=l.animal_project_id WHERE l.farm_id=$1 AND ($2::uuid IS NULL OR l.id<$2) ORDER BY l.id DESC LIMIT $3",
          [a.farmId, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.get("/v1/market/listings", async (req) => {
    const q = listQuery
      .extend({
        q: z.string().max(100).default(""),
        category: category.optional(),
      })
      .parse(req.query);
    return page(
      (
        await ctx.db.query(
          `${publicSelect} WHERE ${publicWhere} AND l.title ILIKE '%'||$1||'%' AND ($2::uuid IS NULL OR l.id<$2) AND ($3::text IS NULL OR l.category=$3) ORDER BY l.id DESC LIMIT $4`,
          [q.q, q.cursor ?? null, q.category ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.get("/v1/market/listings/:listingId", async (req) => {
    const { listingId } = z.object({ listingId: uuid }).parse(req.params);
    return row(
      (
        await ctx.db.query(`${publicSelect} WHERE ${publicWhere} AND l.id=$1`, [
          listingId,
        ])
      ).rows[0],
    );
  });
  app.get(
    "/v1/market/listings/:listingId/photos/:mediaId",
    async (req, reply) => {
      const { listingId, mediaId } = z
        .object({ listingId: uuid, mediaId: uuid })
        .parse(req.params);
      const media = row(
        (
          await ctx.db.query(
            `SELECT m.* FROM market_listings l LEFT JOIN stock_items s ON s.id=l.stock_item_id JOIN private_media m ON m.farm_id=l.farm_id AND m.id=ANY(l.photo_media_ids) LEFT JOIN activities a ON a.farm_id=m.farm_id AND a.id=m.activity_id WHERE ${publicWhere} AND l.id=$1 AND m.id=$2 AND m.mime_type IN('image/jpeg','image/png','image/webp') AND NOT m.financial AND COALESCE(a.kind,'')<>'cost' AND a.amount IS NULL AND NOT EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=m.farm_id AND f.receipt_activity_id=a.id)`,
            [listingId, mediaId],
          )
        ).rows[0],
      );
      const bytes = await getObjectStore().get(media.object_key);
      if (
        createHash("sha256").update(bytes).digest("hex") !== media.content_hash
      )
        throw new ApiError("media_integrity_error", 503);
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .type("image/webp")
        .send(
          await sharp(bytes, {
            limitInputPixels: 40_000_000,
            failOn: "warning",
          })
            .rotate()
            .resize({
              width: 1600,
              height: 1600,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 84 })
            .toBuffer(),
        );
    },
  );
  app.post("/v1/farms/:farmId/listings", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const b = listingInput.parse(req.body);
    if (b.priceBasis !== "unit" && b.priceQuantity === undefined)
      throw new ApiError("price_quantity_required");
    const priceQuantity = b.priceQuantity ?? 1;
    if (b.expiresAt && Date.parse(b.expiresAt) <= Date.now())
      throw new ApiError("expiry_must_be_future");
    const out = await idempotent(
      ctx,
      a.farmId,
      a.actor,
      b.id,
      { operation: "listing", ...b },
      async (c) => {
        let available: number, unit: string;
        if (b.animalProjectId) {
          const p = await project(c, a.farmId, b.animalProjectId, true);
          if (["crop", "hatchery", "fish_hatchery"].includes(p.enterprise_type))
            throw new ApiError("live_animal_project_required");
          if (b.category !== "animal" || b.expectedHarvest)
            throw new ApiError("animal_listing_required");
          if (p.current_count === null || p.status !== "active")
            throw new ApiError("opening_count_required", 409);
          await assertReleaseAllowed(c, a.farmId, p.id);
          available = Number(p.current_count) - Number(p.reserved_count);
          unit = "count";
        } else {
          const snapshot = row(
            (
              await c.query(
                "SELECT project_id FROM stock_items WHERE farm_id=$1 AND id=$2",
                [a.farmId, b.stockItemId],
              )
            ).rows[0],
          );
          if (snapshot.project_id)
            await assertReleaseAllowed(c, a.farmId, snapshot.project_id);
          const s = row(
            (
              await c.query(
                "SELECT * FROM stock_items WHERE farm_id=$1 AND id=$2 FOR UPDATE",
                [a.farmId, b.stockItemId],
              )
            ).rows[0],
          );
          if (
            ["bird", "rabbit", "fish"].includes(s.unit) ||
            (s.unit === "count" &&
              s.project_id &&
              (await project(c, a.farmId, s.project_id)).enterprise_type !==
                "crop")
          )
            throw new ApiError("live_animal_market_not_ready", 409);
          available = Number(s.quantity) - Number(s.reserved_quantity);
          unit = s.unit;
          if (b.expectedHarvest && !s.project_id)
            throw new ApiError("expected_harvest_project_required");
        }
        if (
          !["kg", "g", "l", "ml"].includes(unit) &&
          (!Number.isInteger(b.quantity) || !Number.isInteger(priceQuantity))
        )
          throw new ApiError("whole_count_required");
        if (!b.expectedHarvest && b.quantity > available)
          throw new ApiError("insufficient_stock", 409);
        await validatePhotos(c, a.farmId, b.photoMediaIds);
        return (
          await c.query(
            "INSERT INTO market_listings(id,farm_id,stock_item_id,animal_project_id,created_by,title,quantity,remaining_quantity,price,currency,collection_area,terms,payload_hash,category,grade,condition,price_basis,availability_at,expires_at,expected_harvest,photo_media_ids,price_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *",
            [
              b.id,
              a.farmId,
              b.stockItemId,
              b.animalProjectId,
              a.actor,
              b.title,
              b.quantity,
              b.price,
              b.currency,
              b.collectionArea,
              b.terms,
              sha256(JSON.stringify(b)),
              b.category,
              b.grade,
              b.condition,
              b.priceBasis,
              b.availabilityAt,
              b.expiresAt,
              b.expectedHarvest,
              b.photoMediaIds,
              priceQuantity,
            ],
          )
        ).rows[0];
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.patch("/v1/farms/:farmId/listings/:listingId", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const { listingId } = z.object({ listingId: uuid }).parse(req.params);
    const b = z
      .object({
        version: z.number().int().positive(),
        reason: text,
        title: z.string().trim().min(1).max(150).optional(),
        quantity: positive.optional(),
        price: money.optional(),
        currency: currency.optional(),
        collectionArea: z.string().trim().min(1).max(150).optional(),
        terms: z.string().max(1500).optional(),
        grade: z.string().max(100).optional(),
        condition: z.string().max(1000).optional(),
        priceBasis: z.string().trim().min(1).max(100).optional(),
        priceQuantity: positive.optional(),
        availabilityAt: when.nullable().optional(),
        expiresAt: when.nullable().optional(),
        photoMediaIds: z.array(uuid).max(10).optional(),
        expectedHarvest: z.boolean().optional(),
        status: z.enum(["active", "archived"]).optional(),
      })
      .strict()
      .parse(req.body);
    return ctx.transaction(async (c) => {
      const snap = row(
        (
          await c.query("SELECT farm_id FROM market_listings WHERE id=$1", [
            listingId,
          ])
        ).rows[0],
      );
      if (snap.farm_id !== a.farmId) throw new ApiError("not_found", 404);
      const {
        listing: l,
        source: s,
        animal,
      } = await lockListing(c, listingId, b.status !== "archived");
      if (l.version !== b.version)
        throw new ApiError("version_conflict", 409, { current: l });
      if (b.expiresAt && Date.parse(b.expiresAt) <= Date.now())
        throw new ApiError("expiry_must_be_future");
      if (b.photoMediaIds) await validatePhotos(c, a.farmId, b.photoMediaIds);
      if (
        b.priceBasis &&
        b.priceBasis !== "unit" &&
        b.priceQuantity === undefined
      )
        throw new ApiError("price_quantity_required");
      const nextPriceQuantity = b.priceQuantity ?? Number(l.price_quantity);
      const nextQuantity = b.quantity ?? Number(l.quantity),
        remaining =
          Number(l.remaining_quantity) + nextQuantity - Number(l.quantity),
        expected = b.expectedHarvest ?? l.expected_harvest;
      if (remaining < 0) throw new ApiError("quantity_below_committed", 409);
      if (animal && expected) throw new ApiError("animal_listing_required");
      if (
        !["kg", "g", "l", "ml"].includes(animal ? "count" : s.unit) &&
        (!Number.isInteger(nextQuantity) ||
          !Number.isInteger(nextPriceQuantity))
      )
        throw new ApiError("whole_count_required");
      if (
        (b.status ?? l.status) === "active" &&
        !expected &&
        (b.quantity !== undefined ||
          b.expectedHarvest === false ||
          b.status === "active") &&
        remaining >
          Number(animal ? s.current_count : s.quantity) -
            Number(animal ? s.reserved_count : s.reserved_quantity)
      )
        throw new ApiError("insufficient_stock", 409);
      if (
        expected &&
        (
          await c.query(
            "SELECT 1 FROM market_orders WHERE listing_id=$1 AND status='reserved'",
            [listingId],
          )
        ).rowCount
      )
        throw new ApiError("active_reservations", 409);
      const next = (
        await c.query(
          "UPDATE market_listings SET title=$2,quantity=$3,remaining_quantity=$4,price=$5,currency=$6,collection_area=$7,terms=$8,grade=$9,condition=$10,price_basis=$11,availability_at=$12,expires_at=$13,photo_media_ids=$14,expected_harvest=$15,status=$16,price_quantity=$17,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [
            listingId,
            b.title ?? l.title,
            nextQuantity,
            remaining,
            b.price ?? l.price,
            b.currency ?? l.currency,
            b.collectionArea ?? l.collection_area,
            b.terms ?? l.terms,
            b.grade ?? l.grade,
            b.condition ?? l.condition,
            b.priceBasis ?? l.price_basis,
            b.availabilityAt === undefined
              ? l.availability_at
              : b.availabilityAt,
            b.expiresAt === undefined ? l.expires_at : b.expiresAt,
            b.photoMediaIds ?? l.photo_media_ids,
            expected,
            b.status ?? l.status,
            nextPriceQuantity,
          ],
        )
      ).rows[0];
      await audit(
        c,
        a.farmId,
        a.actor,
        "listing",
        listingId,
        "updated",
        b.reason,
        l,
        next,
      );
      return next;
    });
  });
  app.post(
    "/v1/farms/:farmId/listings/:listingId/archive",
    async (req, reply) => {
      const a = await auth(ctx, req, reply, manageRoles);
      if (!a) return;
      const { listingId } = z.object({ listingId: uuid }).parse(req.params);
      return ctx.transaction(async (c) => {
        const l = row(
          (
            await c.query(
              "UPDATE market_listings SET status='archived',version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2 RETURNING *",
              [a.farmId, listingId],
            )
          ).rows[0],
        );
        await audit(
          c,
          a.farmId,
          a.actor,
          "listing",
          listingId,
          "archived",
          "seller_archive",
        );
        return { id: l.id, status: l.status };
      });
    },
  );
  app.post("/v1/market/listings/:listingId/orders", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { listingId } = z.object({ listingId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        quantity: positive,
        identityIds: z.array(uuid).max(500).default([]),
      })
      .strict()
      .parse(req.body);
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "reserve", listingId, ...b },
      (c) =>
        reserveOrder(c, {
          id: b.id,
          listingId,
          buyerId: actor,
          quantity: b.quantity,
          identityIds: b.identityIds,
          payloadHash: sha256(JSON.stringify(b)),
        }),
    );
    return reply
      .code(out.replayed ? 200 : 201)
      .send(
        out.replayed
          ? row(
              (
                await ctx.db.query("SELECT * FROM market_orders WHERE id=$1", [
                  out.body.id,
                ])
              ).rows[0],
            )
          : out.body,
      );
  });
  app.get("/v1/market/orders", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const q = listQuery.parse(req.query);
    const orders=(await ctx.db.query(
      "SELECT o.id,o.listing_id,l.farm_id AS seller_farm_id,l.title,o.quantity,o.unit,o.amount,o.currency,o.status,o.created_at,o.expires_at,o.cancellation_reason,o.identity_ids,(o.buyer_id=$1) AS is_buyer,EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=l.farm_id AND m.user_id=$1 AND m.role IN('owner','manager')) AS is_seller,COALESCE((SELECT sum(p.amount) FROM commerce_payments p WHERE p.order_id=o.id),0) AS manually_recorded_paid FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE (o.buyer_id=$1 OR EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=l.farm_id AND m.user_id=$1 AND m.role IN('owner','manager'))) AND ($2::uuid IS NULL OR o.id<$2) ORDER BY o.id DESC LIMIT $3",
      [actor,q.cursor??null,q.limit+1])).rows;
    return page(await Promise.all(orders.map(async ({seller_farm_id,...order})=>{
      // Buyers must not receive the seller's private bookkeeping identifiers or adjustments.
      const managed=order.is_seller?await managedSourceBalance(ctx.db,seller_farm_id,'market_order',order.id):null;
      return {...order,accountingInvoiceId:managed?.accountingInvoiceId??null,accountingFarmId:managed?seller_farm_id:null,accountingManaged:!!managed,...(managed?{manually_recorded_paid:managed.paid,accountingOutstanding:managed.balance,accountingCredited:managed.credited}:{})};
    })),q.limit);
  });
  app.post("/v1/market/orders/:orderId/status", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { orderId } = z.object({ orderId: uuid }).parse(req.params);
    const b = z
      .object({ status: z.enum(["cancelled", "fulfilled"]) })
      .strict()
      .parse(req.body);
    return ctx.transaction(async (c) => {
      const o = row(
        (
          await c.query(
            "SELECT o.buyer_id,l.farm_id FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE o.id=$1",
            [orderId],
          )
        ).rows[0],
      );
      if (
        !(await isSeller(ctx, o.farm_id, actor)) &&
        (b.status !== "cancelled" || o.buyer_id !== actor)
      )
        throw new ApiError("not_found", 404);
      return changeOrder(c, orderId, b.status, actor);
    });
  });
  app.post("/v1/market/orders/:orderId/payments", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { orderId } = z.object({ orderId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        amount: money.refine((v) => v > 0),
        currency,
        note: z.string().max(500).default(""),
      })
      .strict()
      .parse(req.body);
    const snapshot = row(
      (
        await ctx.db.query(
          "SELECT l.farm_id FROM market_orders o JOIN market_listings l ON l.id=o.listing_id WHERE o.id=$1",
          [orderId],
        )
      ).rows[0],
    );
    if (!(await isSeller(ctx, snapshot.farm_id, actor)))
      throw new ApiError("not_found", 404);
    const out = await idempotent(
      ctx,
      snapshot.farm_id,
      actor,
      b.id,
      { operation: "market_payment", orderId, ...b },
      async (c) => {
        await guardAccountingSource(c, snapshot.farm_id, 'market_order', orderId);
        const o = row(
          (
            await c.query(
              "SELECT o.*,l.farm_id,COALESCE(l.animal_project_id,s.project_id) AS project_id FROM market_orders o JOIN market_listings l ON l.id=o.listing_id LEFT JOIN stock_items s ON s.id=l.stock_item_id WHERE o.id=$1 FOR UPDATE OF o",
              [orderId],
            )
          ).rows[0],
        );
        if (o.status !== "fulfilled")
          throw new ApiError("order_not_fulfilled", 409);
        if (o.currency !== b.currency)
          throw new ApiError("currency_mismatch", 409);
        const paid = Number(
          (
            await c.query(
              "SELECT COALESCE(sum(amount),0) AS n FROM commerce_payments WHERE order_id=$1",
              [orderId],
            )
          ).rows[0].n,
        );
        if (
          Math.round((paid + b.amount) * 100) >
          Math.round(Number(o.amount) * 100)
        )
          throw new ApiError("payment_exceeds_balance", 409);
        await c.query(
          "INSERT INTO commerce_payments(id,order_id,recorded_by,amount,currency,note) VALUES($1,$2,$3,$4,$5,$6)",
          [b.id, orderId, actor, b.amount, b.currency, b.note],
        );
        await finance(c, {
          farmId: o.farm_id,
          projectId: o.project_id,
          actorId: actor,
          kind: "payment",
          amount: b.amount,
          currency: b.currency,
          sourceType: "manual_market_payment",
          sourceId: b.id,
          observedAt: new Date().toISOString(),
        });
        return { id: b.id, provenance: "manual", providerVerified: false };
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.post("/v1/market/listings/:listingId/enquiries", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { listingId } = z.object({ listingId: uuid }).parse(req.params);
    const b = z.object({ id: uuid, message: text }).strict().parse(req.body);
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "enquiry", listingId, ...b },
      async (c) => {
        row(
          (
            await c.query(
              "SELECT id FROM market_listings WHERE id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>clock_timestamp())",
              [listingId],
            )
          ).rows[0],
        );
        await c.query(
          "INSERT INTO market_enquiries(id,listing_id,buyer_id) VALUES($1,$2,$3)",
          [b.id, listingId, actor],
        );
        await c.query(
          "INSERT INTO market_messages(id,enquiry_id,actor_id,message) VALUES($1,$1,$2,$3)",
          [b.id, actor, b.message],
        );
        return { id: b.id, listingId, message: b.message };
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.get("/v1/market/listings/:listingId/enquiries", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { listingId } = z.object({ listingId: uuid }).parse(req.params),
      q = listQuery.parse(req.query);
    const l = row(
      (
        await ctx.db.query("SELECT farm_id FROM market_listings WHERE id=$1", [
          listingId,
        ])
      ).rows[0],
    );
    const seller = await isSeller(ctx, l.farm_id, actor);
    return page(
      (
        await ctx.db.query(
          "SELECT e.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'message',m.message,'actor_id',m.actor_id,'created_at',m.created_at) ORDER BY m.created_at,m.id) FROM market_messages m WHERE m.enquiry_id=e.id),'[]'::jsonb) AS messages FROM market_enquiries e WHERE e.listing_id=$1 AND ($2::boolean OR e.buyer_id=$3) AND ($4::uuid IS NULL OR e.id<$4) ORDER BY e.id DESC LIMIT $5",
          [listingId, seller, actor, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/market/enquiries/:enquiryId/messages", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { enquiryId } = z.object({ enquiryId: uuid }).parse(req.params);
    const b = z.object({ id: uuid, message: text }).strict().parse(req.body);
    const e = row(
      (
        await ctx.db.query(
          "SELECT e.buyer_id,l.farm_id FROM market_enquiries e JOIN market_listings l ON l.id=e.listing_id WHERE e.id=$1",
          [enquiryId],
        )
      ).rows[0],
    );
    if (e.buyer_id !== actor && !(await isSeller(ctx, e.farm_id, actor)))
      throw new ApiError("not_found", 404);
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "market_message", enquiryId, ...b },
      async (c) =>
        (
          await c.query(
            "INSERT INTO market_messages(id,enquiry_id,actor_id,message) VALUES($1,$2,$3,$4) RETURNING *",
            [b.id, enquiryId, actor, b.message],
          )
        ).rows[0],
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.get("/v1/market/listings/:listingId/offers", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { listingId } = z.object({ listingId: uuid }).parse(req.params),
      q = listQuery.parse(req.query);
    const l = row(
      (
        await ctx.db.query("SELECT farm_id FROM market_listings WHERE id=$1", [
          listingId,
        ])
      ).rows[0],
    );
    return page(
      (
        await ctx.db.query(
          "SELECT * FROM market_offers WHERE listing_id=$1 AND ($2::boolean OR buyer_id=$3) AND ($4::uuid IS NULL OR id<$4) ORDER BY id DESC LIMIT $5",
          [
            listingId,
            await isSeller(ctx, l.farm_id, actor),
            actor,
            q.cursor ?? null,
            q.limit + 1,
          ],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/market/listings/:listingId/offers", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { listingId } = z.object({ listingId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        quantity: positive,
        amount: money,
        currency,
        message: z.string().max(2000).default(""),
        expiresAt: when,
      })
      .strict()
      .parse(req.body);
    if (Date.parse(b.expiresAt) <= Date.now())
      throw new ApiError("expiry_must_be_future");
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "offer", listingId, ...b },
      async (c) => {
        const l = row(
          (
            await c.query(
              "SELECT * FROM market_listings WHERE id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>clock_timestamp())",
              [listingId],
            )
          ).rows[0],
        );
        if (l.currency !== b.currency)
          throw new ApiError("currency_mismatch", 409);
        return (
          await c.query(
            "INSERT INTO market_offers(id,listing_id,buyer_id,quantity,amount,currency,message,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              b.id,
              listingId,
              actor,
              b.quantity,
              b.amount,
              b.currency,
              b.message,
              b.expiresAt,
            ],
          )
        ).rows[0];
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.post("/v1/market/offers/:offerId/status", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { offerId } = z.object({ offerId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        version: z.number().int().positive(),
        status: z.enum(["accepted", "rejected", "withdrawn"]),
      })
      .strict()
      .parse(req.body);
    const snapshot = row(
      (
        await ctx.db.query(
          "SELECT o.*,l.farm_id FROM market_offers o JOIN market_listings l ON l.id=o.listing_id WHERE o.id=$1",
          [offerId],
        )
      ).rows[0],
    );
    if (
      b.status === "withdrawn"
        ? snapshot.buyer_id !== actor
        : !(await isSeller(ctx, snapshot.farm_id, actor))
    )
      throw new ApiError("not_found", 404);
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "offer_status", offerId, ...b },
      async (c) => {
        await lockListing(c, snapshot.listing_id, b.status === "accepted");
        const offer = row(
          (
            await c.query(
              "SELECT * FROM market_offers WHERE id=$1 FOR UPDATE",
              [offerId],
            )
          ).rows[0],
        );
        if (offer.version !== b.version)
          throw new ApiError("version_conflict", 409, { current: offer });
        if (
          offer.status !== "pending" ||
          Date.parse(offer.expires_at) <= Date.now()
        )
          throw new ApiError("offer_unavailable", 409);
        let orderId = null;
        if (b.status === "accepted") {
          const order = await reserveOrder(c, {
            id: randomUUID(),
            listingId: offer.listing_id,
            buyerId: offer.buyer_id,
            quantity: Number(offer.quantity),
            amount: Number(offer.amount),
            currency: offer.currency,
            offerId,
            payloadHash: sha256(
              JSON.stringify({ offerId, version: offer.version }),
            ),
          });
          orderId = order.id;
        }
        const next = (
          await c.query(
            "UPDATE market_offers SET status=$2,order_id=$3,version=version+1 WHERE id=$1 RETURNING *",
            [offerId, b.status, orderId],
          )
        ).rows[0];
        return { ...next, orderId };
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  const requestInput = z
    .object({
      id: uuid,
      title: z.string().trim().min(1).max(150),
      category,
      quantity: positive,
      unit: z.string().trim().min(1).max(40),
      area: z.string().trim().min(1).max(150),
      details: text,
      expiresAt: when,
    })
    .strict();
  app.get("/v1/market/requests", async (req) => {
    const q = listQuery
      .extend({ q: z.string().max(100).default("") })
      .parse(req.query);
    return page(
      (
        await ctx.db.query(
          "SELECT id,title,category,quantity,unit,area,details,expires_at,status,version,created_at FROM buying_requests WHERE status='open' AND expires_at>clock_timestamp() AND title ILIKE '%'||$1||'%' AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3",
          [q.q, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/market/requests", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const b = requestInput.parse(req.body);
    if (Date.parse(b.expiresAt) <= Date.now())
      throw new ApiError("expiry_must_be_future");
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "buying_request", ...b },
      async (c) =>
        (
          await c.query(
            "INSERT INTO buying_requests(id,buyer_id,title,category,quantity,unit,area,details,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              b.id,
              actor,
              b.title,
              b.category,
              b.quantity,
              b.unit,
              b.area,
              b.details,
              b.expiresAt,
            ],
          )
        ).rows[0],
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.get("/v1/market/my-requests", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const q = listQuery.parse(req.query);
    return page(
      (
        await ctx.db.query(
          "SELECT * FROM buying_requests WHERE buyer_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3",
          [actor, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.patch("/v1/market/requests/:requestId", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { requestId } = z.object({ requestId: uuid }).parse(req.params);
    const b = requestInput
      .omit({ id: true })
      .partial()
      .extend({
        version: z.number().int().positive(),
        reason: text,
        status: z.enum(["open", "closed"]).optional(),
      })
      .strict()
      .parse(req.body);
    return ctx.transaction(async (c) => {
      const old = row(
        (
          await c.query(
            "SELECT * FROM buying_requests WHERE id=$1 AND buyer_id=$2 FOR UPDATE",
            [requestId, actor],
          )
        ).rows[0],
      );
      if (old.version !== b.version)
        throw new ApiError("version_conflict", 409, { current: old });
      if (b.expiresAt && Date.parse(b.expiresAt) <= Date.now())
        throw new ApiError("expiry_must_be_future");
      const next = (
        await c.query(
          "UPDATE buying_requests SET title=$2,category=$3,quantity=$4,unit=$5,area=$6,details=$7,expires_at=$8,status=$9,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [
            requestId,
            b.title ?? old.title,
            b.category ?? old.category,
            b.quantity ?? old.quantity,
            b.unit ?? old.unit,
            b.area ?? old.area,
            b.details ?? old.details,
            b.expiresAt ?? old.expires_at,
            b.status ?? old.status,
          ],
        )
      ).rows[0];
      await audit(
        c,
        null,
        actor,
        "buying_request",
        requestId,
        "updated",
        b.reason,
        old,
        next,
      );
      return next;
    });
  });
  app.get("/v1/market/requests/:requestId/responses", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { requestId } = z.object({ requestId: uuid }).parse(req.params),
      q = listQuery.parse(req.query);
    const owner = row(
      (
        await ctx.db.query("SELECT buyer_id FROM buying_requests WHERE id=$1", [
          requestId,
        ])
      ).rows[0],
    ).buyer_id;
    return page(
      (
        await ctx.db.query(
          "SELECT * FROM buying_responses WHERE request_id=$1 AND ($2::boolean OR actor_id=$3) AND ($4::uuid IS NULL OR id<$4) ORDER BY id DESC LIMIT $5",
          [requestId, owner === actor, actor, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/market/requests/:requestId/responses", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const { requestId } = z.object({ requestId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        message: text,
        listingId: uuid.nullable().default(null),
      })
      .strict()
      .parse(req.body);
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "buying_response", requestId, ...b },
      async (c) => {
        row(
          (
            await c.query(
              "SELECT id FROM buying_requests WHERE id=$1 AND status='open' AND expires_at>clock_timestamp()",
              [requestId],
            )
          ).rows[0],
        );
        if (b.listingId) {
          const l = row(
            (
              await c.query(
                "SELECT farm_id FROM market_listings WHERE id=$1 AND status='active'",
                [b.listingId],
              )
            ).rows[0],
          );
          if (!(await isSeller(ctx, l.farm_id, actor)))
            throw new ApiError("not_found", 404);
        }
        return (
          await c.query(
            "INSERT INTO buying_responses(id,request_id,actor_id,message,listing_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [b.id, requestId, actor, b.message, b.listingId],
          )
        ).rows[0];
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.post("/v1/market/reports", async (req, reply) => {
    const actor = await ctx.user(req, reply);
    if (!actor) return;
    const b = z
      .object({
        id: uuid,
        listingId: uuid.nullable().default(null),
        requestId: uuid.nullable().default(null),
        reason: text,
      })
      .strict()
      .refine(
        (v) => !!v.listingId !== !!v.requestId,
        "one_report_target_required",
      )
      .parse(req.body);
    const out = await idempotent(
      ctx,
      null,
      actor,
      b.id,
      { operation: "market_report", ...b },
      async (c) => {
        row(
          (
            await c.query(
              b.listingId
                ? "SELECT id FROM market_listings WHERE id=$1"
                : "SELECT id FROM buying_requests WHERE id=$1",
              [b.listingId ?? b.requestId],
            )
          ).rows[0],
        );
        return (
          await c.query(
            "INSERT INTO market_reports(id,listing_id,request_id,reporter_id,reason) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [b.id, b.listingId, b.requestId, actor, b.reason],
          )
        ).rows[0];
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  for (const global of [false, true]) {
    const base = global
      ? "/v1/market/moderation"
      : "/v1/farms/:farmId/moderation";
    app.get(base, async (req, reply) => {
      const actor = await ctx.user(req, reply);
      if (!actor) return;
      let farmId: string | null = null;
      if (global) {
        if (!globalModerator(actor)) throw new ApiError("not_found", 404);
      } else {
        farmId = z.object({ farmId: uuid }).parse(req.params).farmId;
        if (!(await isSeller(ctx, farmId, actor)))
          throw new ApiError("not_found", 404);
      }
      const q = listQuery.parse(req.query);
      return page(
        (
          await ctx.db.query(
            "SELECT r.id,r.listing_id,r.request_id,r.reason,r.status,r.note,r.created_at,r.resolved_at FROM market_reports r LEFT JOIN market_listings l ON l.id=r.listing_id WHERE ($1::uuid IS NULL OR l.farm_id=$1) AND ($2::uuid IS NULL OR r.id<$2) ORDER BY r.id DESC LIMIT $3",
            [farmId, q.cursor ?? null, q.limit + 1],
          )
        ).rows,
        q.limit,
      );
    });
    app.post(`${base}/:reportId/resolve`, async (req, reply) => {
      const actor = await ctx.user(req, reply);
      if (!actor) return;
      const { reportId } = z.object({ reportId: uuid }).parse(req.params);
      const b = z
        .object({
          id: uuid,
          action: z.enum(["archive", "dismiss"]),
          note: text,
        })
        .strict()
        .parse(req.body);
      let farmId: string | null = null;
      if (global) {
        if (!globalModerator(actor)) throw new ApiError("not_found", 404);
      } else {
        farmId = z.object({ farmId: uuid }).parse(req.params).farmId;
        if (!(await isSeller(ctx, farmId, actor)))
          throw new ApiError("not_found", 404);
      }
      const out = await idempotent(
        ctx,
        farmId,
        actor,
        b.id,
        { operation: "moderation", reportId, ...b },
        async (c) => {
          const r = row(
            (
              await c.query(
                "SELECT r.*,l.farm_id FROM market_reports r LEFT JOIN market_listings l ON l.id=r.listing_id WHERE r.id=$1 FOR UPDATE OF r",
                [reportId],
              )
            ).rows[0],
          );
          if (farmId && r.farm_id !== farmId)
            throw new ApiError("not_found", 404);
          if (r.status !== "open")
            throw new ApiError("report_already_resolved", 409);
          if (b.action === "archive") {
            if (r.listing_id)
              await c.query(
                "UPDATE market_listings SET status='archived',version=version+1 WHERE id=$1",
                [r.listing_id],
              );
            else
              await c.query(
                "UPDATE buying_requests SET status='closed',version=version+1 WHERE id=$1",
                [r.request_id],
              );
          }
          const next = (
            await c.query(
              "UPDATE market_reports SET status=$2,resolved_by=$3,note=$4,resolved_at=now() WHERE id=$1 RETURNING id,status,note,resolved_at",
              [
                reportId,
                b.action === "archive" ? "archived" : "dismissed",
                actor,
                b.note,
              ],
            )
          ).rows[0];
          await audit(
            c,
            r.farm_id ?? null,
            actor,
            "market_report",
            reportId,
            b.action,
            b.note,
          );
          return next;
        },
      );
      return reply.code(out.replayed ? 200 : 201).send(out.body);
    });
  }
  app.get("/v1/market/listings/:listingId/reviews", async (req) => {
    const { listingId } = z.object({ listingId: uuid }).parse(req.params),
      q = listQuery.parse(req.query);
    return page(
      (
        await ctx.db.query(
          "SELECT r.id,r.rating,r.note,r.created_at FROM interaction_reviews r JOIN market_orders o ON o.id=r.order_id WHERE o.listing_id=$1 AND o.status='fulfilled' AND ($2::uuid IS NULL OR r.id<$2) ORDER BY r.id DESC LIMIT $3",
          [listingId, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
}
