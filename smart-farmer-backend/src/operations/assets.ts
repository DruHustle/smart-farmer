import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, audit, type Context } from "../context.js";
import { verifyPassword } from "../security.js";
import { finance, currency, money } from "../core.js";
import {
  authenticateGateway,
  lockGateway,
} from "../integrations/gateway-auth.js";
import {
  authorize,
  managers,
  recorders,
  uuid,
  instant,
  hash,
  operationLock,
  requireRow,
  listQuery,
  paged,
  checkVersion,
  memberExists,
  validateInstant,
} from "./common.js";
const assetParams = z.object({ assetId: uuid });
const version = z.number().int().positive(),
  note = z.string().max(2000),
  short = z.string().trim().min(1).max(150),
  reason = z.string().trim().min(1).max(500);
async function invalidate(c: any, assetId: string) {
  const rows = await c.query(
    "UPDATE equipment_commands SET status=CASE WHEN status='authorized' THEN 'rejected' ELSE 'outcome_unknown' END,reason='configuration_changed',completed_at=clock_timestamp() WHERE asset_id=$1 AND status IN ('authorized','dispatched','acknowledged') RETURNING id,status",
    [assetId],
  );
  for (const r of rows.rows)
    await c.query(
      "INSERT INTO command_audit(command_id,status,detail) VALUES($1,$2,$3)",
      [r.id, r.status, "configuration_changed"],
    );
}
export function registerAssetOperations(app: FastifyInstance, ctx: Context) {
  app.patch("/v1/farms/:farmId/assets/:assetId", async (req, reply) => {
    const a = await authorize(ctx, req, reply, managers);
    if (!a) return;
    const { assetId } = assetParams.parse(req.params);
    const b = z
      .object({
        version,
        name: short.optional(),
        make: short.nullable().optional(),
        model: short.nullable().optional(),
        controller: short.nullable().optional(),
        firmware: short.nullable().optional(),
        locationId: uuid.nullable().optional(),
        responsibleId: uuid.nullable().optional(),
        notes: note.optional(),
        staleAfterSeconds: z.number().int().min(10).max(3600).optional(),
        reason,
      })
      .strict()
      .parse(req.body);
    return ctx.transaction(async (c) => {
      const old = requireRow(
        (
          await c.query(
            "SELECT * FROM assets WHERE id=$1 AND farm_id=$2 FOR UPDATE",
            [assetId, a.farmId],
          )
        ).rows[0],
      );
      checkVersion(old, b.version);
      await memberExists(c, a.farmId, b.responsibleId);
      const changed = ["make", "model", "controller", "firmware"].some(
        (k) => (b as any)[k] !== undefined && (b as any)[k] !== old[k],
      );
      if (changed) await invalidate(c, assetId);
      const next = (
        await c.query(
          "UPDATE assets SET name=$2,make=$3,model=$4,controller=$5,firmware=$6,location_id=$7,responsible_id=$8,notes=$9,stale_after_seconds=$10,version=version+1,integration_state=CASE WHEN $11 AND protocol<>'simulator' THEN 'unconfigured' ELSE integration_state END,gateway_token_hash=CASE WHEN $11 THEN NULL ELSE gateway_token_hash END,configuration_hash=CASE WHEN $11 THEN NULL ELSE configuration_hash END,last_real_feedback_at=CASE WHEN $11 THEN NULL ELSE last_real_feedback_at END WHERE id=$1 RETURNING *",
          [
            assetId,
            b.name ?? old.name,
            b.make === undefined ? old.make : b.make,
            b.model === undefined ? old.model : b.model,
            b.controller === undefined ? old.controller : b.controller,
            b.firmware === undefined ? old.firmware : b.firmware,
            b.locationId === undefined ? old.location_id : b.locationId,
            b.responsibleId === undefined
              ? old.responsible_id
              : b.responsibleId,
            b.notes ?? old.notes,
            b.staleAfterSeconds ?? old.stale_after_seconds,
            changed,
          ],
        )
      ).rows[0];
      const { gateway_token_hash: _, ...safe } = next;
      await audit(
        c,
        a.farmId,
        a.userId,
        "asset",
        assetId,
        "updated",
        b.reason,
        { name: old.name, version: old.version },
        safe,
      );
      return safe;
    });
  });
  app.post(
    "/v1/farms/:farmId/assets/:assetId/integration",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply, ["owner"]);
      if (!a) return;
      const { assetId } = assetParams.parse(req.params);
      const mapping = z
        .object({
          name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
          unit: z.string().min(1).max(30),
          address: z.string().min(1).max(200),
          scale: z
            .number()
            .finite()
            .refine((x) => x !== 0)
            .optional(),
          offset: z.number().finite().optional(),
        })
        .strict();
      const b = z
        .object({
          version,
          protocol: z.enum(["simulator", "mqtt", "http", "modbus"]),
          connectionRef: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          telemetry: z.array(mapping).min(1).max(50),
          commands: z
            .array(
              z
                .object({
                  name: z.enum(["start", "stop"]),
                  address: z.string().min(1).max(200),
                  value: z.union([
                    z.boolean(),
                    z.number().int().min(0).max(65535),
                  ]),
                })
                .strict(),
            )
            .max(2),
          reason,
        })
        .strict()
        .parse(req.body);
      if (
        new Set(b.telemetry.map((x) => x.name)).size !== b.telemetry.length ||
        new Set(b.commands.map((x) => x.name)).size !== b.commands.length
      )
        throw new ApiError("duplicate_mapping");
      if (
        b.protocol === "modbus" &&
        [...b.telemetry, ...b.commands].some(
          (m) => !/^(coil|discrete|holding|input):[0-9]{1,5}$/.test(m.address),
        )
      )
        throw new ApiError("invalid_mapping");
      if (
        b.protocol === "http" &&
        b.commands.some((m) => !/^\/[a-zA-Z0-9_/-]+$/.test(m.address))
      )
        throw new ApiError("invalid_mapping");
      if (
        b.commands.length &&
        (!b.telemetry.some((x) => x.name === "running") ||
          !b.telemetry.some((x) => x.name === "interlock_ok"))
      )
        throw new ApiError("feedback_mapping_required");
      return ctx.transaction(async (c) => {
        const old = requireRow(
          (
            await c.query(
              "SELECT * FROM assets WHERE id=$1 AND farm_id=$2 FOR UPDATE",
              [assetId, a.farmId],
            )
          ).rows[0],
        );
        checkVersion(old, b.version);
        if (
          b.commands.length &&
          !["pump", "pivot", "valve"].includes(old.category)
        )
          throw new ApiError("unsupported_command");
        const config = {
          connectionRef: b.connectionRef,
          telemetry: b.telemetry,
          commands: b.commands,
        };
        const fingerprint = hash({
          configuration: config,
          model: old.model,
          make: old.make,
          controller: old.controller,
          firmware: old.firmware,
          protocol: b.protocol,
        });
        await invalidate(c, assetId);
        await c.query(
          "UPDATE assets SET protocol=$2,configuration=$3,configuration_hash=$4,capabilities=$5,integration_state=$6,version=version+1,gateway_token_hash=NULL,gateway_expires_at=NULL,last_real_feedback_at=NULL,last_observed_at=NULL,latest_telemetry='{}' WHERE id=$1",
          [
            assetId,
            b.protocol,
            config,
            fingerprint,
            {
              telemetry: b.telemetry.map((x) => x.name),
              commands: b.commands.map((x) => x.name),
            },
            b.protocol === "simulator"
              ? "simulated"
              : "connected-awaiting-verification",
          ],
        );
        await audit(
          c,
          a.farmId,
          a.userId,
          "asset",
          assetId,
          "integration_changed",
          b.reason,
          old.configuration,
          config,
        );
        return {
          id: assetId,
          version: b.version + 1,
          integration_state:
            b.protocol === "simulator"
              ? "simulated"
              : "connected-awaiting-verification",
          configuration_hash: fingerprint,
        };
      });
    },
  );
  app.post(
    "/v1/farms/:farmId/assets/:assetId/commissioning",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply, ["owner"]);
      if (!a) return;
      const { assetId } = assetParams.parse(req.params);
      const b = z
        .object({
          id: uuid,
          version,
          mode: z.enum(["read_only", "control"]),
          checks: z
            .object({
              identityVerified: z.boolean(),
              mappingVerified: z.boolean(),
              localInterlocksVerified: z.boolean(),
              manualOverrideVerified: z.boolean(),
              networkLossVerified: z.boolean(),
              feedbackVerified: z.boolean(),
            })
            .strict(),
          evidence: z.string().trim().min(20).max(5000),
          confirmed: z.literal(true),
          password: z.string().min(1).max(1024),
        })
        .strict()
        .parse(req.body);
      const user = (
        await ctx.db.query("SELECT password_hash FROM users WHERE id=$1", [
          a.userId,
        ])
      ).rows[0];
      if (!(await verifyPassword(b.password, user.password_hash)))
        throw new ApiError("reauthentication_required", 403);
      const fingerprint = hash({ ...b, password: undefined });
      return ctx.transaction(async (c) => {
        await operationLock(c, "commission:" + b.id);
        const prior = (
          await c.query("SELECT * FROM asset_commissioning WHERE id=$1", [b.id])
        ).rows[0];
        if (prior) {
          if (
            prior.farm_id !== a.farmId ||
            prior.asset_id !== assetId ||
            prior.actor_id !== a.userId ||
            prior.payload_hash !== fingerprint
          )
            throw new ApiError("idempotency_conflict", 409);
          return { id: b.id, replayed: true };
        }
        const old = requireRow(
          (
            await c.query(
              "SELECT * FROM assets WHERE id=$1 AND farm_id=$2 FOR UPDATE",
              [assetId, a.farmId],
            )
          ).rows[0],
        );
        checkVersion(old, b.version);
        if (
          old.protocol === "simulator" ||
          !old.model ||
          !old.configuration_hash ||
          !old.last_real_feedback_at ||
          new Date(old.last_real_feedback_at).getTime() > Date.now() + 5000 ||
          Date.now() - new Date(old.last_real_feedback_at).getTime() >
            old.stale_after_seconds * 1000
        )
          throw new ApiError("fresh_hardware_feedback_required", 409);
        if (
          !b.checks.identityVerified ||
          !b.checks.mappingVerified ||
          !b.checks.feedbackVerified ||
          (b.mode === "control" && Object.values(b.checks).some((x) => !x)) ||
          (b.mode === "control" && !old.capabilities.commands.length)
        )
          throw new ApiError("commissioning_incomplete", 409);
        await c.query(
          "INSERT INTO asset_commissioning(id,farm_id,asset_id,actor_id,mode,checks,evidence,configuration_hash,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            b.id,
            a.farmId,
            assetId,
            a.userId,
            b.mode,
            b.checks,
            b.evidence,
            old.configuration_hash,
            fingerprint,
          ],
        );
        const state =
          b.mode === "control"
            ? "verified-control-enabled"
            : "verified-read-only";
        await c.query(
          "UPDATE assets SET integration_state=$2,version=version+1 WHERE id=$1",
          [assetId, state],
        );
        await audit(
          c,
          a.farmId,
          a.userId,
          "asset",
          assetId,
          "commissioned",
          b.evidence,
          null,
          {
            checks: b.checks,
            mode: b.mode,
            configurationHash: old.configuration_hash,
          },
        );
        return { id: b.id, integration_state: state, version: b.version + 1 };
      });
    },
  );
  app.get("/v1/farms/:farmId/assets/:assetId/telemetry", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const { assetId } = assetParams.parse(req.params),
      q = listQuery.parse(req.query);
    return paged(
      (
        await ctx.db.query(
          "SELECT * FROM asset_observations WHERE farm_id=$1 AND asset_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4",
          [a.farmId, assetId, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/edge/observations", async (req) => {
    const auth = await authenticateGateway(ctx.db, req);
    const b = z
      .object({
        id: uuid,
        measurement: z.string().max(50),
        value: z.union([z.number().finite(), z.boolean(), z.string().max(500)]),
        unit: z.string().max(30),
        observedAt: instant,
        quality: z.enum(["good", "uncertain", "bad"]),
        configurationHash: z.string().nullable(),
      })
      .strict()
      .parse(req.body);
    validateInstant(b.observedAt);
    return ctx.transaction(async (c) => {
      const asset = await lockGateway(c, auth);
      if (b.configurationHash !== asset.configuration_hash)
        throw new ApiError("configuration_changed", 409);
      const definition = asset.configuration.telemetry?.find(
        (m: any) => m.name === b.measurement && m.unit === b.unit,
      );
      if (!definition) throw new ApiError("unknown_measurement");
      await operationLock(c, "observation:" + b.id);
      const old = (
        await c.query("SELECT * FROM asset_observations WHERE id=$1", [b.id])
      ).rows[0];
      if (old) {
        if (old.asset_id !== asset.id || old.payload_hash !== hash(b))
          throw new ApiError("idempotency_conflict", 409);
        return { id: b.id, replayed: true };
      }
      await c.query(
        "INSERT INTO asset_observations(id,farm_id,asset_id,measurement,value,unit,observed_at,source,quality,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          b.id,
          asset.farm_id,
          asset.id,
          b.measurement,
          JSON.stringify(b.value),
          b.unit,
          b.observedAt,
          asset.protocol === "simulator" ? "simulator" : "gateway",
          b.quality,
          hash(b),
        ],
      );
      if (
        b.quality === "good" &&
        asset.protocol !== "simulator" &&
        Date.parse(b.observedAt) <= Date.now() + 5000
      )
        await c.query(
          "UPDATE assets SET last_real_feedback_at=GREATEST(last_real_feedback_at,$2) WHERE id=$1",
          [asset.id, b.observedAt],
        );
      return { id: b.id, status: "recorded" };
    });
  });
  app.get("/v1/farms/:farmId/assets/:assetId/usage", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const { assetId } = assetParams.parse(req.params),
      q = listQuery.parse(req.query);
    return paged(
      (
        await ctx.db.query(
          "SELECT * FROM asset_usage WHERE farm_id=$1 AND asset_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4",
          [a.farmId, assetId, q.cursor ?? null, q.limit + 1],
        )
      ).rows,
      q.limit,
    );
  });
  app.post("/v1/farms/:farmId/assets/:assetId/usage", async (req, reply) => {
    const a = await authorize(ctx, req, reply, recorders);
    if (!a) return;
    const { assetId } = assetParams.parse(req.params);
    const b = z
      .object({
        id: uuid,
        kind: z.enum([
          "runtime",
          "fuel",
          "energy",
          "water",
          "pressure",
          "position",
          "fault",
        ]),
        quantity: z.number().finite().nonnegative().max(1e12),
        unit: z.string().min(1).max(30),
        observedAt: instant,
        projectId: uuid.nullable().default(null),
        note: note.default(""),
      })
      .strict()
      .parse(req.body);
    validateInstant(b.observedAt);
    return ctx.transaction(async (c) => {
      await operationLock(c, "usage:" + b.id);
      const old = (
        await c.query("SELECT * FROM asset_usage WHERE id=$1", [b.id])
      ).rows[0];
      if (old) {
        if (
          old.farm_id !== a.farmId ||
          old.asset_id !== assetId ||
          old.actor_id !== a.userId ||
          old.payload_hash !== hash(b)
        )
          throw new ApiError("idempotency_conflict", 409);
        return old;
      }
      const r = await c.query(
        "INSERT INTO asset_usage(id,farm_id,asset_id,project_id,actor_id,kind,quantity,unit,observed_at,note,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          b.id,
          a.farmId,
          assetId,
          b.projectId,
          a.userId,
          b.kind,
          b.quantity,
          b.unit,
          b.observedAt,
          b.note,
          hash(b),
        ],
      );
      reply.code(201);
      return r.rows[0];
    });
  });
  app.get(
    "/v1/farms/:farmId/assets/:assetId/maintenance",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const { assetId } = assetParams.parse(req.params),
        q = listQuery.parse(req.query);
      const rows = (
        await ctx.db.query(
          "SELECT * FROM asset_maintenance WHERE farm_id=$1 AND asset_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4",
          [a.farmId, assetId, q.cursor ?? null, q.limit + 1],
        )
      ).rows;
      const financial = await ctx.member(a.farmId, a.userId, managers);
      return paged(
        rows.map((row) => {
          if (!financial) {
            delete row.amount;
            delete row.currency;
          }
          return row;
        }),
        q.limit,
      );
    },
  );
  app.post(
    "/v1/farms/:farmId/assets/:assetId/maintenance",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply, managers);
      if (!a) return;
      const { assetId } = assetParams.parse(req.params);
      const b = z
        .object({
          id: uuid,
          title: short,
          dueAt: instant,
          intervalDays: z
            .number()
            .int()
            .min(1)
            .max(3650)
            .nullable()
            .default(null),
          instructions: note.default(""),
          assigneeId: uuid.nullable().default(null),
          projectId: uuid.nullable().default(null),
        })
        .strict()
        .parse(req.body);
      return ctx.transaction(async (c) => {
        await operationLock(c, "maintenance:" + b.id);
        const old = (
          await c.query("SELECT * FROM asset_maintenance WHERE id=$1", [b.id])
        ).rows[0];
        if (old) {
          if (
            old.farm_id !== a.farmId ||
            old.asset_id !== assetId ||
            old.actor_id !== a.userId ||
            old.payload_hash !== hash(b)
          )
            throw new ApiError("idempotency_conflict", 409);
          return old;
        }
        await memberExists(c, a.farmId, b.assigneeId);
        const r = await c.query(
          "INSERT INTO asset_maintenance(id,farm_id,asset_id,project_id,actor_id,title,due_at,interval_days,instructions,assignee_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            b.id,
            a.farmId,
            assetId,
            b.projectId,
            a.userId,
            b.title,
            b.dueAt,
            b.intervalDays,
            b.instructions,
            b.assigneeId,
            hash(b),
          ],
        );
        reply.code(201);
        return r.rows[0];
      });
    },
  );
  app.patch(
    "/v1/farms/:farmId/maintenance/:maintenanceId",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply, managers);
      if (!a) return;
      const { maintenanceId } = z
        .object({ maintenanceId: uuid })
        .parse(req.params);
      const b = z
        .object({
          version,
          status: z.enum(["completed", "cancelled"]),
          performedAt: instant.optional(),
          hours: z.number().finite().nonnegative().optional(),
          amount: money.optional(),
          currency: currency.optional(),
          note: note.default(""),
        })
        .strict()
        .parse(req.body);
      if (
        (b.amount === undefined) !== (b.currency === undefined) ||
        (b.status === "completed" && !b.performedAt) ||
        (b.status === "cancelled" && (b.amount !== undefined || b.performedAt))
      )
        throw new ApiError("invalid_maintenance");
      if (b.performedAt) validateInstant(b.performedAt);
      return ctx.transaction(async (c) => {
        const old = requireRow(
          (
            await c.query(
              "SELECT * FROM asset_maintenance WHERE id=$1 AND farm_id=$2 FOR UPDATE",
              [maintenanceId, a.farmId],
            )
          ).rows[0],
        );
        if (
          old.status === b.status &&
          old.version === b.version + 1 &&
          old.note === b.note &&
          Number(old.amount ?? 0) === Number(b.amount ?? 0) &&
          old.currency === (b.currency ?? null) &&
          Number(old.hours ?? 0) === Number(b.hours ?? 0) &&
          (!b.performedAt ||
            new Date(old.performed_at).getTime() === Date.parse(b.performedAt))
        )
          return old;
        checkVersion(old, b.version);
        if (old.status !== "planned")
          throw new ApiError("maintenance_terminal", 409);
        const nextId =
          b.status === "completed" && old.interval_days ? randomUUID() : null;
        const r = (
          await c.query(
            "UPDATE asset_maintenance SET status=$2,performed_at=$3,hours=$4,amount=$5,currency=$6,note=$7,version=version+1,next_occurrence_id=$8 WHERE id=$1 RETURNING *",
            [
              maintenanceId,
              b.status,
              b.performedAt ?? null,
              b.hours ?? null,
              b.amount ?? null,
              b.currency ?? null,
              b.note,
              nextId,
            ],
          )
        ).rows[0];
        if (nextId)
          await c.query(
            "INSERT INTO asset_maintenance(id,farm_id,asset_id,project_id,actor_id,title,due_at,interval_days,instructions,assignee_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz+make_interval(days=>$8),$8,$9,(SELECT user_id FROM memberships WHERE farm_id=$2 AND user_id=$10 FOR KEY SHARE),$11)",
            [
              nextId,
              a.farmId,
              old.asset_id,
              old.project_id,
              a.userId,
              old.title,
              b.performedAt,
              old.interval_days,
              old.instructions,
              old.assignee_id,
              hash({ previous: maintenanceId }),
            ],
          );
        if (b.amount && b.currency)
          await finance(c, {
            farmId: a.farmId,
            projectId: old.project_id,
            actorId: a.userId,
            kind: "expense",
            amount: b.amount,
            currency: b.currency,
            sourceType: "asset_maintenance",
            sourceId: maintenanceId,
            observedAt: b.performedAt!,
            note: b.note,
          });
        await audit(
          c,
          a.farmId,
          a.userId,
          "maintenance",
          maintenanceId,
          b.status,
          b.note || b.status,
          old,
          r,
        );
        return r;
      });
    },
  );
}
