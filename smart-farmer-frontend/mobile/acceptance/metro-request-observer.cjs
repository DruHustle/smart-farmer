'use strict';

// iOS CI diagnostics only. Observe public Node channels and numeric process
// timings without changing requests, Expo initialization, or acceptance limits.
function install() {
  const diagnostics = require('node:diagnostics_channel');
  const { writeSync } = require('node:fs');
  const { performance, PerformanceObserver } = require('node:perf_hooks');
  const paths = new Set(['/', '/status', '/index.bundle']);
  const responses = new Map();
  const pending = new Set();
  const requestLimit = 64;
  const eventLimit = 2048;
  const byteLimit = 256 * 1024;
  const gcSampleLimit = 8;
  let nextId = 0;
  let events = 0;
  let bytes = 0;
  let active = true;
  let heartbeat;
  let gcObserver;
  let gc = freshGc();

  function freshGc() {
    return { count: 0, duration: 0, first: Infinity, last: 0,
      omitted: 0, omittedFirst: Infinity, omittedLast: 0, samples: [] };
  }

  function collectGc(entries) {
    for (const entry of entries) {
      if (!active) break;
      gc.count++;
      gc.duration += entry.duration;
      gc.first = Math.min(gc.first, entry.startTime);
      gc.last = Math.max(gc.last, entry.startTime + entry.duration);
      gc.samples.push({ startMs: entry.startTime, durationMs: entry.duration,
        kind: entry.detail.kind, flags: entry.detail.flags });
      if (gc.samples.length > gcSampleLimit) {
        const omitted = gc.samples.shift();
        gc.omitted++;
        gc.omittedFirst = Math.min(gc.omittedFirst, omitted.startMs);
        gc.omittedLast = Math.max(gc.omittedLast, omitted.startMs + omitted.durationMs);
      }
    }
  }

  function stop() {
    active = false;
    try { if (heartbeat) clearInterval(heartbeat); } catch { /* Diagnostic cleanup only. */ }
    try { gcObserver?.disconnect(); } catch { /* Diagnostic cleanup only. */ }
    try { diagnostics.unsubscribe('http.server.request.start', onStart); } catch { /* Diagnostic cleanup only. */ }
    try { diagnostics.unsubscribe('http.server.response.finish', onFinish); } catch { /* Diagnostic cleanup only. */ }
    for (const [response, item] of responses) {
      try { response.removeListener('close', item.close); } catch { /* Our listener only. */ }
    }
    responses.clear();
    pending.clear();
    gc = freshGc();
  }

  function write(event, values) {
    try {
      if (!active) return false;
      if (event === 'heartbeat') {
        // intervalEndMs was sampled before the CPU/loop/GC reads. Keep that
        // admission timestamp unchanged and expose time spent before emission.
        // This interval excludes JSON serialization and the synchronous sink.
        const sampleStartedMs = values.intervalEndMs;
        const emissionStartedMs = performance.now();
        values = { ...values, sampleStartedMs, emissionStartedMs,
          collectionDurationMs: emissionStartedMs - sampleStartedMs };
      }
      const line = `[metro-http] ${JSON.stringify({
        event, pid: process.pid, time: new Date().toISOString(), ...values,
      })}\n`;
      const size = Buffer.byteLength(line);
      if (events >= eventLimit || bytes + size > byteLimit) {
        stop();
        return false;
      }
      events++;
      bytes += size;
      // Writable stream errors can be asynchronous and escape try/catch.
      writeSync(2, line);
      return true;
    } catch {
      stop();
      return false;
    }
  }

  function startHeartbeat() {
    if (heartbeat || !active) return;
    let previous = performance.now();
    let cpu = process.cpuUsage();
    let threadCpu = process.threadCpuUsage();
    let loop = performance.eventLoopUtilization();
    gcObserver = new PerformanceObserver(list => {
      try {
        collectGc(list.getEntries());
      } catch { stop(); }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
    heartbeat = setInterval(() => {
      try {
        if (!active) return;
        const now = performance.now();
        const usedCpu = process.cpuUsage(cpu);
        const usedThreadCpu = process.threadCpuUsage(threadCpu);
        const usedLoop = performance.eventLoopUtilization(loop);
        // Retain the actual API return objects for the next delta calculation.
        cpu = process.cpuUsage();
        threadCpu = process.threadCpuUsage();
        loop = performance.eventLoopUtilization();
        collectGc(gcObserver.takeRecords());
        // Delivery can lag the GC itself. Keep original timestamp bounds and a
        // small ring; neither the sum nor this delivery batch means pause time
        // in the heartbeat interval. Never write a line per GC during prewarm.
        const deliveredGc = gc;
        gc = freshGc();
        write('heartbeat', {
          pending: [...pending], delayMs: Math.max(0, Math.round(now - previous - 5000)),
          timeOriginMs: performance.timeOrigin, intervalStartMs: previous, intervalEndMs: now,
          cpuUserUs: usedCpu.user, cpuSystemUs: usedCpu.system,
          threadUserUs: usedThreadCpu.user, threadSystemUs: usedThreadCpu.system,
          loopActiveMs: usedLoop.active, loopIdleMs: usedLoop.idle,
          loopUtilization: usedLoop.utilization,
          gcDeliveredCount: deliveredGc.count, gcObservedDurationSumMs: deliveredGc.duration,
          gcSamples: deliveredGc.samples, gcOmittedCount: deliveredGc.omitted,
          ...(deliveredGc.count ? { gcFirstStartMs: deliveredGc.first, gcLastEndMs: deliveredGc.last } : {}),
          ...(deliveredGc.omitted ? { gcOmittedStartMs: deliveredGc.omittedFirst, gcOmittedEndMs: deliveredGc.omittedLast } : {}),
        });
        previous = now;
      } catch { stop(); }
    }, 5000).unref();
  }

  function responseState(response, item) {
    return {
      id: item.id, method: item.method, path: item.path,
      elapsedMs: Math.round(performance.now() - item.started),
      status: response.statusCode, headersSent: response.headersSent,
      ended: response.writableEnded, finished: response.writableFinished,
      destroyed: response.destroyed, errored: Boolean(response.errored),
    };
  }

  function onStart({ request, response, server }) {
    try {
      const address = server.address();
      if (!active || !address || typeof address !== 'object' || address.port !== 8081) return;
      if (request.method !== 'HEAD' && request.method !== 'GET') return;
      const path = request.url.split('?', 1)[0];
      if (!paths.has(path)) return;
      if (nextId >= requestLimit) { stop(); return; }
      startHeartbeat();
      const item = { id: ++nextId, method: request.method, path, started: performance.now() };
      item.close = () => {
        try {
          if (!active || !pending.delete(item.id)) return;
          responses.delete(response);
          write('response.close', responseState(response, item));
        } catch { stop(); }
      };
      responses.set(response, item);
      pending.add(item.id);
      if (write('request.start', { id: item.id, method: item.method, path: item.path })) {
        response.once('close', item.close);
      }
    } catch { stop(); }
  }

  function onFinish({ response }) {
    try {
      const item = responses.get(response);
      if (!active || !item) return;
      pending.delete(item.id);
      responses.delete(response);
      response.removeListener('close', item.close);
      write('response.finish', responseState(response, item));
    } catch { stop(); }
  }

  diagnostics.subscribe('http.server.request.start', onStart);
  diagnostics.subscribe('http.server.response.finish', onFinish);
}

if (process.env.CI === 'true' && process.env.NODE_ENV === 'test') {
  try { install(); } catch { /* Optional observations must never prevent startup. */ }
}
