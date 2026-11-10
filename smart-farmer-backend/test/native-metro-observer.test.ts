import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const observer = fileURLToPath(new URL('../../smart-farmer-frontend/mobile/acceptance/metro-request-observer.cjs', import.meta.url));
const prefix = '[metro-http] ';
const fixture = String.raw`
const { createServer, request } = require('node:http');
const { createHash } = require('node:crypto');
const diagnostics = require('node:diagnostics_channel');
const { performance } = require('node:perf_hooks');
if (process.env.OBSERVER_TEST_BROKEN_SINK === '1') {
  const { closeSync, openSync } = require('node:fs');
  closeSync(2);
  if (openSync('/dev/null', 'r') !== 2) throw new Error('diagnostic-descriptor-not-reserved');
}
const digest = value => createHash('sha256').update(value).digest('hex');
let abortEntered, abortClosed, releaseAbort;
const entered = new Promise(resolve => { abortEntered = resolve; });
const closed = new Promise(resolve => { abortClosed = resolve; });
const heldAbort = new Promise(resolve => { releaseAbort = resolve; });
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const mode = new URL(req.url, 'http://localhost').searchParams.get('mode');
  if (mode === 'abort') {
    res.once('close', abortClosed);
    abortEntered();
    await heldAbort;
  }
  if (mode === 'held') await new Promise(resolve => setTimeout(resolve, 5300));
  res.writeHead(mode === 'error' ? 418 : 200, {
    'content-type': 'application/json', 'x-fixture': 'header-secret-sentinel',
  });
  res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), ok: mode !== 'error' }));
});
function send(mode, onRequest, path = '/', method = 'GET') {
  return new Promise((resolve, reject) => {
    const body = 'body-secret-sentinel';
    const req = request({ host: '127.0.0.1', port: 8081, agent: false, method,
      path: path + '?mode=' + mode + '&private=query-secret-sentinel',
      headers: { authorization: 'Bearer header-secret-sentinel', cookie: 'header-secret-sentinel',
        'content-length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode,
        body: digest(Buffer.concat(chunks)), headers: digest(JSON.stringify({
          contentType: res.headers['content-type'], fixture: res.headers['x-fixture'],
        })) }));
    });
    req.once('error', reject);
    if (onRequest) onRequest(req);
    req.end(body);
  });
}
(async () => {
  await new Promise(resolve => server.listen(8081, '127.0.0.1', resolve));
  try {
    const results = [await send('ok'), await send('error'), await send('ok', undefined, '/status', 'HEAD')];
    let cancel;
    const aborted = send('abort', req => { cancel = () => req.destroy(); })
      .then(() => ({ aborted: false }), error => ({ aborted: true, code: error.code }));
    await entered;
    cancel();
    results.push(await aborted);
    await closed;
    releaseAbort();
    let workload;
    if (process.env.OBSERVER_TEST_WORKLOAD === '1') {
      const start = performance.now();
      const cpu = process.threadCpuUsage();
      // Stop by actual CPU consumed, not a timing-sensitive wall-time ratio.
      while (true) {
        const used = process.threadCpuUsage(cpu);
        if (used.user + used.system >= 40000) break;
        if (performance.now() - start > 5000) throw new Error('CPU fixture unavailable');
      }
      const nonCpuStart = performance.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      const nonCpuEnd = performance.now();
      const gcStart = performance.now();
      // More collections than the bounded observation ring: test omission,
      // without relying on automatic GC timing or a performance ratio.
      for (let index = 0; index < 16; index++) global.gc();
      const gcEnd = performance.now();
      workload = { start, nonCpuStart, nonCpuEnd, gcStart, gcEnd };
    }
    results.push(await send('held', undefined, '/index.bundle'));
    const ignored = [await send('ok', undefined, '/other'), await send('ok', undefined, '/', 'POST')];
    for (let index = 0; index < 70; index++) {
      if (JSON.stringify(await send('ok')) !== JSON.stringify(results[0])) throw new Error('response-changed');
    }
    console.log(JSON.stringify({ results, ignored, extraRequests: 70, workload,
      requestSubscriber: diagnostics.hasSubscribers('http.server.request.start'),
      finishSubscriber: diagnostics.hasSubscribers('http.server.response.finish') }));
  } finally {
    releaseAbort();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(() => { process.exitCode = 1; });
`;

