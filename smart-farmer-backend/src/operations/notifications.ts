import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ApiError, type Context } from "../context.js";
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
  sealSecret,
  openSecret,
  digest,
  safeEndpoint,
  fetchJson,
  memberExists,
} from "./common.js";
import { providerStatus } from "./farm.js";
import {
  NotificationRequestHold,
  prepareNotificationRequest,
  restoreNotificationRequest,
  sealNotificationRequest,
  sendNotificationRequest,
  type NotificationContent,
  type NotificationRequest,
  type NotificationResult,
} from "./notification-request.js";
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const messages: Record<string, Record<string, string>> = {
  sn: {
    task_assigned: "Basa rawapihwa",
    task_due: "Basa rasvika nguva",
    incident_attention: "Chiitiko chinoda kutariswa",
    maintenance_due: "Kugadzirisa muchina kwasvika",
    equipment_stale: "Mashoko emuchina anonoka",
    camera_attention: "Chiitiko chekamera",
    camera_escalation: "Chiitiko chekamera hachisati chabvumwa",
    reminder: "Chiyeuchidzo",
    verification: "Kodhi yekusimbisa",
  },
  nd: {
    task_assigned: "Umsebenzi owuphiweyo",
    task_due: "Isikhathi somsebenzi sesifikile",
    incident_attention: "Isigameko esidinga ukunakwa",
    maintenance_due: "Isikhathi sokulungisa umtshina",
    equipment_stale: "Imibiko yomtshina iyaphuza",
    camera_attention: "Isigameko sekhamera",
    camera_escalation: "Isigameko sekhamera asikaqinisekiswa",
    reminder: "Isikhumbuzo",
    verification: "Ikhodi yokuqinisekisa",
  },
};
export function notificationText(row: any, language: string) {
  const catalog = messages[language] ?? messages.sn;
  return {
    language: language === "nd" ? "nd" : "sn",
    title: catalog[row.message_key] ?? catalog.reminder,
    privatePushBody:
      language === "nd"
        ? "Vula iSmart Farmer ukuze ubone isaziso sakho."
        : "Vhura Smart Farmer kuti uone chiziviso chako.",
    body: [row.arguments?.title, row.arguments?.note, row.arguments?.code]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 1800),
  };
}
export function isQuiet(
  now: Date,
  timezone: string,
  start: string | null,
  end: string | null,
) {
  if (!start || !end) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return start === end
    ? true
    : start < end
      ? parts >= start && parts < end
      : parts >= start || parts < end;
}
/** "accepted" is a provider receipt, never a promise of human delivery. */
export async function dispatchNotification(
  channel: string,
  address: string,
  content: NotificationContent,
  id: string,
): Promise<NotificationResult> {
  const status = (providerStatus() as any)[channel];
  if (!status?.configured) return { state: "unconfigured", providerId: null };
  if (status.mode === "simulated")
    return { state: "simulated", providerId: "simulation:" + id };
  return sendNotificationRequest(prepareNotificationRequest(channel, address, content, id));
}
export function registerNotifications(app: FastifyInstance, ctx: Context) {
  app.get("/v1/farms/:farmId/notifications", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const q = listQuery.parse(req.query),
      lang = (
        await ctx.db.query("SELECT language FROM users WHERE id=$1", [a.userId])
      ).rows[0].language;
    const rows = (
      await ctx.db.query(
        `SELECT n.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('channel',c.channel,'state',d.state,'attempts',d.attempts,'last_error',d.last_error)) FROM notification_deliveries d JOIN notification_channels c ON c.id=d.channel_id WHERE d.notification_id=n.id),'[]') AS deliveries FROM notifications n WHERE farm_id=$1 AND user_id=$2 AND available_at<=now() AND (n.kind<>'camera' OR EXISTS(SELECT 1 FROM camera_events e JOIN memberships m ON m.farm_id=e.farm_id AND m.user_id=n.user_id WHERE e.id=n.entity_id AND (m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=e.asset_id AND ca.user_id=n.user_id)))) AND ($3::uuid IS NULL OR n.id>$3) ORDER BY n.id LIMIT $4`,
        [a.farmId, a.userId, q.cursor ?? null, q.limit + 1],
      )
    ).rows.map((r) => ({ ...r, ...notificationText(r, lang) }));
    return paged(rows, q.limit);
  });
  app.post(
    "/v1/farms/:farmId/notifications/:notificationId/ack",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const { notificationId } = z
        .object({ notificationId: uuid })
        .parse(req.params);
      return requireRow(
        (
          await ctx.db.query(
            "UPDATE notifications SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1 AND farm_id=$2 AND user_id=$3 RETURNING id,acknowledged_at",
            [notificationId, a.farmId, a.userId],
          )
        ).rows[0],
      );
    },
  );
  app.get("/v1/farms/:farmId/notification-preferences", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const row = (
      await ctx.db.query(
        "SELECT * FROM notification_preferences WHERE farm_id=$1 AND user_id=$2",
        [a.farmId, a.userId],
      )
    ).rows[0];
    return {
      inApp: row?.in_app ?? true,
      push: row?.push ?? false,
      email: row?.email ?? false,
      sms: row?.sms ?? false,
      quietStart: row?.quiet_start ?? null,
      quietEnd: row?.quiet_end ?? null,
    };
  });
  app.patch(
    "/v1/farms/:farmId/notification-preferences",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const b = z
        .object({
          inApp: z.boolean(),
          push: z.boolean(),
          email: z.boolean(),
          sms: z.boolean(),
          quietStart: clock.nullable().default(null),
          quietEnd: clock.nullable().default(null),
        })
        .strict()
        .refine((v) => (v.quietStart === null) === (v.quietEnd === null))
        .parse(req.body);
      await (
        await ctx.db.query(
          "INSERT INTO notification_preferences(farm_id,user_id,in_app,push,email,sms,quiet_start,quiet_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(farm_id,user_id) DO UPDATE SET in_app=$3,push=$4,email=$5,sms=$6,quiet_start=$7,quiet_end=$8 RETURNING *",
          [
            a.farmId,
            a.userId,
            b.inApp,
            b.push,
            b.email,
            b.sms,
            b.quietStart,
            b.quietEnd,
          ],
        )
      ).rows[0];
      return b;
    },
  );
  app.get("/v1/farms/:farmId/notification-channels", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    return {
      items: (
        await ctx.db.query(
          "SELECT id,channel,masked_address,verified_at,disabled_at FROM notification_channels WHERE user_id=$1 ORDER BY created_at",
          [a.userId],
        )
      ).rows,
    };
  });
  app.post(
    "/v1/farms/:farmId/notification-channels",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const b = z
        .object({
          id: uuid,
          channel: z.enum(["push", "email", "sms"]),
          address: z.string().trim().min(5).max(254),
        })
        .strict()
        .parse(req.body);
      const address =
        b.channel === "email"
          ? z.email().parse(b.address).toLowerCase()
          : b.channel === "sms"
            ? z
                .string()
                .regex(/^\+[1-9]\d{7,14}$/)
                .parse(b.address)
            : z
                .string()
                .regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/)
                .parse(b.address);
      if (!(providerStatus() as any)[b.channel].configured)
        throw new ApiError("provider_unconfigured", 409);
      const code = String(randomInt(100000, 1000000));
      const row = await ctx.transaction(async (c) => {
        await operationLock(
          c,
          "notification-address:" +
            a.userId +
            ":" +
            b.channel +
            ":" +
            digest(address),
        );
        const old = (
          await c.query(
            "SELECT * FROM notification_channels WHERE id=$1 OR (user_id=$2 AND channel=$3 AND address_hash=$4) ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE",
            [b.id, a.userId, b.channel, digest(address)],
          )
        ).rows[0];
        if (old) {
          if (
            old.user_id !== a.userId ||
            old.channel !== b.channel ||
            old.address_hash !== digest(address)
          )
            throw new ApiError("idempotency_conflict", 409);
          return { ...old, replayed: true };
        }
        const masked =
          b.channel === "email"
            ? address.slice(0, 1) + "***@" + address.split("@")[1]
            : b.channel === "sms"
              ? "***" + address.slice(-4)
              : "Expo…" + address.slice(-5);
        return (
          await c.query(
            "INSERT INTO notification_channels(id,user_id,channel,address_cipher,address_hash,masked_address,verification_hash,verification_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes') RETURNING *",
            [
              b.id,
              a.userId,
              b.channel,
              sealSecret(address, b.id),
              digest(address),
              masked,
              digest(b.id + ":" + code),
            ],
          )
        ).rows[0];
      });
      if (row.replayed)
        return {
          id: row.id,
          replayed: true,
          verified: Boolean(row.verified_at && !row.disabled_at),
          verificationRequired: !row.verified_at || Boolean(row.disabled_at),
          masked_address: row.masked_address,
        };
      return reply
        .code(201)
        .send(await sendVerification(row, a.userId, code, "verify:" + row.id));
    },
  );
  async function sendVerification(
    row: any,
    userId: string,
    code: string,
    key: string,
  ) {
    const language = (
      await ctx.db.query("SELECT language FROM users WHERE id=$1", [userId])
    ).rows[0].language;
    let outcome;
    try {
      outcome = await dispatchNotification(
        row.channel,
        openSecret(row.address_cipher, row.id),
        notificationText(
          { message_key: "verification", arguments: { code } },
          language,
        ),
        key,
      );
    } catch {
      throw new ApiError("verification_delivery_unknown", 503);
    }
    if (
      !["accepted", "provider_delivered", "simulated"].includes(outcome.state)
    )
      throw new ApiError("verification_delivery_failed", 503);
    return {
      id: row.id,
      state: outcome.state,
      verificationRequired: true,
      masked_address: row.masked_address,
      ...(outcome.state === "simulated" ? { verificationCode: code } : {}),
    };
  }
  app.post(
    "/v1/farms/:farmId/notification-channels/:channelId/resend",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const { channelId } = z.object({ channelId: uuid }).parse(req.params),
        code = String(randomInt(100000, 1000000));
      const row = await ctx.transaction(async (c) => {
        const old = requireRow(
          (
            await c.query(
              "SELECT * FROM notification_channels WHERE id=$1 AND user_id=$2 FOR UPDATE",
              [channelId, a.userId],
            )
          ).rows[0],
        );
        if (!(providerStatus() as any)[old.channel].configured)
          throw new ApiError("provider_unconfigured", 409);
        if (old.verified_at && !old.disabled_at)
          return { ...old, alreadyVerified: true };
        if (new Date(old.verification_sent_at).getTime() > Date.now() - 60000)
          throw new ApiError("verification_retry_later", 429);
        return (
          await c.query(
            "UPDATE notification_channels SET verification_hash=$2,verification_expires_at=now()+interval '10 minutes',verification_attempts=0,verification_sent_at=now(),verified_at=NULL WHERE id=$1 RETURNING *",
            [channelId, digest(channelId + ":" + code)],
          )
        ).rows[0];
      });
      if (row.alreadyVerified) return { id: channelId, verified: true };
      return sendVerification(
        row,
        a.userId,
        code,
        "verify:" +
          channelId +
          ":" +
          new Date(row.verification_sent_at).getTime(),
      );
    },
  );

  app.post(
    "/v1/farms/:farmId/notification-channels/:channelId/verify",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const { channelId } = z.object({ channelId: uuid }).parse(req.params),
        { code } = z
          .object({ code: z.string().regex(/^\d{6}$/) })
          .strict()
          .parse(req.body);
      const result = await ctx.transaction(async (c) => {
        const row = requireRow(
          (
            await c.query(
              "SELECT * FROM notification_channels WHERE id=$1 AND user_id=$2 FOR UPDATE",
              [channelId, a.userId],
            )
          ).rows[0],
        );
        if (row.verified_at && !row.disabled_at)
          return { id: channelId, verified: true };
        if (
          !row.verification_hash ||
          !row.verification_expires_at ||
          row.verification_attempts >= 5 ||
          new Date(row.verification_expires_at).getTime() < Date.now()
        )
          return { error: "verification_expired" };
        await c.query(
          "UPDATE notification_channels SET verification_attempts=verification_attempts+1 WHERE id=$1",
          [channelId],
        );
        const expected = Buffer.from(row.verification_hash),
          provided = Buffer.from(digest(channelId + ":" + code));
        if (
          expected.length !== provided.length ||
          !timingSafeEqual(expected, provided)
        )
          return { error: "invalid_verification_code" };
        if (row.channel === "push")
          await c.query(
            "UPDATE notification_channels SET disabled_at=now() WHERE channel='push' AND address_hash=$1 AND user_id<>$2",
            [row.address_hash, a.userId],
          );
        await c.query(
          "UPDATE notification_channels SET verified_at=now(),verification_hash=NULL,verification_expires_at=NULL,disabled_at=NULL WHERE id=$1",
          [channelId],
        );
        return { id: channelId, verified: true };
      });
      if (result.error) throw new ApiError(result.error, 400);
      return result;
    },
  );
  app.delete(
    "/v1/farms/:farmId/notification-channels/:channelId",
    async (req, reply) => {
      const a = await authorize(ctx, req, reply);
      if (!a) return;
      const { channelId } = z.object({ channelId: uuid }).parse(req.params);
      requireRow(
        (
          await ctx.db.query(
            "UPDATE notification_channels SET disabled_at=COALESCE(disabled_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id",
            [channelId, a.userId],
          )
        ).rows[0],
      );
      return { id: channelId, disabled: true };
    },
  );
  app.post("/v1/farms/:farmId/notifications", async (req, reply) => {
    const a = await authorize(ctx, req, reply, managers);
    if (!a) return;
    const b = z
      .object({
        id: uuid,
        audience: z.enum(["managers", "members", "assignee"]),
        userId: uuid.nullable().default(null),
        kind: z.enum(["reminder", "incident", "maintenance"]),
        title: z.string().min(1).max(150),
        note: z.string().max(2000).default(""),
        dueAt: instant.nullable().default(null),
      })
      .strict()
      .parse(req.body);
    if (b.audience === "assignee" && !b.userId)
      throw new ApiError("assignee_required");
    return ctx.transaction(async (c) => {
      await operationLock(c, "notification:" + b.id);
      const old = (
        await c.query("SELECT * FROM notification_requests WHERE id=$1", [b.id])
      ).rows[0];
      if (old) {
        if (
          old.farm_id !== a.farmId ||
          old.actor_id !== a.userId ||
          old.payload_hash !== hash(b)
        )
          throw new ApiError("idempotency_conflict", 409);
        return { id: b.id, replayed: true };
      }
      await memberExists(c, a.farmId, b.userId);
      await c.query(
        "INSERT INTO notification_requests(id,farm_id,actor_id,payload_hash) VALUES($1,$2,$3,$4)",
        [b.id, a.farmId, a.userId, hash(b)],
      );
      await c.query(
        "INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,dedupe_key,available_at) SELECT farm_id,user_id,$3,'reminder',$4,$5,COALESCE($6::timestamptz,now()) FROM memberships WHERE farm_id=$1 AND ($2='members' OR $2='managers' AND role IN ('owner','manager') OR $2='assignee' AND user_id=$7)",
        [
          a.farmId,
          b.audience,
          b.kind,
          { title: b.title, note: b.note },
          "manual:" + b.id,
          b.dueAt,
          b.userId,
        ],
      );
      reply.code(201);
      return { id: b.id };
    });
  });
}
export async function queueNotifications(c: PoolClient) {
  await c.query(
    "INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key) SELECT e.farm_id,m.user_id,'camera','camera_escalation',jsonb_build_object('title',a.name,'kind',e.kind,'source',e.source),'camera_event',e.id,'camera-escalated:'||e.id FROM camera_events e JOIN assets a ON a.id=e.asset_id JOIN memberships m ON m.farm_id=e.farm_id AND m.role IN ('owner','manager') WHERE e.acknowledged_at IS NULL AND e.received_at<now()-interval '5 minutes' AND e.expires_at>now() ON CONFLICT DO NOTHING",
  );
  await c.query(
    "INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key) SELECT t.farm_id,m.user_id,'task','task_due',jsonb_build_object('title',t.title),'task',t.id,'due:'||t.id||':'||t.version FROM tasks t JOIN memberships m ON m.farm_id=t.farm_id AND (m.user_id=t.assignee_id OR t.due_at<now()-interval '24 hours' AND m.role IN ('owner','manager')) WHERE t.due_at<=now() AND t.status NOT IN ('completed','cancelled') ON CONFLICT DO NOTHING",
  );
  await c.query(
    "INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key) SELECT t.farm_id,m.user_id,'maintenance','maintenance_due',jsonb_build_object('title',t.title),'maintenance',t.id,'maintenance:'||t.id FROM asset_maintenance t JOIN memberships m ON m.farm_id=t.farm_id AND (m.user_id=t.assignee_id OR m.role IN ('owner','manager')) WHERE t.due_at<=now() AND t.status='planned' ON CONFLICT DO NOTHING",
  );
  await c.query(
    "INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key) SELECT a.farm_id,m.user_id,'equipment','equipment_stale',jsonb_build_object('title',a.name),'asset',a.id,'stale:'||a.id||':'||a.last_observed_at FROM assets a JOIN memberships m ON m.farm_id=a.farm_id AND m.role IN ('owner','manager') WHERE a.integration_state LIKE 'verified-%' AND a.last_observed_at<now()-make_interval(secs=>a.stale_after_seconds) ON CONFLICT DO NOTHING",
  );
  await c.query(
    "INSERT INTO notification_deliveries(notification_id,channel_id) SELECT n.id,c.id FROM notifications n JOIN memberships m ON m.farm_id=n.farm_id AND m.user_id=n.user_id JOIN notification_channels c ON c.user_id=n.user_id JOIN notification_preferences p ON p.farm_id=n.farm_id AND p.user_id=n.user_id WHERE n.available_at<=now() AND n.created_at>now()-interval '24 hours' AND n.acknowledged_at IS NULL AND c.verified_at IS NOT NULL AND c.disabled_at IS NULL AND CASE c.channel WHEN 'push' THEN p.push WHEN 'email' THEN p.email ELSE p.sms END ON CONFLICT DO NOTHING",
  );
  await c.query(
    "UPDATE notification_deliveries SET state='unknown',last_error='worker_interrupted',updated_at=now() WHERE state='sending' AND started_at<now()-interval '2 minutes'",
  );
}
export async function deliverNotifications(db: Pool, max = 20) {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    const c = await db.connect();
    let r: any;
    let request: NotificationRequest;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL synchronous_commit=on");
      r = (
        await c.query(
          "SELECT d.*,n.farm_id,n.user_id,n.message_key,n.arguments,n.acknowledged_at,c.channel,c.address_cipher,c.address_hash,c.verified_at,c.disabled_at,c.user_id AS channel_user_id,u.language,f.timezone,p.quiet_start,p.quiet_end,CASE c.channel WHEN 'push' THEN p.push WHEN 'email' THEN p.email ELSE p.sms END AS opted_in,EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=n.farm_id AND m.user_id=n.user_id AND (n.kind<>'camera' OR EXISTS(SELECT 1 FROM camera_events e WHERE e.id=n.entity_id AND e.expires_at>now() AND (m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=e.asset_id AND ca.user_id=n.user_id))))) AS member FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN notification_channels c ON c.id=d.channel_id JOIN users u ON u.id=n.user_id JOIN farms f ON f.id=n.farm_id LEFT JOIN notification_preferences p ON p.farm_id=n.farm_id AND p.user_id=n.user_id WHERE d.state='pending' AND d.next_attempt_at<=now() ORDER BY d.next_attempt_at FOR UPDATE OF d SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (!r) {
        await c.query("COMMIT");
        break;
      }
      if (!r.member || !r.opted_in || !r.verified_at || r.disabled_at || r.acknowledged_at || r.channel_user_id !== r.user_id) {
        await c.query(
          "UPDATE notification_deliveries SET state='cancelled',updated_at=now() WHERE id=$1",
          [r.id],
        );
        await c.query("COMMIT");
        continue;
      }
      if (isQuiet(new Date(), r.timezone, r.quiet_start, r.quiet_end)) {
        await c.query(
          "UPDATE notification_deliveries SET next_attempt_at=now()+interval '5 minutes' WHERE id=$1",
          [r.id],
        );
        await c.query("COMMIT");
        continue;
      }
      try {
        if (r.request_cipher !== null) {
          request = restoreNotificationRequest(r);
        } else {
          // An old attempted delivery may already have been accepted. Its original
          // bytes cannot be recovered from today's environment or notification.
          if (r.attempts !== 0 || r.started_at !== null || r.provider_id !== null || r.last_error !== null)
            throw new NotificationRequestHold("notification_request_missing");
          const status = (providerStatus() as any)[r.channel];
          if (!status?.configured || status.mode === "simulated") {
            const simulated = status?.configured && status.mode === "simulated";
            await c.query(
              "UPDATE notification_deliveries SET state=$2,provider_id=$3,attempts=attempts+1,started_at=now(),updated_at=now() WHERE id=$1",
              [r.id, simulated ? "simulated" : "unconfigured", simulated ? "simulation:" + r.id : null],
            );
            await c.query("COMMIT");
            processed++;
            continue;
          }
          const address = openSecret(r.address_cipher, r.channel_id);
          if (digest(address) !== r.address_hash)
            throw new NotificationRequestHold("notification_recipient_changed");
          request = prepareNotificationRequest(r.channel, address, notificationText(r, r.language), r.id);
          r.request_cipher = sealNotificationRequest(request, r);
          r.request_body_hash = request.bodyHash;
          r.request_prepared_at = request.preparedAt;
        }
      } catch (error) {
        // Holds are terminal to automatic dispatch. Keep IDs, attempts and prior
        // receipts intact for protected operator/provider reconciliation.
        await c.query(
          "UPDATE notification_deliveries SET state='unknown',last_error=$2,updated_at=now() WHERE id=$1",
          [r.id, error instanceof NotificationRequestHold ? error.code : "notification_request_unreadable"],
        );
        await c.query("COMMIT");
        continue;
      }
      if ((await c.query("SHOW fsync")).rows[0].fsync !== "on")
        throw new ApiError("notification_durability_unavailable", 503);
      await c.query(
        "UPDATE notification_deliveries SET state='sending',attempts=attempts+1,started_at=now(),updated_at=now(),request_cipher=$2,request_body_hash=$3,request_prepared_at=$4 WHERE id=$1",
        [r.id, r.request_cipher, r.request_body_hash, r.request_prepared_at],
      );
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
    try {
      const result = await sendNotificationRequest(request);
      await db.query(
        "UPDATE notification_deliveries SET state=$2,provider_id=$3,last_error=$4,updated_at=now() WHERE id=$1",
        [r.id, result.state, result.providerId, result.error ?? null],
      );
      if (result.error === "device_not_registered")
        await db.query(
          "UPDATE notification_channels SET disabled_at=now() WHERE id=$1",
          [r.channel_id],
        );
    } catch (error) {
      const retry =
        (r.channel === "email" || r.channel === "sms") && r.attempts < 4;
      const known = (error as any).code === "provider_rate_limited";
      const hold = error instanceof NotificationRequestHold;
      const unknown = !known || r.last_error === "provider_outcome_unknown";
      await db.query(
        "UPDATE notification_deliveries SET state=$2,last_error=$3,next_attempt_at=now()+make_interval(secs=>$4),updated_at=now() WHERE id=$1",
        [
          r.id,
          !hold && (retry || known) && r.attempts < 5
            ? "pending"
            : unknown ? "unknown" : "failed",
          hold ? error.code : unknown ? "provider_outcome_unknown" : "provider_rate_limited",
          Math.min(3600, 60 * 2 ** r.attempts),
        ],
      );
    }
    processed++;
  }
  // Expo tickets indicate acceptance; receipts are checked after the documented waiting interval.
  const tickets = (
    await db.query(
      "SELECT d.id,d.provider_id,d.channel_id FROM notification_deliveries d JOIN notification_channels c ON c.id=d.channel_id WHERE d.state='accepted' AND c.channel='push' AND d.updated_at<now()-interval '15 minutes' LIMIT 100",
    )
  ).rows;
  if (tickets.length && process.env.NOTIFICATION_MODE === "live")
    try {
      const response = await fetchJson(
        safeEndpoint(
          process.env.EXPO_RECEIPTS_URL ||
            "https://exp.host/--/api/v2/push/getReceipts",
          true,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.EXPO_ACCESS_TOKEN
              ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({ ids: tickets.map((t) => t.provider_id) }),
        },
      );
      for (const t of tickets) {
        const receipt = response.data?.[t.provider_id];
        if (!receipt) continue;
        await db.query(
          "UPDATE notification_deliveries SET state=$2,last_error=$3,updated_at=now() WHERE id=$1",
          [
            t.id,
            receipt.status === "ok" ? "provider_delivered" : "failed",
            receipt.status === "ok" ? null : "provider_rejected",
          ],
        );
        if (receipt.details?.error === "DeviceNotRegistered")
          await db.query(
            "UPDATE notification_channels SET disabled_at=now() WHERE id=$1",
            [t.channel_id],
          );
      }
    } catch {
      /* Keep accepted status; retry the receipt lookup, never send again. */
    }
  return processed;
}
