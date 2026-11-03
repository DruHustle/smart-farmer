import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { ApiError, audit, type Context } from "../context.js";
import { token, sha256 } from "../security.js";
import {
  authenticateGateway,
  lockGateway,
} from "../integrations/gateway-auth.js";
import { getObjectStore } from "../integrations/object-store.js";
import { requireStorageSpace } from "../integrations/storage-quota.js";
import {
  authorize,
  managers,
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
const cameraParams = z.object({ assetId: uuid });
const bool = z.boolean(),
  time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const configSchema = z
  .object({
    version: z.number().int().positive(),
    provider: z.enum(["simulator", "gateway"]),
    retentionDays: z.number().int().min(1).max(90),
    eventsEnabled: bool,
    liveEnabled: bool,
    capabilities: z
      .object({
        live: bool,
        snapshot: bool,
        motion: bool,
        person: bool,
        ptz: z.literal(false),
      })
      .strict()
      .default({
        live: true,
        snapshot: true,
        motion: true,
        person: false,
        ptz: false,
      }),
    zones: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            name: z.string().min(1).max(80),
            points: z
              .array(
                z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
              )
              .min(3)
              .max(30),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    schedules: z
      .array(
        z
          .object({
            days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
            start: time,
            end: time,
          })
          .strict(),
      )
      .max(14)
      .default([]),
    dedupeSeconds: z.number().int().min(1).max(600).default(30),
  })
  .strict();
export function scheduleActive(
  schedules: any[],
  observedAt: string,
  timezone: string,
) {
  if (!schedules.length) return true;
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(observedAt));
  const get = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      get("weekday"),
    ),
    clock = get("hour") + ":" + get("minute");
  return schedules.some((s) =>
    s.start === s.end
      ? s.days.includes(day)
      : s.start < s.end
        ? s.days.includes(day) && clock >= s.start && clock < s.end
        : (s.days.includes(day) && clock >= s.start) ||
          (s.days.includes((day + 6) % 7) && clock < s.end),
  );
}
const source = (asset: any) =>
  asset.protocol === "simulator" ? "simulator" : "gateway";
