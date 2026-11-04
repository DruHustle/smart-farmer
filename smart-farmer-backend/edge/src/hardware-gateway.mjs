import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTransport, validateConfig } from "./transports.mjs";
const base = new URL(process.env.API_URL || "http://127.0.0.1:3000");
if (
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash ||
  (base.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      base.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(base.hostname)
    ))
)
  throw new Error("A secure API origin is required");
const credential = process.env.ASSET_GATEWAY_TOKEN;
if (!/^[A-Za-z0-9_-]{43}$/.test(credential ?? ""))
  throw new Error("Owner-issued asset credential required");
if (!process.env.GATEWAY_CONFIG)
  throw new Error("Approved GATEWAY_CONFIG file required");
const config = validateConfig(
    JSON.parse(await readFile(process.env.GATEWAY_CONFIG, "utf8")),
  ),
  directory = resolve(process.env.GATEWAY_STATE_DIR || ".data/hardware");
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = resolve(directory, "state.json");
let state = {
  version: 1,
  configurationHash: config.configurationHash,
  executions: [],
  buffer: [],
  dropped: 0,
};
try {
  const old = JSON.parse(await readFile(path, "utf8"));
  if (
    old.version !== 1 ||
    old.configurationHash !== config.configurationHash ||
    !Array.isArray(old.executions) ||
    !Array.isArray(old.buffer)
  )
    throw new Error(
      "State configuration changed; archive and recommission explicitly",
    );
  state = old;
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
async function save() {
  const tmp = path + "." + randomUUID();
  const f = await open(tmp, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(state));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(tmp, path);
}
async function post(path, body) {
  const r = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + credential,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!r.ok) {
    const e = new Error("API rejected request");
    e.status = r.status;
    throw e;
  }
  return r.json();
}
let stop = false,
  transport;
process.on("SIGTERM", () => {
  stop = true;
});
process.on("SIGINT", () => {
  stop = true;
});
while (!stop) {
  try {
    transport ??= await createTransport(config);
    const observation = await transport.read();
    const values = observation.values;
    if (
      typeof values.running !== "boolean" ||
      typeof values.interlock_ok !== "boolean"
    )
      throw new Error("Boolean running/interlock feedback is required");
    const entries = [
      {
        path: "/v1/edge/telemetry",
        body: {
          id: randomUUID(),
          observedAt: observation.observedAt,
          configurationHash: config.configurationHash,
          measurements: {
            running: values.running,
            interlock_ok: values.interlock_ok,
          },
        },
      },
      ...config.telemetry
        .filter((m) => values[m.name] !== undefined)
        .map((m) => ({
          path: "/v1/edge/observations",
          body: {
            id: randomUUID(),
            measurement: m.name,
            value: values[m.name],
            unit: m.unit,
            observedAt: observation.observedAt,
            quality: "good",
            configurationHash: config.configurationHash,
          },
        })),
    ];
    state.buffer.push(...entries);
    if (state.buffer.length > 10000) {
      state.dropped += state.buffer.length - 10000;
      state.buffer = state.buffer.slice(-10000);
    }
    await save();
    while (state.buffer.length && !stop) {
      const e = state.buffer[0];
      await post(e.path, e.body);
      state.buffer.shift();
      await save();
    }
    if (stop) break;
    const { command } = await post("/v1/edge/commands/next", {});
    if (command) {
      let result = {
        status: "rejected",
        reason: "expired_unapproved_or_duplicate",
      };
      if (
        command.configurationHash === config.configurationHash &&
        Date.parse(command.expiresAt) > Date.now() + 500 &&
        !state.executions.includes(command.id) &&
        config.commands.some((c) => c.name === command.command)
      ) {
        const feedback = await transport.read();
        if (
          command.command === "stop" ||
          feedback.values.interlock_ok === true
        ) {
          await post(`/v1/edge/commands/${command.id}/result`, {
            status: "acknowledged",
          });
          const checked = await transport.read();
          if (
            Date.parse(command.expiresAt) > Date.now() + 500 &&
            (command.command === "stop" || checked.values.interlock_ok === true)
          ) {
            // Persist intent before any write. A crash or uncertain response must never replay control.
            state.executions.push(command.id);
            state.executions = state.executions.slice(-10000);
            await save();
            try {
              await transport.write(
                command.command,
                command.id,
                command.expiresAt,
              );
              const final = await transport.read();
              result =
                final.values.running === (command.command === "start") &&
                (command.command === "stop" ||
                  final.values.interlock_ok === true)
                  ? {
                      status: "confirmed",
                      feedback: {
                        running: final.values.running,
                        interlock_ok: final.values.interlock_ok,
                      },
                    }
                  : { status: "failed", reason: "feedback_not_confirmed" };
            } catch {
              result = {
                status: "outcome_unknown",
                reason: "device_outcome_unknown",
              };
            }
          } else
            result = { status: "rejected", reason: "expired_or_interlocked" };
        } else result = { status: "rejected", reason: "interlock_open" };
      }
      await post(`/v1/edge/commands/${command.id}/result`, result);
    }
    console.log(
      JSON.stringify({
        event: "hardware_synced",
        protocol: config.protocol,
        pending: state.buffer.length,
        dropped: state.dropped,
      }),
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "hardware_sync_failed",
        httpStatus: e.status ?? null,
        pending: state.buffer.length,
      }),
    );
    if (e.status === 401 || e.status === 409) {
      stop = true;
      process.exitCode = 1;
    }
    await transport?.close().catch(() => {});
    transport = undefined;
  }
  if (!stop)
    await delay(Math.max(1000, Math.min(60000, config.pollMs ?? 5000)));
}
await transport?.close().catch(() => {});
await save();
