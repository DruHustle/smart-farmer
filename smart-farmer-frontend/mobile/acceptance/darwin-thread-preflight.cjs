'use strict';

// Optional acceptance instrumentation. A successful same-runner preflight is
// required before this module is added to Metro's original NODE_OPTIONS.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync, fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const digit = /^(0|[1-9][0-9]{0,19})$/;
const identityKeys = ['pid', 'uid', 'startSeconds', 'startMicros', 'threadId'];
const reasons = new Set(['ready', 'invalid_input', 'identity_mismatch', 'process_unavailable',
  'thread_unavailable', 'clock_unavailable', 'state_unavailable']);

function identity(value) {
  if (!value || value.reason !== 'ready' || Object.keys(value).sort().join() !== [...identityKeys, 'reason'].sort().join()) throw Error('identity_unavailable');
  for (const key of identityKeys) if (typeof value[key] !== 'string' || !digit.test(value[key]) || BigInt(value[key]) > 0xffffffffffffffffn) throw Error('identity_unavailable');
  if (BigInt(value.pid) <= 1n || BigInt(value.pid) > 2147483647n || BigInt(value.uid) > 4294967295n
    || BigInt(value.startSeconds) === 0n || BigInt(value.startMicros) >= 1000000n || BigInt(value.threadId) === 0n) throw Error('identity_unavailable');
  return value;
}

function sample(line) {
  if (line.length > 1024) throw Error('reader_protocol');
  const value = JSON.parse(line);
  if (!value || !reasons.has(value.reason)) throw Error('reader_protocol');
  if (value.reason !== 'ready') {
    if (Object.keys(value).join() !== 'reason') throw Error('reader_protocol');
    return value;
  }
  const keys = ['reason', 'index', 'state', 'wallMs', 'wallEndMs', 'monotonicNs', 'queryNs', 'userNs', 'systemNs', 'readerCpuNs'];
  if (Object.keys(value).sort().join() !== keys.sort().join() || !Number.isInteger(value.index)
    || value.index < 0 || value.index >= 20 || !Number.isInteger(value.state) || value.state < 1 || value.state > 5
    || !Number.isFinite(value.wallMs) || value.wallMs <= 0 || !Number.isFinite(value.wallEndMs)
    || value.wallEndMs < value.wallMs) throw Error('reader_protocol');
  for (const key of ['monotonicNs', 'queryNs', 'userNs', 'systemNs', 'readerCpuNs']) {
    if (typeof value[key] !== 'string' || !digit.test(value[key]) || BigInt(value[key]) > 0xffffffffffffffffn) throw Error('reader_protocol');
  }
  return value;
}

function privateFile(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('private_file_unavailable');
  return file;
}

function context() {
  if (process.platform !== 'darwin' || process.env.CI !== 'true' || process.env.NODE_ENV !== 'test') throw Error('unsupported_context');
  if (!process.env.RUNNER_TEMP || !path.isAbsolute(process.env.RUNNER_TEMP)) throw Error('private_directory_unavailable');
  const root = path.join(fs.realpathSync(process.env.RUNNER_TEMP), 'farmer-darwin-thread');
  return { root, bridge: path.join(root, 'identity.node'), reader: path.join(root, 'reader'),
    proof: path.join(root, 'qualified.json'), target: path.join(root, 'target.json'), stop: path.join(root, 'stop'),
    evidence: path.join(fs.realpathSync(process.env.RUNNER_TEMP), 'native-evidence') };
}

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function binding(ctx) {
  return { version: process.version, arch: process.arch, uid: process.getuid(),
    source: hash(path.join(__dirname, 'darwin-thread-probe.c')), preflight: hash(__filename),
    watcher: hash(path.join(__dirname, 'darwin-thread-watch.cjs')), preload: hash(path.join(__dirname, 'darwin-thread-preload.cjs')),
    bridge: hash(privateFile(ctx.bridge)), reader: hash(privateFile(ctx.reader)) };
}

function qualified() {
  const ctx = context();
  const info = fs.lstatSync(ctx.root);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('private_directory_unavailable');
  const proof = JSON.parse(fs.readFileSync(privateFile(ctx.proof), 'utf8'));
  if (proof.qualified !== true || JSON.stringify(proof.binding) !== JSON.stringify(binding(ctx))) throw Error('preflight_unavailable');
  return ctx;
}

