'use strict';

// iOS CI diagnostics only. Observe Node's public HTTP channels without changing
// handlers, requests, responses, timeouts, or Expo's module initialization.
const diagnostics = require('node:diagnostics_channel');
const { performance } = require('node:perf_hooks');

const paths = new Set(['/', '/status', '/index.bundle']);
const responses = new WeakMap();
const pending = new Set();
let nextId = 0;
let heartbeatStarted = false;

function write(event, values) {
  try {
    process.stderr.write(`[metro-http] ${JSON.stringify({
      event, pid: process.pid, time: new Date().toISOString(), ...values,
    })}\n`);
  } catch {
    // An observer failure must not change the server's behavior.
  }
}

function startHeartbeat() {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  let previous = performance.now();
  setInterval(() => {
    const now = performance.now();
    write('heartbeat', {
      pending: [...pending], delayMs: Math.max(0, Math.round(now - previous - 5000)),
    });
    previous = now;
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

diagnostics.subscribe('http.server.request.start', ({ request, response, server }) => {
  try {
    const address = server.address();
    if (!address || typeof address !== 'object' || address.port !== 8081) return;
    if (request.method !== 'HEAD' && request.method !== 'GET') return;
    const path = request.url.split('?', 1)[0];
    if (!paths.has(path)) return;
    const item = { id: ++nextId, method: request.method, path, started: performance.now() };
    responses.set(response, item);
    pending.add(item.id);
    startHeartbeat();
    write('request.start', { id: item.id, method: item.method, path: item.path });
    response.once('close', () => {
      try {
        if (!pending.delete(item.id)) return;
        write('response.close', responseState(response, item));
      } catch {
        // Do not attach an error listener or suppress the server's own errors.
      }
    });
  } catch {
    // Node propagates subscriber exceptions; diagnostic failures stay isolated.
  }
});

diagnostics.subscribe('http.server.response.finish', ({ response }) => {
  try {
    const item = responses.get(response);
    if (!item) return;
    pending.delete(item.id);
    write('response.finish', responseState(response, item));
  } catch {
    // Only observer work is guarded; request handling is never wrapped.
  }
});
