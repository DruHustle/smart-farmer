'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const probe = require('./darwin-thread-preflight.cjs');
const states = ['unknown', 'running_or_runnable', 'stopped', 'waiting', 'uninterruptible', 'halted'];
const scopes = new Set(['ios-phone', 'ios-tablet']);

function launchMilestone(line) {
  // Match the existing simulator event, not its URI, preference object or payload.
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{6})\+0000\s+localhost SmartFarmer\[[1-9][0-9]*\]: \(CoreFoundation\) \[com\.apple\.defaults:User Defaults\] setting new value .{1,2048} for key -initialUrl in CFPrefsSource</.exec(line);
  if (!match) return undefined;
  const epoch = Date.parse(`${match[1]}T${match[2]}Z`) + Number(match[3]) / 1000;
  if (!Number.isFinite(epoch)) throw Error('milestone_unavailable');
  return epoch;
}

class Tail {
  constructor(file, fromEnd = false) {
    this.file = file;
    this.fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    this.original = fs.fstatSync(this.fd);
    this.offset = fromEnd ? this.original.size : 0; this.total = 0; this.partial = '';
    if (!this.original.isFile() || this.original.uid !== process.getuid()) { this.close(); throw Error('log_unavailable'); }
  }
  read() {
    const current = fs.lstatSync(this.file), opened = fs.fstatSync(this.fd);
    if (!current.isFile() || current.ino !== this.original.ino || current.dev !== this.original.dev
      || opened.ino !== current.ino || opened.size < this.offset) throw Error('log_changed');
    if (opened.size - this.offset > 512 * 1024 || this.total > 8 * 1024 * 1024) throw Error('log_backlog');
    const buffer = Buffer.alloc(Math.min(64 * 1024, opened.size - this.offset));
    const count = fs.readSync(this.fd, buffer, 0, buffer.length, this.offset);
    this.offset += count; this.total += count;
    this.partial += buffer.subarray(0, count).toString('utf8');
    const lines = this.partial.split('\n'); this.partial = lines.pop();
    if (this.partial.length > 8192 || lines.some(line => line.length > 8192)) throw Error('log_format_unavailable');
    return lines;
  }
  close() { if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; } }
}