// The observed PID is only an argument to a public read. Child cancellation
// always uses this newly spawned helper object, never the observed PID.
function releaseOwnedHandles(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) { try { stream?.destroy(); } catch {} }
  try { if (child.connected) child.disconnect(); } catch {}
  try { child.unref(); } catch {}
}

function terminateOwnedControl(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    releaseOwnedHandles(child);
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    let finished = false, force, final;
    const unavailable = () => {};
    const finish = confirmed => {
      if (finished) return;
      finished = true; clearTimeout(force); clearTimeout(final);
      child.off('exit', exited); releaseOwnedHandles(child); resolve(confirmed);
    };
    const exited = () => finish(true);
    child.on('error', unavailable);
    child.once('exit', exited);
    try { child.kill('SIGTERM'); } catch {}
    force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 300);
    final = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), 600);
  });
}

function reader(ctx, target, mode = 'once', onSample = () => {}) {
  identity(target);
  if (!['once', 'observe'].includes(mode)) throw Error('reader_protocol');
  const child = spawn(ctx.reader, [mode, ...identityKeys.map(key => target[key])], { stdio: ['pipe', 'pipe', 'ignore'] });
  const started = performance.now();
  const values = [];
  let buffer = '', bytes = 0, issue, settled = false, stopping = false, firstSampleMs;
  let termination, force, final, finish;
  const stop = () => {
    if (settled || stopping) return;
    stopping = true;
    child.stdin.end();
    termination = setTimeout(() => child.kill('SIGTERM'), 300);
    force = setTimeout(() => child.kill('SIGKILL'), 600);
    final = setTimeout(() => finish('reader_cleanup_timeout', false), 900);
  };
  const deadline = setTimeout(() => { issue = 'reader_timeout'; stop(); }, 2800);
  const done = new Promise(resolve => {
    finish = (forcedIssue, cleanupConfirmed = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(termination); clearTimeout(force); clearTimeout(final);
      if (forcedIssue) issue = forcedIssue;
      releaseOwnedHandles(child);
      resolve({ values, issue, elapsedMs: performance.now() - started, firstSampleMs, cleanupConfirmed });
    };
    child.stdin.on('error', () => {});
    child.on('error', () => { issue = 'reader_unavailable'; });
    child.stdout.on('data', chunk => {
      if (settled) return;
      try {
        bytes += chunk.length;
        if (bytes > 16 * 1024) throw Error('reader_protocol');
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const value = sample(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (values.length >= 20 || (value.reason === 'ready' && value.index !== values.length)) throw Error('reader_protocol');
          values.push(value);
          firstSampleMs ??= performance.now() - started;
          onSample(value, performance.now());
        }
      } catch { issue = 'reader_protocol'; stop(); }
    });
    child.on('close', (code, signal) => {
      if (!issue && (buffer || code !== 0 || signal)) issue = buffer ? 'reader_protocol' : 'reader_unavailable';
      finish();
    });
  });
  if (mode === 'once') child.stdin.end();
  return { done, stop, child };
}

function message(child, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('control_timeout')), timeout);
    const receive = value => { if (value?.event === event) finish(null, value); };
    const exit = () => finish(Error('control_unavailable'));
    function finish(error, value) { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); error ? reject(error) : resolve(value); }
    child.on('message', receive); child.once('exit', exit);
  });
}

async function control() {
  // This disposable target is separate from Metro and exists only in preflight.
  const bridge = require(process.argv[3]);
  const { Worker } = require('node:worker_threads');
  const workerReason = await new Promise((resolve, reject) => {
    const worker = new Worker('const { parentPort, workerData } = require("node:worker_threads"); parentPort.postMessage(require(workerData).identity().reason);',
      { eval: true, workerData: process.argv[3] });
    let result;
    worker.on('message', value => { result = value; });
    worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve(result) : reject(Error('worker_unavailable')));
  });
  process.send({ event: 'identity', identity: bridge.identity(), workerReason });
  process.on('message', value => {
    if (value?.event === 'exit') { process.disconnect(); return; }
    if (value?.event === 'ping') { process.send({ event: 'pong' }); return; }
    if (!['compute', 'wait'].includes(value?.event)) return;
    const phase = value.event;
    process.send({ event: 'begin', phase, wallMs: Date.now() }, () => {
      const cpu = process.threadCpuUsage(), started = performance.now();
      if (phase === 'compute') { while (performance.now() - started < 900) Math.sqrt(performance.now()); }
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
      const used = process.threadCpuUsage(cpu);
      process.send({ event: 'end', phase, wallMs: Date.now(), cpuUs: used.user + used.system });
    });
  });
}

