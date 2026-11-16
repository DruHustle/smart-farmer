// Test-fixture telemetry only. Never serialize errors, requests, SQL or inputs.
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const limit = 1024;
const roles = ["fixture", "portal", "farmer"];
const errorScopes = ["authorize", "portal-db", "farmer-db", "portal-proxy", "farmer-proxy"];
const names = ["Error", "error", "TypeError", "RangeError", "TimeoutError", "AbortError", "FastifyError", "DatabaseError"];
const codes = ["57014", "53300", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08006", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOSPC", "ENOMEM"];
const schema = {
  process: [roles, ["started", "listening", "ready", "alive", "stopping", "exit-ok", "exit-error", "exit-signal"]],
  request: [["authorize"], ["proxy-start", "api-start", "http-2xx", "http-3xx", "http-4xx", "http-5xx", "other"]],
  "http-health": [["portal", "farmer"], ["ok", "non-ok", "timeout", "unavailable"]],
  "db-health": [["portal", "farmer"], ["ok", "pending", "error"]],
  "error-name": [errorScopes, [...names, "other"]],
  "error-code": [errorScopes, [...codes, "none", "other"]],
};

function valid(kind, scope, value) {
  return Object.hasOwn(schema, kind) && schema[kind][0].includes(scope) && schema[kind][1].includes(value);
}

export function createRecorder(write = console.log, now = Date.now) {
  let count = 0;
  return (kind, scope, value) => {
    if (count >= limit || !valid(kind, scope, value)) return;
    const at = now();
    if (!Number.isSafeInteger(at) || !/^\d{13}$/.test(String(at))) return;
    count++;
    write(`ONESA_DEVICE_DIAGNOSTIC ${kind} ${scope} ${value} ${at}`);
  };
}

export function recordError(record, scope, error) {
  // Read only classification fields, never message/stack/detail/query/body.
  const name = error?.name;
  const code = error?.code;
  record("error-name", scope, names.includes(name) ? name : "other");
  record("error-code", scope, code == null ? "none" : codes.includes(code) ? code : "other");
}

export function responseClass(status) {
  return Number.isInteger(status) && status >= 200 && status <= 599
    ? `http-${Math.floor(status / 100)}xx` : "other";
}

export function observeApp(app, database, role, record = createRecorder()) {
  const authorizations = new WeakSet();
  app.addHook("onRequest", async (request) => {
    if (role === "portal" && request.url.split("?", 1)[0] === "/api/v1/identity/auth") {
      authorizations.add(request);
      record("request", "authorize", "api-start");
    }
  });
  app.addHook("onError", async (request, _reply, error) => {
    if (authorizations.has(request)) recordError(record, "authorize", error);
  });
  const probe = databaseProbe(database, role, record);
  const timer = setInterval(() => { void probe(); }, 30000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); });
  void probe();
}

export function databaseProbe(database, role, record) {
  let pending = false;
  return async () => {
    if (pending) { record("db-health", role, "pending"); return; }
    pending = true;
    try {
      // Independent, read-only diagnostic query. Product request deadlines stay unchanged.
      await database.query({ text: "SELECT 1", query_timeout: 3000 });
      record("db-health", role, "ok");
    } catch (error) {
      record("db-health", role, "error");
      recordError(record, `${role}-db`, error);
    } finally { pending = false; }
  };
}

export function startHttpProbes(record, fetcher = fetch) {
  let pending = false;
  const sample = async () => {
    if (pending) return;
    pending = true;
    record("process", "fixture", "alive");
    try {
      await Promise.all([
        ["portal", "http://127.0.0.1:46506/api/v1/health"],
        ["farmer", "http://127.0.0.1:46504/health"],
      ].map(async ([role, url]) => {
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
          record("http-health", role, response.ok ? "ok" : "non-ok");
          try { await response.body?.cancel(); } catch { /* disposal is not a second health result */ }
        } catch (error) {
          record("http-health", role, error?.name === "TimeoutError" ? "timeout" : "unavailable");
        }
      }));
    } finally { pending = false; }
  };
  const timer = setInterval(() => { void sample(); }, 30000);
  timer.unref();
  void sample();
  return () => { clearInterval(timer); };
}

export function parseLine(line) {
  if (line.length > 160) return null;
  const match = /^ONESA_DEVICE_DIAGNOSTIC ([a-z-]+) ([a-z-]+) ([A-Za-z0-9-]+) (\d{13})$/.exec(line);
  if (!match || !valid(match[1], match[2], match[3])) return null;
  return line;
}

export async function exportDiagnostics(source, destination) {
  const selected = [];
  const input = createReadStream(source, { end: 4 * 1024 * 1024 - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const safe = parseLine(line);
      if (safe) selected.push(safe);
      if (selected.length === limit) break;
    }
  } finally { lines.close(); input.destroy(); }
  writeFileSync(destination, selected.join("\n") + (selected.length ? "\n" : ""), { mode: 0o600 });
  return selected.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Supply private fixture log and sanitized output paths");
  await exportDiagnostics(process.argv[2], process.argv[3]);
}