class Window {
  constructor(pid, wall, mono) {
    this.pid = pid; this.startedWall = wall; this.startedMono = mono;
    this.previousMono = mono; this.beat = undefined; this.launch = undefined;
    this.trigger = undefined; this.recovery = undefined; this.entry = undefined;
    this.reason = undefined; this.samples = [];
    this.prelaunchHeartbeatResets = 0;
    this.resetHeartbeat = undefined;
    this.freshHeartbeatRequired = false;
  }
  clock(wall, mono) {
    if (Math.abs((wall - this.startedWall) - (mono - this.startedMono)) > 250) this.reason = 'clock_changed';
    if (this.launch && mono - this.previousMono > 500) this.reason = 'helper_late';
    this.previousMono = mono;
  }
  native(line, wall, mono) {
    const event = launchMilestone(line);
    if (event === undefined) return;
    if (this.launch) { this.reason = 'multiple_launches'; return; }
    this.launch = { eventWallMs: event, readWallMs: wall, readMonoMs: mono,
      readDelayMs: wall - event };
    if (event < this.startedWall - 50 || wall - event < -50 || wall - event > 1000) this.reason = 'late_milestone';
    // Native delivery may lag behind Metro delivery. A recovered baseline
    // cannot make a reset within the actual launch window safe to observe.
    if (this.resetHeartbeat && event <= this.resetHeartbeat.wall) this.reason = 'heartbeat_launch_overlap';
  }
  metro(line) {
    if (!line.startsWith('[metro-http] ')) return;
    let event;
    try { event = JSON.parse(line.slice(13)); } catch { throw Error('log_format_unavailable'); }
    if (event.pid !== this.pid) return;
    const wall = Date.parse(event.time);
    if (!Number.isFinite(wall)) throw Error('log_format_unavailable');
    if (event.event === 'heartbeat') {
      if (!Number.isFinite(event.timeOriginMs) || !Number.isFinite(event.intervalEndMs)) throw Error('log_format_unavailable');
      if (this.beat !== undefined && wall < this.beat) throw Error('log_changed');
      if (Math.abs(wall - event.timeOriginMs - event.intervalEndMs) > 1000) {
        // One prelaunch emission may be delayed after its monotonic sample.
        // Discard that baseline, never its uncertainty: a later valid heartbeat
        // from the same process clock is required before observation can arm.
        // The active launch window and a second mismatch remain fail-closed;
        // native() also checks the event timestamp if its log arrives later.
        if (this.launch || this.trigger || this.prelaunchHeartbeatResets !== 0) throw Error('log_format_unavailable');
        this.prelaunchHeartbeatResets = 1;
        this.resetHeartbeat = { wall, timeOriginMs: event.timeOriginMs, intervalEndMs: event.intervalEndMs };
        this.freshHeartbeatRequired = true;
        this.beat = undefined;
        return;
      }
      if (this.freshHeartbeatRequired) {
        if (wall <= this.resetHeartbeat.wall || event.timeOriginMs !== this.resetHeartbeat.timeOriginMs
          || event.intervalEndMs <= this.resetHeartbeat.intervalEndMs) throw Error('log_changed');
        this.freshHeartbeatRequired = false;
      }
      this.beat = wall;
      if (this.trigger && wall > this.trigger.wallMs) this.recovery ??= wall;
    }
    if (this.launch && event.event === 'request.start' && event.method === 'HEAD'
      && event.path === '/' && wall >= this.launch.eventWallMs) this.entry ??= wall;
  }
  start(wall, mono) {
    if (this.reason || this.trigger || !this.launch || this.entry || this.beat === undefined) return false;
    if (wall >= this.launch.eventWallMs + 10000 || wall - this.beat < 6000) return false;
    this.trigger = { wallMs: wall, monoMs: mono, lastHeartbeatWallMs: this.beat };
    return true;
  }
  finished(wall, mono) {
    return !!(this.reason || this.entry || this.recovery || this.samples.length >= 20
      || (this.launch && wall >= this.launch.eventWallMs + 10000)
      || mono - this.startedMono >= 420000);
  }
  report(wall, mono) {
    const launch = this.launch, trigger = this.trigger;
    const limit = Math.min(launch ? launch.eventWallMs + 10000 : Infinity,
      this.entry ?? Infinity, this.recovery ?? Infinity);
    let reason = this.reason;
    const values = this.samples;
    if (!reason && values.some(value => value.reason !== 'ready')) reason = 'reader_unavailable';
    if (!reason && values.some(value => !trigger || value.wallMs < trigger.wallMs - 50 || value.wallEndMs >= limit)) reason = 'late_inconclusive';
    if (!reason && values.some(value => BigInt(value.queryNs) > 10000000n
      || Math.abs(value.wallEndMs - value.wallMs - Number(BigInt(value.queryNs)) / 1e6) > 50)) reason = 'reader_slow';
    const samples = [];
    if (values.length && values.every(value => value.reason === 'ready')) {
      const first = values[0];
      for (const value of values) {
        const delta = key => Number(BigInt(value[key]) - BigInt(first[key]));
        const userNs = delta('userNs'), systemNs = delta('systemNs'), elapsedNs = delta('monotonicNs');
        if (![userNs, systemNs, elapsedNs].every(number => Number.isSafeInteger(number) && number >= 0)) { reason = 'counter_unavailable'; break; }
        samples.push({ index: value.index, state: states[value.state], wallMs: value.wallMs, readFinishedWallMs: value.wallEndMs,
          elapsedMs: elapsedNs / 1e6, userCpuUs: userNs / 1000, systemCpuUs: systemNs / 1000,
          queryMs: Number(BigInt(value.queryNs)) / 1e6, readerCpuMs: Number(BigInt(value.readerCpuNs)) / 1e6 });
      }
    }
    const observed = !reason && samples.length >= 2;
    return { event: 'thread_observation', outcome: observed ? 'states_observed' : 'inconclusive',
      reason: reason ?? (observed ? 'bounded_interval' : this.freshHeartbeatRequired ? 'prelaunch_baseline_unavailable'
        : trigger ? 'no_samples' : launch ? 'not_triggered' : 'milestone_unavailable'),
      prelaunchHeartbeatResets: this.prelaunchHeartbeatResets,
      prelaunchHeartbeatBaselineRecovered: this.prelaunchHeartbeatResets === 1 && !this.freshHeartbeatRequired,
      startedWallMs: this.startedWall, finishedWallMs: wall, elapsedMs: mono - this.startedMono,
      ...(launch ? { launchEventWallMs: launch.eventWallMs, launchReadWallMs: launch.readWallMs,
        launchReadDelayMs: launch.readDelayMs, launchReadElapsedMs: launch.readMonoMs - this.startedMono } : {}),
      ...(trigger ? { triggerWallMs: trigger.wallMs, triggerElapsedMs: trigger.monoMs - this.startedMono,
        lastHeartbeatWallMs: trigger.lastHeartbeatWallMs } : {}),
      ...(this.entry ? { manifestEntryWallMs: this.entry } : {}),
      ...(this.recovery ? { heartbeatRecoveryWallMs: this.recovery } : {}), samples };
  }
}