async function prepare() {
  const started = performance.now();
  const result = { event: 'preflight', qualified: false, reason: 'unavailable' };
  let ctx, child;
  try {
    ctx = context();
    // Do not reuse a prior run's binary, identity, proof or directory.
    fs.mkdirSync(ctx.root, { mode: 0o700 });
    const nodeRoot = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
    const headers = path.join(nodeRoot, 'include', 'node');
    if (!fs.statSync(path.join(headers, 'node_api.h')).isFile()) throw Error('headers_unavailable');
    const source = path.join(__dirname, 'darwin-thread-probe.c');
    for (const args of [
      ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-DNODE_IDENTITY_BRIDGE', '-DNODE_GYP_MODULE_NAME=darwin_thread_identity', '-bundle', '-undefined', 'dynamic_lookup', '-I', headers, source, '-lproc', '-o', ctx.bridge],
      ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-lproc', '-o', ctx.reader],
    ]) {
      const build = spawnSync('/usr/bin/xcrun', args, { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
      if (build.error || build.status !== 0 || build.signal) throw Error('compile_unavailable');
    }
    fs.chmodSync(ctx.bridge, 0o600); fs.chmodSync(ctx.reader, 0o700);
    child = fork(__filename, ['control', ctx.bridge], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = await message(child, 'identity');
    const target = identity(ready.identity);
    if (Number(target.pid) !== child.pid || Number(target.uid) !== process.getuid() || ready.workerReason !== 'not_main_thread') throw Error('identity_control_failed');
    const self = identity(require(ctx.bridge).identity());
    const invalid = [
      { ...target, startMicros: ((BigInt(target.startMicros) + 1n) % 1000000n).toString() },
      { ...target, uid: (BigInt(target.uid) + 1n).toString() },
      { ...self, threadId: target.threadId },
    ];
    for (const wrong of invalid) {
      const read = await reader(ctx, wrong).done;
      if (read.issue || read.values.length !== 1 || !['identity_mismatch', 'thread_unavailable'].includes(read.values[0].reason)) throw Error('refusal_control_failed');
    }
    const phases = {};
    for (const phase of ['compute', 'wait']) {
      const begin = message(child, 'begin'), end = message(child, 'end');
      end.catch(() => {}); // Its refusal remains awaited below; do not leak a second rejection on early cleanup.
      child.send({ event: phase });
      const first = await begin;
      const probe = reader(ctx, target, 'observe');
      const last = await end;
      probe.stop();
      const read = await probe.done;
      if (read.issue || read.values.some(value => value.reason !== 'ready')) throw Error('access_control_failed');
      const captured = read.values.filter(value => value.wallMs >= first.wallMs && value.wallEndMs <= last.wallMs);
      if (captured.length < 3) throw Error('late_control');
      phases[phase] = { captured, cpuUs: last.cpuUs, firstSampleMs: read.firstSampleMs };
    }
    const compute = phases.compute, wait = phases.wait;
    const running = compute.captured.filter(value => value.state === 1).length;
    const waiting = wait.captured.filter(value => value.state === 3 || value.state === 4).length;
    const samples = [...compute.captured, ...wait.captured];
    const maxQueryMs = Math.max(...samples.map(value => Number(BigInt(value.queryNs)) / 1e6));
    const maxFirstSampleMs = Math.max(compute.firstSampleMs, wait.firstSampleMs);
    const readerCpuMs = Math.max(...samples.map(value => Number(BigInt(value.readerCpuNs)) / 1e6));
    const sampledCpuUs = values => Number(BigInt(values.at(-1).userNs) + BigInt(values.at(-1).systemNs)
      - BigInt(values[0].userNs) - BigInt(values[0].systemNs)) / 1000;
    const computeSampledCpuUs = sampledCpuUs(compute.captured), waitSampledCpuUs = sampledCpuUs(wait.captured);
    if (running < 2 || waiting < 2 || compute.cpuUs <= wait.cpuUs || computeSampledCpuUs <= waitSampledCpuUs
      || waitSampledCpuUs < 0 || computeSampledCpuUs > compute.cpuUs + 10000
      || maxQueryMs > 10 || maxFirstSampleMs > 250 || readerCpuMs > 20) throw Error('state_control_unavailable');
    // Force termination of this disposable reader, then prove its target still responds.
    let firstRead;
    const received = new Promise(resolve => { firstRead = resolve; });
    const cancellable = reader(ctx, target, 'observe', firstRead);
    await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(Error('cleanup_control_failed')), 2000))]);
    const cleanupStarted = performance.now();
    cancellable.child.kill('SIGTERM');
    const cancelled = await cancellable.done;
    if (!cancelled.issue || !cancelled.cleanupConfirmed) throw Error('cleanup_control_failed');
    const ping = message(child, 'pong'); child.send({ event: 'ping' }); await ping;
    const cleanupMs = performance.now() - cleanupStarted;
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.send({ event: 'exit' });
    const exit = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error('cleanup_control_failed')), 2000))]);
    if (exit.code !== 0 || exit.signal) throw Error('cleanup_control_failed');
    child = undefined;
    const afterExit = await reader(ctx, target).done;
    if (afterExit.issue || afterExit.values.length !== 1 || afterExit.values[0].reason !== 'process_unavailable') throw Error('exit_control_failed');
    Object.assign(result, { qualified: true, reason: 'ready', runningSamples: running, waitingSamples: waiting,
      computeCpuUs: compute.cpuUs, waitCpuUs: wait.cpuUs, queryCount: samples.length, maxQueryMs, cleanupMs });
    Object.assign(result, { computeSampledCpuUs, waitSampledCpuUs, maxFirstSampleMs, readerCpuMs });
    fs.writeFileSync(ctx.proof, JSON.stringify({ qualified: true, binding: binding(ctx) }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const finite = new Set(['unsupported_context', 'headers_unavailable', 'compile_unavailable', 'identity_control_failed',
      'refusal_control_failed', 'access_control_failed', 'late_control', 'state_control_unavailable', 'cleanup_control_failed',
      'exit_control_failed', 'control_timeout', 'control_unavailable', 'identity_unavailable']);
    result.qualified = false;
    result.reason = finite.has(error.message) ? error.message : 'unavailable';
    try { if (ctx) fs.rmSync(ctx.proof, { force: true }); } catch { /* Optional diagnostics only. */ }
  } finally {
    if (child && !(await terminateOwnedControl(child))) {
      result.qualified = false; result.reason = 'cleanup_control_failed';
      try { if (ctx) fs.rmSync(ctx.proof, { force: true }); } catch {}
    }
  }
  result.durationMs = performance.now() - started;
  return result;
}