function run(ci: boolean, options: { brokenSink?: boolean; workload?: boolean; nodeEnv?: string } = {}) {
  const child = spawnSync(process.execPath, ['--expose-gc', '--require', observer, '--input-type=commonjs', '--eval', fixture], {
    env: { ...process.env, CI: ci ? 'true' : 'false', NODE_ENV: options.nodeEnv ?? 'test',
      OBSERVER_TEST_BROKEN_SINK: options.brokenSink ? '1' : '0', OBSERVER_TEST_WORKLOAD: options.workload ? '1' : '0' },
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, 'observer must permit natural exit');
  assert.equal(child.status, 0, 'real HTTP fixture must finish successfully');
  return { result: JSON.parse(child.stdout), log: child.stderr };
}

function parse(log: string) {
  assert.ok(Buffer.byteLength(log) <= 256 * 1024);
  const events = log.trim().split('\n').map(line => {
    assert.ok(line.startsWith(prefix));
    return JSON.parse(line.slice(prefix.length));
  });
  assert.ok(events.length <= 2048);
  for (const secret of ['body-secret-sentinel', 'header-secret-sentinel', 'query-secret-sentinel']) {
    assert.equal(log.includes(secret), false, 'private sentinel must never enter diagnostics');
  }
  const allowed = new Set(['event', 'pid', 'time', 'id', 'method', 'path', 'elapsedMs', 'status',
    'headersSent', 'ended', 'finished', 'destroyed', 'errored', 'pending', 'delayMs', 'timeOriginMs',
    'intervalStartMs', 'intervalEndMs', 'sampleStartedMs', 'emissionStartedMs', 'collectionDurationMs',
    'cpuUserUs', 'cpuSystemUs', 'threadUserUs', 'threadSystemUs',
    'loopActiveMs', 'loopIdleMs', 'loopUtilization', 'gcDeliveredCount', 'gcObservedDurationSumMs',
    'gcSamples', 'gcOmittedCount', 'gcFirstStartMs', 'gcLastEndMs', 'gcOmittedStartMs', 'gcOmittedEndMs']);
  assert.ok(events.every(event => Object.keys(event).every(key => allowed.has(key))));
  return events;
}

test('Metro observations preserve real HTTP, abort, body, lifetime and broken-sink behavior', () => {
  const baseline = run(false);
  const observed = run(true);
  const broken = run(true, { brokenSink: true });
  const nonTest = run(true, { nodeEnv: 'production' });
  assert.deepEqual(observed.result, baseline.result);
  assert.deepEqual(broken.result, baseline.result);
  assert.deepEqual(nonTest.result, baseline.result);
  assert.equal(baseline.log, '');
  assert.equal(nonTest.log, '', 'both CI and test activation are required');
  assert.equal(broken.log, '', 'a real unwritable fd2 must not emit an asynchronous stream error');
  assert.deepEqual(observed.result.results.map((value: { status?: number; aborted?: boolean }) => value.status ?? value.aborted), [200, 418, 200, true, 200]);
  assert.equal(observed.result.results[3].code, 'ECONNRESET');
  assert.equal(observed.result.requestSubscriber, false, 'request cap removes only our subscriptions');
  assert.equal(observed.result.finishSubscriber, false);
  const events = parse(observed.log);
  const starts = events.filter(event => event.event === 'request.start');
  assert.equal(starts.length, 64, 'later requests still work after bounded observation ends');
  assert.ok(starts.every(event => ['/', '/status', '/index.bundle'].includes(event.path) && ['GET', 'HEAD'].includes(event.method)));
  assert.ok(events.some(event => event.id === 2 && event.event === 'response.finish' && event.status === 418));
  assert.ok(events.some(event => event.id === 4 && event.event === 'response.close' && !event.headersSent && !event.finished));
  assert.ok(events.some(event => event.event === 'heartbeat' && event.pending.includes(5)));
});

test('Metro observes real CPU, synchronous waiting and GC without claiming a stall cause', () => {
  const observed = run(true, { workload: true });
  const events = parse(observed.log);
  const beats = events.filter(event => event.event === 'heartbeat');
  assert.ok(beats.length > 0);
  const fields = ['timeOriginMs', 'intervalStartMs', 'intervalEndMs', 'sampleStartedMs', 'emissionStartedMs',
    'collectionDurationMs', 'delayMs', 'cpuUserUs', 'cpuSystemUs',
    'threadUserUs', 'threadSystemUs', 'loopActiveMs', 'loopIdleMs', 'loopUtilization'];
  assert.ok(beats.every(event => fields.every(key => Number.isFinite(event[key]) && event[key] >= 0)));
  assert.ok(beats.every(event => event.intervalEndMs > event.intervalStartMs && event.loopUtilization <= 1));
  assert.ok(beats.every(event => event.sampleStartedMs === event.intervalEndMs
    && event.emissionStartedMs >= event.sampleStartedMs
    && event.collectionDurationMs === event.emissionStartedMs - event.sampleStartedMs));
  assert.ok(beats.reduce((sum, event) => sum + event.threadUserUs + event.threadSystemUs, 0) >= 40000,
    'the observed thread counters include the deliberately consumed CPU time');
  const workload = observed.result.workload;
  assert.ok(workload.nonCpuEnd - workload.nonCpuStart >= 75, 'the fixture actually performed a synchronous wait');
  assert.ok(beats.reduce((sum, event) => sum + event.loopActiveMs, 0) >= 75,
    'event-loop active time includes synchronous waiting and is not labeled CPU usage');
  assert.equal(events.some(event => event.event === 'gc'), false, 'GC never creates a synchronous log per collection');
  assert.ok(beats.reduce((sum, event) => sum + event.gcDeliveredCount, 0) >= 16);
  assert.ok(beats.some(event => event.gcOmittedCount > 0), 'real collections exceed the bounded ring');
  for (const beat of beats) {
    assert.equal(beat.gcDeliveredCount, beat.gcSamples.length + beat.gcOmittedCount);
    assert.ok(beat.gcSamples.length <= 8);
    assert.ok(Number.isFinite(beat.gcObservedDurationSumMs) && beat.gcObservedDurationSumMs >= 0);
    for (const entry of beat.gcSamples) {
      assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'flags', 'kind', 'startMs']);
      assert.ok(Object.values(entry).every(value => Number.isFinite(value) && Number(value) >= 0));
      assert.ok(entry.startMs >= beat.gcFirstStartMs && entry.startMs + entry.durationMs <= beat.gcLastEndMs);
    }
    if (beat.gcOmittedCount) {
      assert.ok(beat.gcOmittedStartMs >= beat.gcFirstStartMs);
      assert.ok(beat.gcOmittedEndMs >= beat.gcOmittedStartMs && beat.gcOmittedEndMs <= beat.gcLastEndMs);
    }
  }
  assert.ok(beats.some(beat => beat.gcSamples.some((entry: { startMs: number }) =>
    entry.startMs >= workload.gcStart && entry.startMs <= workload.gcEnd)));
});

