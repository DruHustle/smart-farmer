import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit, type Context } from "../context.js";
import { getObjectStore } from "../integrations/object-store.js";
import { storageUsage, storageQuota } from "../integrations/storage-quota.js";
import { authorize, settings } from "./common.js";
export function registerRetention(app: FastifyInstance, ctx: Context) {
  app.get("/v1/farms/:farmId/media-policy", async (req, reply) => {
    const a = await authorize(ctx, req, reply);
    if (!a) return;
    const f = (
      await ctx.db.query("SELECT * FROM farms WHERE id=$1", [a.farmId])
    ).rows[0];
    const usage = await storageUsage(ctx.db, a.farmId);
    return {
      retentionDays: settings(f).mediaRetentionDays,
      quotaBytes: storageQuota("field"),
      usedBytes: usage.media,
      pendingDeletionBytes: usage.pendingMedia,
      cameraQuotaBytes: storageQuota("camera"),
      cameraUsedBytes: usage.camera,
      cameraPendingDeletionBytes: usage.pendingCamera,
      provider: getObjectStore().kind,
    };
  });
  app.patch("/v1/farms/:farmId/media-policy", async (req, reply) => {
    const a = await authorize(ctx, req, reply, ["owner"]);
    if (!a) return;
    const b = z
      .object({
        retentionDays: z.number().int().min(30).max(36500).nullable(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return ctx.transaction(async (c) => {
      const f = (
          await c.query("SELECT * FROM farms WHERE id=$1 FOR UPDATE", [
            a.farmId,
          ])
        ).rows[0],
        next = {
          ...f.operations_settings,
          mediaRetentionDays: b.retentionDays,
        };
      await c.query("UPDATE farms SET operations_settings=$2 WHERE id=$1", [
        a.farmId,
        next,
      ]);
      await audit(
        c,
        a.farmId,
        a.userId,
        "farm",
        a.farmId,
        "retention_changed",
        "owner_confirmation",
        { retentionDays: settings(f).mediaRetentionDays },
        b,
      );
      return { retentionDays: b.retentionDays };
    });
  });
  app.get("/v1/farms/:farmId/operations-health", async (req, reply) => {
    const a = await authorize(ctx, req, reply, ["owner", "manager"]);
    if (!a) return;
    return {
      worker:
        (
          await ctx.db.query(
            "SELECT name,last_seen_at,last_seen_at>now()-interval '2 minutes' AS healthy FROM worker_heartbeats WHERE name='maintenance'",
          )
        ).rows[0] ?? null,
      backups: (
        await ctx.db.query(
          "SELECT id,started_at,completed_at,status,verified,error_code FROM backup_runs ORDER BY started_at DESC LIMIT 5",
        )
      ).rows,
      garbage: (
        await ctx.db.query(
          "SELECT count(*)::integer AS pending,COALESCE(max(attempts),0) AS max_attempts FROM object_garbage WHERE farm_id=$1 AND deleted_at IS NULL",
          [a.farmId],
        )
      ).rows[0],
    };
  });
}
/** Exclusive snapshot lock coordinates metadata retirement with backups. */
export async function retireExpiredObjects(c: PoolClient) {
  if (
    !(await c.query("SELECT pg_try_advisory_xact_lock(928175) AS locked"))
      .rows[0].locked
  )
    return { skipped: true };
  const expired = (
    await c.query(
      "DELETE FROM camera_segments WHERE expires_at<=now() RETURNING farm_id,object_key,size_bytes",
    )
  ).rows;
  const snapshots = (
    await c.query(
      "DELETE FROM camera_snapshots s USING camera_configurations conf WHERE s.asset_id=conf.asset_id AND s.observed_at<now()-make_interval(days=>conf.retention_days) RETURNING s.farm_id,s.object_key,s.size_bytes",
    )
  ).rows;
  for (const r of [...expired, ...snapshots])
    await c.query(
      "INSERT INTO object_garbage(object_key,farm_id,reason,size_bytes,media_kind) VALUES($1,$2,'camera_retention',$3,'camera') ON CONFLICT DO NOTHING",
      [r.object_key, r.farm_id, r.size_bytes],
    );
  const media = (
    await c.query(
      "DELETE FROM private_media m USING farms f WHERE m.farm_id=f.id AND (f.operations_settings->>'mediaRetentionDays') IS NOT NULL AND m.created_at<now()-make_interval(days=>(f.operations_settings->>'mediaRetentionDays')::integer) AND NOT EXISTS(SELECT 1 FROM market_listings l WHERE l.farm_id=m.farm_id AND m.id=ANY(l.photo_media_ids)) RETURNING m.*",
    )
  ).rows;
  for (const r of media) {
    await c.query(
      "INSERT INTO media_retirement(id,farm_id,content_hash,object_key,reason) VALUES($1,$2,$3,$4,'configured_retention')",
      [r.id, r.farm_id, r.content_hash, r.object_key],
    );
    await c.query(
      "INSERT INTO object_garbage(object_key,farm_id,reason,size_bytes,media_kind) VALUES($1,$2,'configured_retention',$3,'field') ON CONFLICT DO NOTHING",
      [r.object_key, r.farm_id, r.size_bytes],
    );
  }
  await c.query("DELETE FROM camera_sessions WHERE expires_at<=now()");
  await c.query(
    "UPDATE notification_deliveries SET state='unknown',last_error='receipt_expired',updated_at=now() WHERE state='accepted' AND updated_at<now()-interval '24 hours'",
  );
  return {
    cameraObjects: expired.length + snapshots.length,
    mediaObjects: media.length,
  };
}
/** Only journalled keys, after rechecking all references while holding the farm lock. */
export async function collectGarbage(db: Pool, max = 20) {
  let removed = 0;
  for (let i = 0; i < max; i++) {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      if (
        !(
          await c.query(
            "SELECT pg_try_advisory_xact_lock_shared(928175) AS locked",
          )
        ).rows[0].locked
      ) {
        await c.query("ROLLBACK");
        break;
      }
      const r = (
        await c.query(
          "SELECT * FROM object_garbage WHERE deleted_at IS NULL AND eligible_at<=now() ORDER BY eligible_at FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (!r) {
        await c.query("COMMIT");
        break;
      }
      await c.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [r.farm_id]);
      const referenced = (
        await c.query(
          "SELECT 1 FROM private_media WHERE object_key=$1 UNION ALL SELECT 1 FROM camera_segments WHERE object_key=$1 UNION ALL SELECT 1 FROM camera_snapshots WHERE object_key=$1 LIMIT 1",
          [r.object_key],
        )
      ).rowCount;
      if (referenced) {
        await c.query("DELETE FROM object_garbage WHERE object_key=$1", [
          r.object_key,
        ]);
      } else
        try {
          await getObjectStore().delete(r.object_key);
          await c.query(
            "UPDATE object_garbage SET deleted_at=now(),attempts=attempts+1 WHERE object_key=$1",
            [r.object_key],
          );
          removed++;
        } catch {
          await c.query(
            "UPDATE object_garbage SET attempts=attempts+1,eligible_at=now()+interval '1 hour' WHERE object_key=$1",
            [r.object_key],
          );
        }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  return removed;
}

/** Bounded, infrequent reconciliation also finds objects left by interrupted transactions. */
export async function reconcileOrphanObjects(db: Pool) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    if (
      !(
        await c.query(
          "SELECT pg_try_advisory_xact_lock_shared(928175) AS locked",
        )
      ).rows[0].locked
    ) {
      await c.query("ROLLBACK");
      return 0;
    }
    await c.query(
      "INSERT INTO storage_scan_cursors(farm_id) SELECT id FROM farms ON CONFLICT DO NOTHING",
    );
    const scan = (
      await c.query(
        "SELECT * FROM storage_scan_cursors WHERE next_scan_at<=now() ORDER BY next_scan_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!scan) {
      await c.query("COMMIT");
      return 0;
    }
    await c.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [
      scan.farm_id,
    ]);
    const page = await getObjectStore().list(
      scan.farm_id,
      scan.cursor ?? undefined,
    );
    let queued = 0;
    for (const object of page.items) {
      if (object.modifiedAt.getTime() > Date.now() - 86400000) continue;
      const referenced = (
        await c.query(
          "SELECT 1 FROM private_media WHERE object_key=$1 UNION ALL SELECT 1 FROM camera_segments WHERE object_key=$1 UNION ALL SELECT 1 FROM camera_snapshots WHERE object_key=$1 LIMIT 1",
          [object.key],
        )
      ).rowCount;
      if (!referenced) {
        await c.query(
          "INSERT INTO object_garbage(object_key,farm_id,reason,size_bytes) VALUES($1,$2,'unreferenced_after_grace',$3) ON CONFLICT DO NOTHING",
          [object.key, scan.farm_id, object.size],
        );
        queued++;
      }
    }
    await c.query(
      "UPDATE storage_scan_cursors SET cursor=$2,next_scan_at=now()+make_interval(secs=>$3) WHERE farm_id=$1",
      [scan.farm_id, page.nextCursor, page.nextCursor ? 60 : 3600],
    );
    await c.query("COMMIT");
    return queued;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
