'use strict';

// Loaded only by the iOS acceptance API process. Observe public Node/Fastify
// channels without wrapping handlers, consuming bodies, or changing deadlines.
if (process.env.CI === 'true' && process.env.NODE_ENV === 'test') {
  const diagnostics = require('node:diagnostics_channel');
  const { writeSync } = require('node:fs');
  const { performance } = require('node:perf_hooks');
  const requests = new WeakMap();
  const responses = new WeakMap();
  const pending = new Set();
  const maxRequests = 64;
  const maxEvents = 2048;
  const maxBytes = 256 * 1024;
  let nextId = 0;
  let events = 0;
  let bytes = 0;
  let stopped = false;

  function write(event, values = {}) {
    if (stopped) return;
    try {
      const prefix = '[native-api] ';
      const time = new Date().toISOString();
      const line = `${prefix}${JSON.stringify({ event, time, ...values })}\n`;
      const size = Buffer.byteLength(line);
      if (events >= maxEvents - 1 || bytes + size > maxBytes - 512) {
        stopped = true;
        writeSync(2, `${prefix}${JSON.stringify({ event: 'observer.limit', time })}\n`);
        return;
      }
      events += 1;
      bytes += size;
      writeSync(2, line);
    } catch {
      // A diagnostic exception must never escape into the server.
    }
  }

  function subscribe(name, observe) {
    diagnostics.subscribe(name, value => {
      try {
        if (!stopped) observe(value);
      } catch {
        // Node propagates subscriber exceptions; isolate only the observer.
      }
    });
  }

  function state(response, item) {
    return {
      id: item.id, elapsedMs: Math.round(performance.now() - item.started),
      status: response.headersSent ? response.statusCode : null,
      headersSent: response.headersSent, ended: response.writableEnded,
      finished: response.writableFinished, destroyed: response.destroyed,
      errored: Boolean(response.errored),
    };
  }

  subscribe('http.server.request.start', ({ request, response, server }) => {
    const address = server.address();
    if (!address || typeof address !== 'object' || address.port !== 3000) return;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return;
    if (request.method !== 'POST' || request.url.split('?', 1)[0] !== '/v1/sessions') return;
    if (nextId >= maxRequests) return;
    const item = { id: ++nextId, started: performance.now(), handlerError: false };
    requests.set(request, item);
    responses.set(response, item);
    pending.add(item.id);
    write('request.start', { id: item.id, method: 'POST', path: '/v1/sessions' });
    request.once('end', () => {
      try {
        write('request.end', { id: item.id, complete: request.complete,
          elapsedMs: Math.round(performance.now() - item.started) });
      } catch { /* Do not read the body or alter stream flow. */ }
    });
    response.once('close', () => {
      try {
        if (!pending.delete(item.id)) return;
        write('response.close', state(response, item));
      } catch { /* Do not add an error listener or suppress server errors. */ }
    });
  });

  subscribe('http.server.response.finish', ({ response }) => {
    const item = responses.get(response);
    if (!item) return;
    pending.delete(item.id);
    write('response.finish', state(response, item));
  });

  for (const [channel, event] of [
    ['start', 'handler.enter'],
    ['end', 'handler.sync_return'],
    ['asyncStart', 'handler.promise_settled'],
    ['asyncEnd', 'handler.reply_dispatch_return'],
    ['error', 'handler.error'],
  ]) {
    subscribe(`tracing:fastify.request.handler:${channel}`, value => {
      const item = requests.get(value.request.raw);
      if (!item) return;
      if (channel === 'error') item.handlerError = true;
      // Fastify's end is synchronous; asyncStart follows Promise settlement.
      // reply_dispatch_return does not claim network response completion.
      write(event, { id: item.id, async: value.async === true,
        errorObserved: item.handlerError,
        elapsedMs: Math.round(performance.now() - item.started) });
    });
  }

  write('observer.ready', { requestLimit: maxRequests, eventLimit: maxEvents, byteLimit: maxBytes });
  let previous = performance.now();
  setInterval(() => {
    try {
      if (stopped) return;
      const now = performance.now();
      write('heartbeat', { pending: [...pending], delayMs: Math.max(0, Math.round(now - previous - 5000)) });
      previous = now;
    } catch { /* The unref'd observer must not change service lifetime. */ }
  }, 5000).unref();
}
