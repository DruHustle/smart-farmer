import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, audit, manageRoles, type Context } from "../context.js";
import {
  uuid,
  when,
  units,
  quantity,
  currency,
  convertQuantity,
  stockMovement,
  assertReleaseAllowed,
} from "../core.js";
import { auth, idempotent, row, text, listQuery, page } from "./common.js";
export function registerInventory(app: FastifyInstance, ctx: Context) {
  app.patch("/v1/farms/:farmId/stock/:itemId", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const { itemId } = z.object({ itemId: uuid }).parse(req.params);
    const b = z
      .object({
        version: z.number().int().positive(),
        reason: text,
        name: z.string().trim().min(1).max(100).optional(),
        grade: z.string().max(100).optional(),
        locationId: uuid.nullable().optional(),
        packSize: quantity
          .refine((v) => v > 0)
          .nullable()
          .optional(),
        packUnit: units.nullable().optional(),
      })
      .strict()
      .parse(req.body);
    return ctx.transaction(async (c) => {
      const old = row(
        (
          await c.query(
            "SELECT * FROM stock_items WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE",
            [a.farmId, itemId],
          )
        ).rows[0],
      );
      if (old.version !== b.version)
        throw new ApiError("version_conflict", 409, { current: old });
      const size = b.packSize === undefined ? old.pack_size : b.packSize,
        unit = b.packUnit === undefined ? old.pack_unit : b.packUnit;
      if ((size === null) !== (unit === null))
        throw new ApiError("pack_pair_required");
      if (size !== null) {
        const n = convertQuantity(Number(size), unit, old.unit);
        if (!["g", "kg", "ml", "l"].includes(old.unit) && !Number.isInteger(n))
          throw new ApiError("whole_count_required");
      }
      const next = (
        await c.query(
          "UPDATE stock_items SET name=$3,grade=$4,location_id=$5,pack_size=$6,pack_unit=$7,version=version+1 WHERE farm_id=$1 AND id=$2 RETURNING *",
          [
            a.farmId,
            itemId,
            b.name ?? old.name,
            b.grade ?? old.grade,
            b.locationId === undefined ? old.location_id : b.locationId,
            size,
            unit,
          ],
        )
      ).rows[0];
      await audit(
        c,
        a.farmId,
        a.actor,
        "stock_item",
        itemId,
        "updated",
        b.reason,
        old,
        next,
      );
      return next;
    });
  });
  app.get("/v1/farms/:farmId/stock/:itemId/valuations", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const { itemId } = z.object({ itemId: uuid }).parse(req.params),
      q = listQuery.parse(req.query);
    return page(
      (
        await ctx.db.query(
          "SELECT * FROM stock_valuations WHERE farm_id=$1 AND stock_item_id=$2 AND ($3::uuid IS NULL OR id<$3) ORDER BY id DESC LIMIT $4",
          [a.farmId, itemId, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/farms/:farmId/stock/:itemId/valuations", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const { itemId } = z.object({ itemId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        version: z.number().int().positive(),
        unitCost: quantity.nullable(),
        currency: currency.nullable(),
        source: text,
        reason: text,
      })
      .strict()
      .refine(
        (b) => (b.unitCost === null) === (b.currency === null),
        "amount_currency_pair_required",
      )
      .parse(req.body);
    const out = await idempotent(
      ctx,
      a.farmId,
      a.actor,
      b.id,
      { operation: "stock_valuation", itemId, ...b },
      async (c) => {
        const item = row(
          (
            await c.query(
              "SELECT * FROM stock_items WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE",
              [a.farmId, itemId],
            )
          ).rows[0],
        );
        if (item.version !== b.version)
          throw new ApiError("version_conflict", 409, { current: item });
        const valuation = (
          await c.query(
            "INSERT INTO stock_valuations(id,farm_id,stock_item_id,unit_cost,currency,source,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              b.id,
              a.farmId,
              itemId,
              b.unitCost,
              b.currency,
              b.source,
              b.reason,
              a.actor,
            ],
          )
        ).rows[0];
        await c.query(
          "UPDATE stock_items SET unit_cost=$3,currency=$4,version=version+1 WHERE farm_id=$1 AND id=$2",
          [a.farmId, itemId, b.unitCost, b.currency],
        );
        await audit(
          c,
          a.farmId,
          a.actor,
          "stock_item",
          itemId,
          "documented_valuation",
          b.reason,
          item,
          valuation,
        );
        return {
          ...valuation,
          basis: "documented_unit_cost",
          historicalCostsChanged: false,
        };
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
  app.get("/v1/farms/:farmId/stock/:itemId/transfers", async (req, reply) => {
    const a = await auth(ctx, req, reply);
    if (!a) return;
    const { itemId } = z.object({ itemId: uuid }).parse(req.params),
      q = listQuery.parse(req.query);
    return page(
      (
        await ctx.db.query(
          "SELECT * FROM stock_transfers WHERE farm_id=$1 AND (source_item_id=$2 OR destination_item_id=$2) AND ($3::uuid IS NULL OR id<$3) ORDER BY id DESC LIMIT $4",
          [a.farmId, itemId, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/farms/:farmId/stock/:itemId/transfers", async (req, reply) => {
    const a = await auth(ctx, req, reply, manageRoles);
    if (!a) return;
    const { itemId } = z.object({ itemId: uuid }).parse(req.params);
    const b = z
      .object({
        id: uuid,
        destinationStockItemId: uuid,
        quantity: quantity.refine((v) => v > 0),
        unit: units,
        observedAt: when,
        reason: text,
      })
      .strict()
      .parse(req.body);
    if (itemId === b.destinationStockItemId)
      throw new ApiError("same_stock_transfer");
    const out = await idempotent(
      ctx,
      a.farmId,
      a.actor,
      b.id,
      { operation: "stock_transfer", itemId, ...b },
      async (c) => {
        const snapshots = (
          await c.query(
            "SELECT id,project_id FROM stock_items WHERE farm_id=$1 AND id=ANY($2::uuid[])",
            [a.farmId, [itemId, b.destinationStockItemId]],
          )
        ).rows;
        if (snapshots.length !== 2) throw new ApiError("stock_not_found", 404);
        const projects = [
          ...new Set(snapshots.map((s) => s.project_id).filter(Boolean)),
        ].sort();
        if (projects.length)
          await c.query(
            "SELECT id FROM projects WHERE farm_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE",
            [a.farmId, projects],
          );
        const stocks = (
          await c.query(
            "SELECT * FROM stock_items WHERE farm_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE",
            [a.farmId, [itemId, b.destinationStockItemId]],
          )
        ).rows;
        const source = row(stocks.find((s) => s.id === itemId)),
          dest = row(stocks.find((s) => s.id === b.destinationStockItemId));
        if (source.project_id && !dest.project_id)
          throw new ApiError("traceable_destination_project_required");
        await assertReleaseAllowed(c, a.farmId, source.project_id, "transfer");
        const sourceQuantity = convertQuantity(b.quantity, b.unit, source.unit),
          destinationQuantity = convertQuantity(b.quantity, b.unit, dest.unit);
        if (sourceQuantity > 1e9 || destinationQuantity > 1e9)
          throw new ApiError("quantity_limit");
        await stockMovement(c, {
          farmId: a.farmId,
          itemId,
          projectId: source.project_id,
          actorId: a.actor,
          kind: "transfer_out",
          quantity: -sourceQuantity,
          unit: source.unit,
          sourceType: "stock_transfer",
          sourceId: b.id,
          observedAt: b.observedAt,
          note: b.reason,
        });
        await stockMovement(c, {
          farmId: a.farmId,
          itemId: dest.id,
          projectId: dest.project_id,
          actorId: a.actor,
          kind: "transfer_in",
          quantity: destinationQuantity,
          unit: dest.unit,
          sourceType: "stock_transfer",
          sourceId: b.id,
          observedAt: b.observedAt,
          note: b.reason,
        });
        const known =
          source.unit_cost !== null &&
          (Number(dest.quantity) === 0 ||
            (dest.unit_cost !== null && dest.currency === source.currency));
        const cost = known
          ? (Number(dest.quantity) * Number(dest.unit_cost ?? 0) +
              sourceQuantity * Number(source.unit_cost)) /
            (Number(dest.quantity) + destinationQuantity)
          : null;
        await c.query(
          "UPDATE stock_items SET unit_cost=$2,currency=$3 WHERE id=$1",
          [
            dest.id,
            cost === null ? null : Math.round(cost * 1e6) / 1e6,
            cost === null ? null : source.currency,
          ],
        );
        if (
          source.project_id &&
          dest.project_id &&
          source.project_id !== dest.project_id
        )
          await c.query(
            `INSERT INTO treatment_restrictions(id,farm_id,project_id,source_project_id,starts_at,ends_at,scope,reason,authorized_by,created_by,origin_restriction_id) SELECT gen_random_uuid(),r.farm_id,$3,$2,r.starts_at,r.ends_at,r.scope,r.reason,r.authorized_by,$4,COALESCE(r.origin_restriction_id,r.id) FROM treatment_restrictions r WHERE r.farm_id=$1 AND r.project_id=$2 AND r.ends_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM treatment_restrictions x WHERE x.farm_id=$1 AND x.project_id=$3 AND x.origin_restriction_id=COALESCE(r.origin_restriction_id,r.id))`,
            [a.farmId, source.project_id, dest.project_id, a.actor],
          );
        const result = (
          await c.query(
            "INSERT INTO stock_transfers(id,farm_id,source_item_id,destination_item_id,source_quantity,source_unit,destination_quantity,destination_unit,observed_at,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
            [
              b.id,
              a.farmId,
              itemId,
              dest.id,
              sourceQuantity,
              source.unit,
              destinationQuantity,
              dest.unit,
              b.observedAt,
              b.reason,
              a.actor,
            ],
          )
        ).rows[0];
        await audit(
          c,
          a.farmId,
          a.actor,
          "stock_transfer",
          b.id,
          "recorded",
          b.reason,
          null,
          result,
        );
        return result;
      },
    );
    return reply.code(out.replayed ? 200 : 201).send(out.body);
  });
}