export function registerCameras(app: FastifyInstance, ctx: Context) {
  async function permitted(
    farmId: string,
    userId: string,
    assetId: string,
    c: any = ctx.db,
  ) {
    const row = requireRow(
      (
        await c.query(
          "SELECT a.*,cc.provider,cc.version AS config_version,cc.retention_days,cc.events_enabled,cc.live_enabled,cc.capabilities AS camera_capabilities,cc.zones,cc.schedules,cc.dedupe_seconds,cc.last_frame_at FROM assets a LEFT JOIN camera_configurations cc ON cc.asset_id=a.id WHERE a.farm_id=$1 AND a.id=$2 AND a.category='camera' AND EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=a.farm_id AND m.user_id=$3 AND (m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=a.id AND ca.user_id=$3)))",
          [farmId, assetId, userId],
        )
      ).rows[0],
    );
    return row;
  }
  app.get("/v1/farms/:farmId/cameras", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const q = listQuery.parse(req.query);
    const rows = (
      await ctx.db.query(
        "SELECT a.id,a.name,COALESCE(c.version,a.version) AS version,c.provider,COALESCE(c.live_enabled,false) AS live_enabled,c.events_enabled,c.retention_days,c.last_frame_at,c.capabilities,c.zones,c.schedules,c.dedupe_seconds,CASE WHEN c.provider='simulator' THEN 'simulated' WHEN c.last_frame_at>now()-interval '30 seconds' THEN 'connected' ELSE 'offline' END AS connection_state FROM assets a LEFT JOIN camera_configurations c ON c.asset_id=a.id WHERE a.farm_id=$1 AND a.category='camera' AND ($3::uuid IS NULL OR a.id>$3) AND EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=a.farm_id AND m.user_id=$2 AND (m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=a.id AND ca.user_id=$2))) ORDER BY a.id LIMIT $4",
        [a.farmId, a.userId, q.cursor ?? null, q.limit + 1],
      )
    ).rows;
    return paged(rows, q.limit);
  });
  app.post(
    "/v1/farms/:farmId/cameras/:assetId/configure",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply, ["owner"]);
      if (!a) return;
      const { assetId } = cameraParams.parse(req.params),
        b = configSchema.parse(req.body);
      if (new Set(b.zones.map((z) => z.id)).size !== b.zones.length)
        throw new ApiError("duplicate_zone");
      return ctx.transaction(async (c) => {
        const asset = requireRow(
          (
            await c.query(
              "SELECT * FROM assets WHERE farm_id=$1 AND id=$2 AND category='camera' FOR UPDATE",
              [a.farmId, assetId],
            )
          ).rows[0],
        );
        const old = (
          await c.query(
            "SELECT * FROM camera_configurations WHERE asset_id=$1 FOR UPDATE",
            [assetId],
          )
        ).rows[0];
        checkVersion(old ?? asset, b.version);
        if (b.provider === "simulator" && asset.protocol !== "simulator")
          throw new ApiError("simulation_only", 409);
        if (b.provider === "gateway" && asset.protocol === "simulator")
          throw new ApiError("hardware_configuration_required", 409);
        const r = (
          await c.query(
            "INSERT INTO camera_configurations(asset_id,farm_id,provider,retention_days,events_enabled,live_enabled,capabilities,zones,schedules,dedupe_seconds,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(asset_id) DO UPDATE SET provider=$3,retention_days=$4,events_enabled=$5,live_enabled=$6,capabilities=$7,zones=$8,schedules=$9,dedupe_seconds=$10,version=$11 RETURNING *",
            [
              assetId,
              a.farmId,
              b.provider,
              b.retentionDays,
              b.eventsEnabled,
              b.liveEnabled,
              b.capabilities,
              JSON.stringify(b.zones),
              JSON.stringify(b.schedules),
              b.dedupeSeconds,
              b.version + 1,
            ],
          )
        ).rows[0];
        if (asset.integration_state === "unconfigured")
          await c.query(
            "UPDATE assets SET protocol=CASE WHEN protocol='unconfigured' THEN 'http' ELSE protocol END,integration_state='connected-awaiting-verification' WHERE id=$1",
            [assetId],
          );
        if (!b.liveEnabled)
          await c.query(
            "DELETE FROM camera_sessions WHERE asset_id=$1 AND event_id IS NULL",
            [assetId],
          );
        await audit(
          c,
          a.farmId,
          a.userId,
          "camera",
          assetId,
          "configured",
          "owner_confirmation",
          old ?? null,
          r,
        );
        return r;
      });
    },
  );
  app.get("/v1/farms/:farmId/cameras/:assetId/access", async (req, reply) => {
    const a = await authorize(ctx, req, reply, ["owner"]);
    if (!a) return;
    const { assetId } = cameraParams.parse(req.params);
    await permitted(a.farmId, a.userId, assetId);
    return {
      items: (
        await ctx.db.query(
          "SELECT c.user_id,u.username FROM camera_access c JOIN users u ON u.id=c.user_id WHERE c.asset_id=$1",
          [assetId],
        )
      ).rows,
    };
  });
  app.post("/v1/farms/:farmId/cameras/:assetId/access", async (req, reply) => {
    const a = await authorize(ctx, req, reply, ["owner"]);
    if (!a) return;
    const { assetId } = cameraParams.parse(req.params),
      { userId } = z.object({ userId: uuid }).strict().parse(req.body);
    return ctx.transaction(async (c) => {
      await permitted(a.farmId, a.userId, assetId, c);
      await memberExists(c, a.farmId, userId);
      await c.query(
        "INSERT INTO camera_access(asset_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [assetId, userId, a.userId],
      );
      await audit(
        c,
        a.farmId,
        a.userId,
        "camera",
        assetId,
        "access_granted",
        "owner_confirmation",
        null,
        { userId },
      );
      return { userId };
    });
  });
  app.delete(
    "/v1/farms/:farmId/cameras/:assetId/access/:userId",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply, ["owner"]);
      if (!a) return;
      const { assetId, userId } = cameraParams
        .extend({ userId: uuid })
        .parse(req.params);
      return ctx.transaction(async (c) => {
        await permitted(a.farmId, a.userId, assetId, c);
        await c.query(
          "DELETE FROM camera_access WHERE asset_id=$1 AND user_id=$2",
          [assetId, userId],
        );
        await c.query(
          "DELETE FROM camera_sessions WHERE asset_id=$1 AND user_id=$2",
          [assetId, userId],
        );
        await audit(
          c,
          a.farmId,
          a.userId,
          "camera",
          assetId,
          "access_revoked",
          "owner_confirmation",
          null,
          { userId },
        );
        return { userId, revoked: true };
      });
    },
  );
  async function simulatorSegment(
    c: PoolClient,
    asset: any,
    eventId: string | null,
  ) {
    await c.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [
      asset.farm_id,
    ]);
    const bytes = await readFile(
        resolve(
          process.env.CAMERA_SIMULATOR_FIXTURE ||
            "fixtures/camera-simulator.mpegts",
        ),
      ),
      id = randomUUID(),
      digest = createHash("sha256").update(bytes).digest("hex"),
      key = `${asset.farm_id}/${id}-${digest}`;
    await requireStorageSpace(c, asset.farm_id, "camera", bytes.length);
    await getObjectStore().put(key, bytes);
    const expiry = eventId
      ? (
          await c.query("SELECT expires_at FROM camera_events WHERE id=$1", [
            eventId,
          ])
        ).rows[0].expires_at
      : new Date(Date.now() + 180000);
    await c.query(
      "INSERT INTO camera_segments(id,farm_id,asset_id,sequence,observed_at,duration,size_bytes,content_hash,object_key,source,expires_at) VALUES($1,$2,$3,$4,now(),2,$5,$6,$7,'simulator',$8)",
      [
        id,
        asset.farm_id,
        asset.id,
        Date.now() * 1000 + Math.floor(Math.random() * 1000),
        bytes.length,
        digest,
        key,
        expiry,
      ],
    );
    if (eventId)
      await c.query(
        "INSERT INTO camera_event_segments(event_id,segment_id) VALUES($1,$2)",
        [eventId, id],
      );
    await c.query(
      "UPDATE camera_configurations SET last_frame_at=now() WHERE asset_id=$1",
      [asset.id],
    );
  }
  async function newSession(
    req: FastifyRequest,
    reply: FastifyReply,
    event = false,
  ) {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    const params = z
      .object({ assetId: uuid.optional(), eventId: uuid.optional() })
      .parse(req.params);
    let assetId = params.assetId,
      eventId: string | null = null;
    if (event) {
      eventId = params.eventId!;
      assetId = requireRow(
        (
          await ctx.db.query(
            "SELECT asset_id FROM camera_events WHERE id=$1 AND farm_id=$2 AND expires_at>now()",
            [eventId, a.farmId],
          )
        ).rows[0],
      ).asset_id;
    }
    const result = await ctx.transaction(async (c) => {
      const asset = await permitted(a.farmId, a.userId, assetId!, c);
      if (!asset.provider || (!event && !asset.live_enabled))
        throw new ApiError("camera_unavailable", 409);
      if (source(asset) === "simulator")
        await simulatorSegment(c, asset, eventId);
      const have = event
        ? await c.query(
            "SELECT 1 FROM camera_event_segments e JOIN camera_segments s ON s.id=e.segment_id WHERE e.event_id=$1 AND s.expires_at>now()",
            [eventId],
          )
        : await c.query(
            "SELECT 1 FROM camera_segments WHERE asset_id=$1 AND received_at>now()-interval '30 seconds' AND expires_at>now() LIMIT 1",
            [assetId],
          );
      if (event && !have.rowCount) throw new ApiError("clip_unavailable", 404);
      const id = randomUUID(),
        value = token(),
        expiry = new Date(Date.now() + 300000);
      await c.query(
        "INSERT INTO camera_sessions(id,farm_id,asset_id,user_id,event_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, a.farmId, assetId, a.userId, eventId, sha256(value), expiry],
      );
      await audit(
        c,
        a.farmId,
        a.userId,
        "camera",
        assetId!,
        "playback_started",
        event ? "retained_event" : "explicit_live_view",
      );
      return {
        id,
        token: value,
        expiresAt: expiry.toISOString(),
        playlistPath: `/v1/farms/${a.farmId}/cameras/${assetId}/sessions/${id}/index.m3u8`,
        connectionState:
          source(asset) === "simulator"
            ? "simulated"
            : have.rowCount
              ? "connected"
              : "awaiting_gateway",
        mode: event
          ? "event"
          : source(asset) === "simulator"
            ? "simulated"
            : "live",
      };
    });
    reply.header(
      "Set-Cookie",
      `sf_cam_${result.id}=${result.token}; Path=${result.playlistPath.replace("/index.m3u8", "")}; Max-Age=300; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    return result;
  }
  app.post("/v1/farms/:farmId/cameras/:assetId/sessions", (req, reply) =>
    newSession(req, reply),
  );
  app.post("/v1/farms/:farmId/camera-events/:eventId/session", (req, reply) =>
    newSession(req, reply, true),
  );
  app.post("/v1/farms/:farmId/camera-events/:eventId/sessions", (req, reply) =>
    newSession(req, reply, true),
  );
  async function session(req: FastifyRequest) {
    const p = z
      .object({ farmId: uuid, assetId: uuid, sessionId: uuid })
      .parse(req.params);
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`sf_cam_${p.sessionId}=`))
      ?.split("=")[1];
    const raw =
      req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ??
      cookie;
    if (!raw) throw new ApiError("unauthorized", 401);
    const s = requireRow(
      (
        await ctx.db.query(
          "SELECT * FROM camera_sessions WHERE id=$1 AND farm_id=$2 AND asset_id=$3 AND token_hash=$4 AND expires_at>clock_timestamp()",
          [p.sessionId, p.farmId, p.assetId, sha256(raw)],
        )
      ).rows[0],
    );
    const asset = await permitted(p.farmId, s.user_id, p.assetId);
    if (!s.event_id && !asset.live_enabled)
      throw new ApiError("camera_unavailable", 409);
    return { ...s, asset };
  }
  app.get(
    "/v1/farms/:farmId/cameras/:assetId/sessions/:sessionId/index.m3u8",
    async (req, reply) => {
      const s = await session(req);
      const rows = (
        await ctx.db.query(
          s.event_id
            ? "SELECT s.* FROM camera_segments s JOIN camera_event_segments e ON e.segment_id=s.id WHERE e.event_id=$1 AND s.expires_at>now() ORDER BY s.sequence"
            : "SELECT * FROM (SELECT * FROM camera_segments WHERE asset_id=$1 AND expires_at>now() ORDER BY sequence DESC LIMIT 6) segments ORDER BY sequence",
          [s.event_id ?? s.asset_id],
        )
      ).rows;
      if (!rows.length) throw new ApiError("camera_unavailable", 503);
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:" +
          Math.ceil(Math.max(...rows.map((x) => Number(x.duration)))),
        "#EXT-X-MEDIA-SEQUENCE:" + rows[0].sequence,
        ...rows.flatMap((r) => [
          ...(r.discontinuity ? ["#EXT-X-DISCONTINUITY"] : []),
          "#EXTINF:" + Number(r.duration).toFixed(3) + ",",
          r.id + ".ts",
        ]),
      ];
      if (s.event_id || s.asset.provider === "simulator")
        lines.push("#EXT-X-ENDLIST");
      return reply
        .type("application/vnd.apple.mpegurl")
        .send(lines.join("\n") + "\n");
    },
  );
  app.get(
    "/v1/farms/:farmId/cameras/:assetId/sessions/:sessionId/:segmentId.ts",
    async (req, reply) => {
      const s = await session(req),
        { segmentId } = z.object({ segmentId: uuid }).parse(req.params);
      const segment = requireRow(
        (
          await ctx.db.query(
            "SELECT * FROM camera_segments s WHERE s.id=$1 AND s.asset_id=$2 AND s.expires_at>now() AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM camera_event_segments e WHERE e.segment_id=s.id AND e.event_id=$3))",
            [segmentId, s.asset_id, s.event_id],
          )
        ).rows[0],
      );
      const bytes = await getObjectStore().get(segment.object_key);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        segment.content_hash
      )
        throw new ApiError("media_integrity_error", 503);
      return reply.type("video/mp2t").send(bytes);
    },
  );
  app.get("/v1/farms/:farmId/cameras/:assetId/snapshot", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const { assetId } = cameraParams.parse(req.params),
      asset = await permitted(a.farmId, a.userId, assetId);
    if (asset.provider !== "simulator") {
      if (!asset.camera_capabilities?.snapshot)
        throw new ApiError("unsupported_snapshot");
      await ctx.db.query(
        "UPDATE camera_configurations SET snapshot_requested_at=now() WHERE asset_id=$1",
        [assetId],
      );
    }
    if (asset.provider === "simulator")
      return reply
        .type("image/jpeg")
        .header("X-Media-Source", "simulator")
        .send(await readFile(resolve("fixtures/camera-simulator.jpg")));
    const row = requireRow(
      (
        await ctx.db.query(
          "SELECT * FROM camera_snapshots WHERE asset_id=$1 AND observed_at>now()-interval '1 day'",
          [assetId],
        )
      ).rows[0],
    );
    const bytes = await getObjectStore().get(row.object_key);
    if (createHash("sha256").update(bytes).digest("hex") !== row.content_hash)
      throw new ApiError("media_integrity_error", 503);
    await ctx.transaction((c) =>
      audit(
        c,
        a.farmId,
        a.userId,
        "camera",
        assetId,
        "snapshot_accessed",
        "authorised_view",
      ),
    );
    return reply
      .type("image/jpeg")
      .header("X-Observed-At", new Date(row.observed_at).toISOString())
      .header("X-Media-Source", row.source)
      .send(bytes);
  });
  const eventSchema = z
    .object({
      id: uuid,
      kind: z.enum(["motion", "person"]),
      observedAt: instant,
      zoneId: z.string().max(40).nullable().default(null),
      confidence: z.number().min(0).max(1).nullable().default(null),
    })
    .strict();
  async function event(
    c: PoolClient,
    asset: any,
    b: z.infer<typeof eventSchema>,
    retentionDays?: number,
  ) {
    validateInstant(b.observedAt);
    await operationLock(c, "camera:" + b.id);
    const prior = (
      await c.query("SELECT * FROM camera_events WHERE id=$1", [b.id])
    ).rows[0];
    if (prior) {
      if (prior.asset_id !== asset.id || prior.payload_hash !== hash(b))
        throw new ApiError("idempotency_conflict", 409);
      return { id: b.id, replayed: true, source: source(asset) };
    }
    const conf = (
      await c.query(
        "SELECT c.*,f.timezone FROM camera_configurations c JOIN farms f ON f.id=c.farm_id WHERE asset_id=$1",
        [asset.id],
      )
    ).rows[0];
    if (conf) {
      if (
        !conf.events_enabled ||
        !scheduleActive(conf.schedules, b.observedAt, conf.timezone)
      )
        return { id: b.id, status: "ignored_schedule", source: source(asset) };
      if (!conf.capabilities[b.kind])
        throw new ApiError("unsupported_detection");
      if (conf.zones.length && !b.zoneId)
        return {
          id: b.id,
          status: "ignored_unmapped_zone",
          source: source(asset),
        };
      if (b.zoneId && !conf.zones.some((z: any) => z.id === b.zoneId))
        throw new ApiError("unknown_zone");
      const recent = (
        await c.query(
          "SELECT id FROM camera_events WHERE asset_id=$1 AND kind=$2 AND zone_id IS NOT DISTINCT FROM $3 AND ABS(EXTRACT(EPOCH FROM observed_at-$4::timestamptz))<$5 LIMIT 1",
          [asset.id, b.kind, b.zoneId, b.observedAt, conf.dedupe_seconds],
        )
      ).rows[0];
      if (recent)
        return { id: recent.id, status: "deduplicated", source: source(asset) };
    } else if (source(asset) !== "simulator")
      throw new ApiError("camera_unconfigured", 409);
    await c.query(
      "INSERT INTO camera_events(id,farm_id,asset_id,kind,source,observed_at,expires_at,payload_hash,zone_id,confidence) VALUES($1,$2,$3,$4,$5,$6,$6::timestamptz+make_interval(days=>$7),$8,$9,$10)",
      [
        b.id,
        asset.farm_id,
        asset.id,
        b.kind,
        source(asset),
        b.observedAt,
        conf?.retention_days ?? retentionDays ?? 7,
        hash(b),
        b.zoneId,
        b.confidence,
      ],
    );
    await c.query(
      "INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key) SELECT $1,m.user_id,'camera','camera_attention',$4,'camera_event',$3::uuid,'camera:'||($3::uuid)::text FROM memberships m WHERE m.farm_id=$1 AND (m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access a WHERE a.asset_id=$2 AND a.user_id=m.user_id)) ON CONFLICT DO NOTHING",
      [
        asset.farm_id,
        asset.id,
        b.id,
        {
          title: asset.name,
          kind: b.kind,
          source: source(asset),
          observedAt: b.observedAt,
        },
      ],
    );
    return { id: b.id, status: "recorded", source: source(asset) };
  }
  app.get("/v1/farms/:farmId/camera-events", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const q = listQuery.parse(req.query);
    const rows = (
      await ctx.db.query(
        "SELECT e.*,a.name,(e.received_at-e.observed_at>interval '60 seconds') AS delayed,EXISTS(SELECT 1 FROM camera_event_segments s WHERE s.event_id=e.id) AS clip_available FROM camera_events e JOIN assets a ON a.id=e.asset_id WHERE e.farm_id=$1 AND e.expires_at>now() AND ($3::uuid IS NULL OR e.id>$3) AND EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=e.farm_id AND m.user_id=$2 AND (m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=e.asset_id AND ca.user_id=$2))) ORDER BY e.id LIMIT $4",
        [a.farmId, a.userId, q.cursor ?? null, q.limit + 1],
      )
    ).rows;
    return paged(rows, q.limit);
  });
  app.post("/v1/farms/:farmId/camera-events", async (req, reply) => {
    const a = await authorize(ctx, req, reply, managers);
    if (!a) return;
    const input = eventSchema
      .extend({
        assetId: uuid,
        retentionDays: z.number().int().min(1).max(90).default(7),
      })
      .parse(req.body);
    const { assetId, retentionDays, ...b } = input;
    const result = await ctx.transaction(async (c) => {
      const asset = requireRow(
        (
          await c.query(
            "SELECT * FROM assets WHERE farm_id=$1 AND id=$2 AND category='camera' AND protocol='simulator' FOR UPDATE",
            [a.farmId, assetId],
          )
        ).rows[0],
      );
      const r = await event(c, asset, b, retentionDays);
      if (
        !r.replayed &&
        r.status === "recorded" &&
        (
          await c.query(
            "SELECT 1 FROM camera_configurations WHERE asset_id=$1",
            [assetId],
          )
        ).rowCount
      )
        await simulatorSegment(c, asset, r.id);
      return r;
    });
    return reply
      .code(result.replayed || result.status !== "recorded" ? 200 : 201)
      .send(result);
  });
  app.post(
    "/v1/farms/:farmId/camera-events/:eventId/acknowledge",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const { eventId } = z.object({ eventId: uuid }).parse(req.params);
      const row = requireRow(
        (
          await ctx.db.query(
            "SELECT * FROM camera_events WHERE id=$1 AND farm_id=$2 AND expires_at>now()",
            [eventId, a.farmId],
          )
        ).rows[0],
      );
      await permitted(a.farmId, a.userId, row.asset_id);
      await ctx.db.query(
        "UPDATE camera_events SET acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,$2) WHERE id=$1",
        [eventId, a.userId],
      );
      await ctx.db.query(
        "UPDATE notifications SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE entity_type='camera_event' AND entity_id=$1",
        [eventId],
      );
      return { id: eventId, status: "acknowledged" };
    },
  );
  app.post(
    "/v1/farms/:farmId/camera-events/:eventId/incident",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply, [
        "owner",
        "manager",
        "worker",
      ]);
      if (!a) return;
      const { eventId } = z.object({ eventId: uuid }).parse(req.params);
      const b = z
        .object({
          id: uuid,
          title: z.string().trim().min(1).max(200),
          description: z.string().max(4000).default(""),
          severity: z.enum(["low", "medium", "high", "urgent"]),
          assigneeId: uuid.nullable().default(null),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      return ctx.transaction(async (c) => {
        const row = requireRow(
          (
            await c.query(
              "SELECT * FROM camera_events WHERE farm_id=$1 AND id=$2 AND expires_at>now() FOR UPDATE",
              [a.farmId, eventId],
            )
          ).rows[0],
        );
        await permitted(a.farmId, a.userId, row.asset_id, c);
        if (b.assigneeId && !(await ctx.member(a.farmId, a.userId, managers)))
          throw new ApiError("assignment_permission_required", 403);
        await memberExists(c, a.farmId, b.assigneeId);
        await operationLock(c, "camera-incident:" + b.id);
        if (row.incident_id) {
          const old = requireRow(
            (
              await c.query(
                "SELECT * FROM incidents WHERE farm_id=$1 AND id=$2",
                [a.farmId, row.incident_id],
              )
            ).rows[0],
          );
          if (
            old.id !== b.id ||
            old.created_by !== a.userId ||
            old.payload_hash !== hash(b)
          )
            throw new ApiError("idempotency_conflict", 409);
          return { id: b.id, replayed: true };
        }
        const old = (
          await c.query("SELECT id FROM incidents WHERE id=$1", [b.id])
        ).rows[0];
        if (old) throw new ApiError("idempotency_conflict", 409);
        await c.query(
          "INSERT INTO incidents(id,farm_id,title,description,severity,assignee_id,created_by,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            b.id,
            a.farmId,
            b.title,
            b.description,
            b.severity,
            b.assigneeId,
            a.userId,
            hash(b),
          ],
        );
        await c.query("UPDATE camera_events SET incident_id=$2 WHERE id=$1", [
          eventId,
          b.id,
        ]);
        await audit(
          c,
          a.farmId,
          a.userId,
          "camera_event",
          eventId,
          "incident_linked",
          "reviewed_farm_visible_incident",
          null,
          { incidentId: b.id },
        );
        reply.code(201);
        return { id: b.id, version: 1 };
      });
    },
  );
  app.post("/v1/edge/camera/events", async (req) => {
    const auth = await authenticateGateway(ctx.db, req),
      b = eventSchema.parse(req.body);
    return ctx.transaction(async (c) => {
      const asset = await lockGateway(c, auth);
      if (asset.category !== "camera") throw new ApiError("not_found", 404);
      return event(c, asset, b);
    });
  });
  app.post("/v1/edge/camera/demand", async (req) => {
    const asset = await authenticateGateway(ctx.db, req);
    if (asset.category !== "camera") throw new ApiError("not_found", 404);
    const c = requireRow(
      (
        await ctx.db.query(
          "SELECT c.*,f.timezone FROM camera_configurations c JOIN farms f ON f.id=c.farm_id WHERE asset_id=$1",
          [asset.id],
        )
      ).rows[0],
    );
    const snapshot = (
      await ctx.db.query(
        "SELECT observed_at FROM camera_snapshots WHERE asset_id=$1",
        [asset.id],
      )
    ).rows[0];
    return {
      snapshot:
        c.capabilities.snapshot &&
        c.snapshot_requested_at &&
        Date.now() - new Date(c.snapshot_requested_at).getTime() < 60000 &&
        (!snapshot ||
          new Date(snapshot.observed_at).getTime() <
            new Date(c.snapshot_requested_at).getTime()),
      live:
        c.live_enabled &&
        Boolean(
          (
            await ctx.db.query(
              "SELECT 1 FROM camera_sessions WHERE asset_id=$1 AND event_id IS NULL AND expires_at>clock_timestamp() LIMIT 1",
              [asset.id],
            )
          ).rowCount,
        ),
      eventsEnabled: c.events_enabled,
      timezone: c.timezone,
      capabilities: c.capabilities,
      zones: c.zones,
      schedules: c.schedules,
      retentionDays: c.retention_days,
    };
  });
  app.post(
    "/v1/edge/camera/segments",
    { bodyLimit: 7_100_000 },
    async (req) => {
      const auth = await authenticateGateway(ctx.db, req);
      const b = z
        .object({
          id: uuid,
          sequence: z.number().int().nonnegative().safe(),
          observedAt: instant,
          duration: z.number().positive().max(15),
          discontinuity: z.boolean().default(false),
          eventId: uuid.nullable().default(null),
          dataBase64: z.string().max(6990508),
        })
        .strict()
        .parse(req.body);
      validateInstant(b.observedAt);
      const bytes = Buffer.from(b.dataBase64, "base64");
      if (
        !bytes.length ||
        bytes.length > 5242880 ||
        bytes.length % 188 ||
        bytes.toString("base64") !== b.dataBase64 ||
        Array.from(
          { length: bytes.length / 188 },
          (_, i) => bytes[i * 188],
        ).some((x) => x !== 0x47)
      )
        throw new ApiError("invalid_video_segment");
      const fingerprint = createHash("sha256").update(bytes).digest("hex"),
        key = `${auth.farm_id}/${b.id}-${fingerprint}`;
      return ctx.transaction(async (c) => {
        const asset = await lockGateway(c, auth);
        if (asset.category !== "camera") throw new ApiError("not_found", 404);
        await c.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [
          asset.farm_id,
        ]);
        const conf = requireRow(
          (
            await c.query(
              "SELECT * FROM camera_configurations WHERE asset_id=$1",
              [asset.id],
            )
          ).rows[0],
        );
        const old = (
          await c.query("SELECT * FROM camera_segments WHERE id=$1", [b.id])
        ).rows[0];
        if (old) {
          if (
            old.asset_id !== asset.id ||
            old.content_hash !== fingerprint ||
            Number(old.sequence) !== b.sequence ||
            Number(old.duration) !== b.duration ||
            old.discontinuity !== b.discontinuity ||
            new Date(old.observed_at).getTime() !== Date.parse(b.observedAt)
          )
            throw new ApiError("idempotency_conflict", 409);
          return { id: b.id, replayed: true };
        }
        let expiry: Date;
        if (b.eventId) {
          const e = requireRow(
            (
              await c.query(
                "SELECT * FROM camera_events WHERE id=$1 AND asset_id=$2 AND expires_at>now()",
                [b.eventId, asset.id],
              )
            ).rows[0],
          );
          if (
            Math.abs(
              Date.parse(b.observedAt) - new Date(e.observed_at).getTime(),
            ) > 120000
          )
            throw new ApiError("segment_outside_event");
          expiry = e.expires_at;
        } else {
          if (
            !conf.live_enabled ||
            !(
              await c.query(
                "SELECT 1 FROM camera_sessions WHERE asset_id=$1 AND event_id IS NULL AND expires_at>now() LIMIT 1",
                [asset.id],
              )
            ).rowCount
          )
            throw new ApiError("live_view_not_requested", 409);
          expiry = new Date(Date.now() + 90000);
        }
        await requireStorageSpace(c, asset.farm_id, "camera", bytes.length);
        await getObjectStore().put(key, bytes);
        await c.query(
          "INSERT INTO camera_segments(id,farm_id,asset_id,sequence,observed_at,duration,size_bytes,content_hash,object_key,source,expires_at,discontinuity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            b.id,
            asset.farm_id,
            asset.id,
            b.sequence,
            b.observedAt,
            b.duration,
            bytes.length,
            fingerprint,
            key,
            source(asset),
            expiry,
            b.discontinuity,
          ],
        );
        if (b.eventId)
          await c.query(
            "INSERT INTO camera_event_segments(event_id,segment_id) VALUES($1,$2)",
            [b.eventId, b.id],
          );
        await c.query(
          "UPDATE camera_configurations SET last_frame_at=GREATEST(last_frame_at,$2) WHERE asset_id=$1",
          [asset.id, b.observedAt],
        );
        return { id: b.id, status: "stored" };
      });
    },
  );
  app.post(
    "/v1/edge/camera/snapshot",
    { bodyLimit: 7_100_000 },
    async (req) => {
      const auth = await authenticateGateway(ctx.db, req),
        b = z
          .object({
            id: uuid,
            observedAt: instant,
            dataBase64: z.string().max(6990508),
          })
          .strict()
          .parse(req.body);
      validateInstant(b.observedAt);
      const bytes = Buffer.from(b.dataBase64, "base64");
      if (
        bytes.length < 12 ||
        bytes.length > 5242880 ||
        bytes[0] !== 255 ||
        bytes[1] !== 216 ||
        bytes[2] !== 255 ||
        bytes.toString("base64") !== b.dataBase64
      )
        throw new ApiError("invalid_media");
      return ctx.transaction(async (c) => {
        const asset = await lockGateway(c, auth);
        await c.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [
          asset.farm_id,
        ]);
        const conf = requireRow(
          (
            await c.query(
              "SELECT * FROM camera_configurations WHERE asset_id=$1",
              [asset.id],
            )
          ).rows[0],
        );
        if (!conf.capabilities.snapshot)
          throw new ApiError("unsupported_snapshot");
        const old = (
          await c.query("SELECT * FROM camera_snapshots WHERE asset_id=$1", [
            asset.id,
          ])
        ).rows[0];
        const fingerprint = createHash("sha256").update(bytes).digest("hex"),
          key = `${asset.farm_id}/${b.id}-${fingerprint}`;
        if (
          old &&
          new Date(old.observed_at).getTime() >= Date.parse(b.observedAt)
        )
          return { id: b.id, status: "older_observation_ignored" };
        await requireStorageSpace(c, asset.farm_id, "camera", bytes.length);
        await getObjectStore().put(key, bytes);
        await c.query(
          "INSERT INTO camera_snapshots(asset_id,farm_id,observed_at,content_hash,object_key,size_bytes,source) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(asset_id) DO UPDATE SET observed_at=$3,content_hash=$4,object_key=$5,size_bytes=$6,source=$7",
          [
            asset.id,
            asset.farm_id,
            b.observedAt,
            fingerprint,
            key,
            bytes.length,
            source(asset),
          ],
        );
        if (old)
          await c.query(
            "INSERT INTO object_garbage(object_key,farm_id,reason,size_bytes,media_kind) VALUES($1,$2,'snapshot_replaced',$3,'camera') ON CONFLICT DO NOTHING",
            [old.object_key, asset.farm_id, old.size_bytes],
          );
        return { id: b.id, status: "stored" };
      });
    },
  );
}