async function watch(scope = 'ios-phone') {
  let native, metro, active, window, stopped = false;
  const stop = () => { stopped = true; if (window) window.reason = 'observer_stopped'; active?.stop(); };
  process.once('SIGTERM', stop);
  try {
    if (!scopes.has(scope)) throw Error('unsupported_scope');
    const ctx = probe.qualified();
    const stopFile = path.join(ctx.root, `stop-${scope}`);
    const target = probe.identity(JSON.parse(fs.readFileSync(probe.privateFile(ctx.target), 'utf8')));
    if (Number(target.uid) !== process.getuid()) throw Error('identity_unavailable');
    window = new Window(Number(target.pid), Date.now(), performance.now());
    native = new Tail(path.join(ctx.evidence, `${scope}-startup.log`));
    // The tablet starts after all phone flows. Its observation must not reuse
    // an earlier phone request or heartbeat, or consume that old log backlog.
    metro = new Tail(path.join(ctx.evidence, 'metro.log'), scope === 'ios-tablet');
    while (!stopped) {
      if (fs.existsSync(stopFile)) { stop(); break; }
      const wall = Date.now(), mono = performance.now();
      window.clock(wall, mono);
      for (const line of native.read()) window.native(line, wall, mono);
      for (const line of metro.read()) window.metro(line);
      if (window.finished(wall, mono)) break;
      if (window.start(wall, mono)) {
        active = probe.reader(ctx, target, 'observe', value => { window.samples.push(value); });
        active.done.then(result => { if (result.issue) window.reason = result.issue; stopped = true; });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (active) { active.stop(); const result = await active.done; if (result.issue) window.reason = result.issue; }
    // Re-read existing log events once to classify samples that arrived after recovery.
    window.clock(Date.now(), performance.now());
    for (const line of native.read()) window.native(line, Date.now(), performance.now());
    for (const line of metro.read()) window.metro(line);
    if (stopped && !active) window.reason = 'observer_stopped';
    return { deviceScope: scope, ...window.report(Date.now(), performance.now()), targetPid: Number(target.pid),
      targetOwnerUid: Number(target.uid), targetStartSeconds: target.startSeconds,
      targetStartMicros: target.startMicros, targetThreadId: target.threadId };
  } catch (error) {
    active?.stop();
    if (active) await active.done;
    const reasons = new Set(['log_unavailable', 'log_changed', 'log_backlog', 'log_format_unavailable',
      'identity_unavailable', 'milestone_unavailable', 'preflight_unavailable', 'unsupported_context', 'unsupported_scope']);
    return { event: 'thread_observation', outcome: 'inconclusive', reason: reasons.has(error.message) ? error.message : 'unavailable',
      ...(scopes.has(scope) ? { deviceScope: scope } : {}),
      ...(window ? { prelaunchHeartbeatResets: window.prelaunchHeartbeatResets,
        prelaunchHeartbeatBaselineRecovered: window.prelaunchHeartbeatResets === 1 && !window.freshHeartbeatRequired } : {}) };
  } finally {
    process.off('SIGTERM', stop);
    try { native?.close(); } catch {}
    try { metro?.close(); } catch {}
  }
}

module.exports = { launchMilestone, Tail, Window, watch };
if (require.main === module) watch(process.argv.length === 2 ? 'ios-phone'
  : process.argv.length === 3 ? process.argv[2] : '').then(result => {
  // fd2 is intentionally unused; never expose source logs or runtime errors.
  try { fs.writeSync(1, `${JSON.stringify(result)}\n`); } catch { /* Diagnostic output only. */ }
}).catch(() => { /* Optional diagnostic cannot replace the acceptance outcome. */ });