test('heartbeat timing distinguishes delayed collection from delayed callback entry without moving the sample', () => {
  function heartbeatTiming(callbackDelayMs: number, collectionDelayMs: number) {
    const timeOriginMs = Date.parse('2026-11-08T00:00:00.000Z');
    let mono = 100, collect = false;
    let tick: (() => void) | undefined;
    const subscribers = new Map<string, (event: unknown) => void>();
    const lines: string[] = [];
    const diagnostics = {
      subscribe: (name: string, handler: (event: unknown) => void) => subscribers.set(name, handler),
      unsubscribe: (name: string) => subscribers.delete(name),
    };
    const cpuUsage = () => {
      if (collect) { mono += collectionDelayMs; collect = false; }
      return { user: 10, system: 5 };
    };
    const perf = {
      performance: { now: () => mono, timeOrigin: timeOriginMs,
        eventLoopUtilization: () => ({ active: 0, idle: 5000, utilization: 0 }) },
      PerformanceObserver: class {
        observe() {} disconnect() {} takeRecords() { return []; }
      },
    };
    runInNewContext(readFileSync(observer, 'utf8'), {
      require(name: string) {
        if (name === 'node:diagnostics_channel') return diagnostics;
        if (name === 'node:fs') return { writeSync: (_fd: number, line: string) => lines.push(line) };
        if (name === 'node:perf_hooks') return perf;
        throw Error('unexpected-observer-dependency');
      },
      process: { env: { CI: 'true', NODE_ENV: 'test' }, pid: 123, cpuUsage,
        threadCpuUsage: () => ({ user: 5, system: 1 }) },
      Date: class extends Date { constructor() { super(timeOriginMs + mono); } },
      Buffer,
      setInterval(callback: () => void, interval: number) {
        assert.equal(interval, 5000);
        tick = callback;
        return { unref() { return this; } };
      },
      clearInterval() {},
    });
    subscribers.get('http.server.request.start')!({ request: { method: 'HEAD', url: '/' },
      response: { once() {}, removeListener() {} }, server: { address: () => ({ port: 8081 }) } });
    assert.ok(tick);
    mono += 5000 + callbackDelayMs;
    collect = true;
    tick();
    const beat = parse(lines.join('')).find(event => event.event === 'heartbeat');
    assert.ok(beat);
    return beat;
  }

  const collecting = heartbeatTiming(0, 1250);
  assert.equal(collecting.intervalStartMs, 100);
  assert.equal(collecting.intervalEndMs, 5100, 'collection must not rewrite the original interval sample');
  assert.equal(collecting.delayMs, 0);
  assert.equal(collecting.sampleStartedMs, 5100);
  assert.equal(collecting.emissionStartedMs, 6350);
  assert.equal(collecting.collectionDurationMs, 1250);
  assert.equal(Date.parse(collecting.time) - collecting.timeOriginMs - collecting.intervalEndMs, 1250,
    'the existing timestamp discrepancy remains visible to fail-closed heartbeat admission');

  const callback = heartbeatTiming(1250, 0);
  assert.equal(callback.intervalEndMs, 6350);
  assert.equal(callback.delayMs, 1250);
  assert.equal(callback.sampleStartedMs, callback.emissionStartedMs);
  assert.equal(callback.collectionDurationMs, 0);
});
