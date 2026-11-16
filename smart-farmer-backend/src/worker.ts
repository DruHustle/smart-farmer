import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runProductMaintenance } from "./product.js";
import {
  queueNotifications,
  deliverNotifications,
} from "./operations/notifications.js";
import {
  retireExpiredObjects,
  collectGarbage,
  reconcileOrphanObjects,
} from "./operations/retention.js";
import { expireCommands } from "./integrations/equipment.js";
import { processAccountingDocument } from "./accounting/documents.js";

export async function runMaintenance(db: Pool) {
  const client = await db.connect();
  let details;
  try {
    await client.query("BEGIN");
    const acquired = (
      await client.query("SELECT pg_try_advisory_xact_lock(928174) AS acquired")
    ).rows[0].acquired;
    if (!acquired) {
      await client.query("ROLLBACK");
      return { skipped: true };
    }
    const commands = await expireCommands(client);
    const commerce = await runProductMaintenance(client);
    await queueNotifications(client);
    const retention = await retireExpiredObjects(client);
    const cameras =
      (await client.query("DELETE FROM camera_events WHERE expires_at<=now()"))
        .rowCount ?? 0;
    const sessions =
      (await client.query("DELETE FROM sessions WHERE expires_at<=now()"))
        .rowCount ?? 0;
    details = {
      commerce,
      retention,
      expiredCommands: commands,
      expiredCameraEvents: cameras,
      expiredSessions: sessions,
    };
    await client.query(
      "INSERT INTO worker_heartbeats(name,last_seen_at,details) VALUES('maintenance',now(),$1) ON CONFLICT(name) DO UPDATE SET last_seen_at=excluded.last_seen_at,details=excluded.details",
      [details],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const notifications = await deliverNotifications(db);
  const orphanObjects = await reconcileOrphanObjects(db);
  const removedObjects = await collectGarbage(db);
  const accountingScan = await processAccountingDocument(db);
  return { ...details, notifications, orphanObjects, removedObjects, accountingScan };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { databaseConfigured, pool } = await import("./db.js");
  if (!databaseConfigured())
    throw new Error("Database connection configuration is required");
  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => {
    stopping = true;
    shutdown.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    while (!stopping) {
      try {
        console.log(
          JSON.stringify({
            event: "maintenance_complete",
            ...(await runMaintenance(pool)),
          }),
        );
      } catch {
        console.error(JSON.stringify({ event: "maintenance_failed" }));
      }
      if (!stopping)
        await delay(15000, undefined, { signal: shutdown.signal }).catch(
          (error) => {
            if (error.name !== "AbortError") throw error;
          },
        );
    }
  } finally {
    await pool.end();
  }
}
