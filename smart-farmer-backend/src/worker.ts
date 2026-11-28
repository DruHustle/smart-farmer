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

import { evaluateMonitoringRules } from "./monitoring/rules.js";
import { refreshDueWeather } from "./monitoring/weather.js";

type StepFailure = { step: string; error: string; code?: string };

// Failure logs carry the step and error class only: messages and row payloads
// can contain farm records, which do not belong in worker logs.
function recordFailure(failures: StepFailure[], step: string, error: unknown) {
  const e = error as { name?: unknown; code?: unknown } | null;
  const failure: StepFailure = {
    step,
    error: typeof e?.name === "string" ? e.name : "Error",
    ...(typeof e?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? { code: e.code } : {}),
  };
  failures.push(failure);
  console.error(JSON.stringify({ event: "maintenance_step_failed", ...failure }));
}

export async function runMaintenance(db: Pool) {
  const client = await db.connect();
  const failures: StepFailure[] = [];
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
    // Each step runs in its own savepoint, so one failing step is rolled back
    // and reported without blocking the others or the heartbeat.
    const step = async <T>(name: string, action: () => Promise<T>): Promise<T | null> => {
      await client.query("SAVEPOINT maintenance_step");
      try {
        const value = await action();
        await client.query("RELEASE SAVEPOINT maintenance_step");
        return value;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT maintenance_step");
        recordFailure(failures, name, error);
        return null;
      }
    };
    const commands = await step("expire_commands", () => expireCommands(client));
    const commerce = await step("product_maintenance", () => runProductMaintenance(client));
    const monitoring = await step("evaluate_monitoring", () => evaluateMonitoringRules(client));
    await step("queue_notifications", () => queueNotifications(client));
    const retention = await step("retire_expired_objects", () => retireExpiredObjects(client));
    const cameras = await step("expire_camera_events", async () =>
      (await client.query("DELETE FROM camera_events WHERE expires_at<=now()")).rowCount ?? 0);
    const sessions = await step("expire_sessions", async () =>
      (await client.query("DELETE FROM sessions WHERE expires_at<=now()")).rowCount ?? 0);
    details = {
      commerce,
      monitoring,
      retention,
      expiredCommands: commands,
      expiredCameraEvents: cameras,
      expiredSessions: sessions,
      ...(failures.length ? { failedSteps: failures.map((f) => f.step) } : {}),
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
  const outside = async <T>(name: string, action: () => Promise<T>): Promise<T | null> => {
    try {
      return await action();
    } catch (error) {
      recordFailure(failures, name, error);
      return null;
    }
  };
  const weather = await outside("refresh_weather", () => refreshDueWeather(db));
  const notifications = await outside("deliver_notifications", () => deliverNotifications(db));
  const orphanObjects = await outside("reconcile_orphan_objects", () => reconcileOrphanObjects(db));
  const removedObjects = await outside("collect_garbage", () => collectGarbage(db));
  const accountingScan = await outside("process_accounting_document", () => processAccountingDocument(db));
  return {
    ...details,
    notifications,
    weather,
    orphanObjects,
    removedObjects,
    accountingScan,
    ...(failures.length ? { failedSteps: failures.map((f) => f.step) } : {}),
  };
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
      } catch (error) {
        const e = error as { name?: unknown; code?: unknown } | null;
        console.error(JSON.stringify({
          event: "maintenance_failed",
          error: typeof e?.name === "string" ? e.name : "Error",
          ...(typeof e?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? { code: e.code } : {}),
        }));
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