function installIdentity() {
  try {
    const ctx = qualified();
    const diagnostics = require('node:diagnostics_channel');
    const onRequest = ({ server }) => {
      try {
        const address = server.address();
        if (!address || typeof address !== 'object' || address.port !== 8081) return;
        diagnostics.unsubscribe('http.server.request.start', onRequest);
        const target = identity(require(ctx.bridge).identity());
        if (Number(target.pid) !== process.pid || Number(target.uid) !== process.getuid()) return;
        fs.writeFileSync(ctx.target, JSON.stringify(target), { mode: 0o600, flag: 'wx' });
      } catch { try { diagnostics.unsubscribe('http.server.request.start', onRequest); } catch {} }
    };
    diagnostics.subscribe('http.server.request.start', onRequest);
  } catch { /* An unavailable diagnostic must not affect Metro. */ }
}

module.exports = { identity, sample, reader, context, qualified, privateFile, prepare, installIdentity, terminateOwnedControl };
if (require.main === module) {
  if (process.argv[2] === 'control') control().catch(() => { process.exitCode = 1; });
  else if (process.argv[2] === 'prepare') prepare().then(result => {
    try { fs.writeSync(1, `${JSON.stringify(result)}\n`); } catch { result.qualified = false; }
    process.exitCode = result.qualified ? 0 : 1;
  });
  else process.exitCode = 1;
}
