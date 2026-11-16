import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRecorder, databaseProbe, exportDiagnostics, limit, observeApp, parseLine, recordError, responseClass, startHttpProbes } from "./diagnostics.mjs";

const at = 1794856118571;
const capture = () => {
  const lines = [];
  return { lines, record: createRecorder(line => lines.push(line), () => at) };
};

test("only closed diagnostic fields leave a private log", () => {
  const { lines, record } = capture();
  const secret = "private-credential-or-query";
  record("process", "portal", "started");
  record("process", "portal", secret);
  record("process", secret, "started");
  record(secret, "portal", "started");
  recordError(record, "authorize", { name: secret, code: secret, get message() { throw Error("must not read message"); }, stack: secret, detail: secret });
  recordError(record, "authorize", { name: "Error", code: "57014" });
  assert.equal(lines.length, 5);
  assert(lines.every(line => parseLine(line) === line));
  assert(!lines.join("\n").includes(secret));
  assert.equal(parseLine(lines[0] + " " + secret), null);
  assert.equal(parseLine(lines[0].replace("started", "https://private.invalid")), null);
  assert.equal(parseLine(lines[0].replace(String(at), "1")), null);
  assert.equal(responseClass(500), "http-5xx");
  assert.equal(responseClass(303), "http-3xx");
});

test("producer and exported evidence are bounded and reject arbitrary appended input", async () => {
  const { lines, record } = capture();
  for (let i = 0; i < limit + 5; i++) record("process", "fixture", "alive");
  assert.equal(lines.length, limit);
  const dir = mkdtempSync(join(tmpdir(), "farmer-diagnostic-test-"));
  try {
    const source = join(dir, "private.log"), output = join(dir, "safe.txt");
    writeFileSync(source, "private-token\n" + lines.join("\n") + "\n" + lines[0] + " private-token\n" + lines[0] + "\n");
    assert.equal(await exportDiagnostics(source, output), limit);
    assert.equal(readFileSync(output, "utf8"), lines.join("\n") + "\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a delayed DB health query cannot accumulate concurrent probes", async () => {
  const { lines, record } = capture();
  let finish, calls = 0;
  const probe = databaseProbe({ query: async query => {
    calls++;
    assert.deepEqual(query, { text: "SELECT 1", query_timeout: 3000 });
    return new Promise(resolve => { finish = resolve; });
  } }, "portal", record);
  const first = probe();
  await probe();
  assert.equal(calls, 1);
  assert(lines.some(line => line.includes("db-health portal pending")));
  finish();
  await first;
  assert(lines.some(line => line.includes("db-health portal ok")));
});

test("DB failure emits only a finite class and the next probe can recover", async () => {
  const { lines, record } = capture();
  let failed = true;
  const probe = databaseProbe({ query: async () => {
    if (failed) throw Object.assign(new Error("private database, SQL and credential"), { code: "ECONNREFUSED" });
  } }, "farmer", record);
  await probe();
  failed = false;
  await probe();
  assert(lines.some(line => line.includes("error-code farmer-db ECONNREFUSED")));
  assert(lines.at(-1).includes("db-health farmer ok"));
  assert(!lines.join("\n").includes("private"));
});

test("authorization error classification survives the provider raw URL rewrite without reading inputs", async () => {
  const { lines, record } = capture();
  const hooks = {};
  const app = { addHook: (name, handler) => { hooks[name] = handler; } };
  observeApp(app, { query: async () => {} }, "portal", record);
  try {
    const request = { url: "/api/v1/identity/auth?state=private-value", get body() { throw Error("must not read body"); } };
    await hooks.onRequest(request);
    request.url = "/auth?state=private-value";
    await hooks.onError(request, {}, Object.assign(new Error("private failure detail"), { code: "57014" }));
    await hooks.onError({ url: "/other" }, {}, new Error("private unrelated error"));
    assert.equal(lines.filter(line => line.includes("error-code authorize 57014")).length, 1);
    assert(!lines.join("\n").includes("private"));
  } finally { await hooks.onClose(); }
});

test("HTTP health probes stay on fixed loopback endpoints and do not read response bodies", async () => {
  const { lines, record } = capture();
  const requested = [];
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const stop = startHttpProbes(record, async (url, options) => {
    requested.push(url);
    assert.equal(options.redirect, "error");
    assert(options.signal instanceof AbortSignal);
    if (requested.length === 2) finish();
    if (url.endsWith("/api/v1/health")) throw Object.assign(new Error("private transport data"), { name: "TimeoutError" });
    return { ok: true, body: { cancel: async () => {} }, get text() { throw Error("must not read response"); } };
  });
  try {
    await complete;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requested.sort(), ["http://127.0.0.1:46504/health", "http://127.0.0.1:46506/api/v1/health"]);
    assert(lines.some(line => line.includes("http-health portal timeout")));
    assert(lines.some(line => line.includes("http-health farmer ok")));
    assert(!lines.join("\n").includes("private"));
  } finally { stop(); }
});
