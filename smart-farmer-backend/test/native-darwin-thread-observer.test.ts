import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, truncateSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('../../smart-farmer-frontend/mobile/acceptance/', import.meta.url));
const preflight = require(join(directory, 'darwin-thread-preflight.cjs'));
const { launchMilestone, Tail, Window } = require(join(directory, 'darwin-thread-watch.cjs'));
const epoch = Date.parse('2026-11-07T05:52:26Z');
const launch = '2026-11-07 05:52:26.029480+0000  localhost SmartFarmer[16030]: (CoreFoundation) [com.apple.defaults:User Defaults] setting new value private-uri-sentinel for key -initialUrl in CFPrefsSource<private-address-sentinel>';
const target = { reason: 'ready', pid: '123', uid: '501', startSeconds: '1700000000', startMicros: '12', threadId: '9007199254740993' };
const record = (index = 0, overrides = {}) => ({ reason: 'ready', index, state: 3,
  wallMs: epoch + 200 + index * 100, wallEndMs: epoch + 201 + index * 100,
  monotonicNs: String(1000000000 + index * 100000000), queryNs: '1000000',
  userNs: String(100000000 + index * 1000), systemNs: '50000000', readerCpuNs: '100000', ...overrides });
const heartbeat = (wall: number) => '[metro-http] ' + JSON.stringify({ event: 'heartbeat', pid: 123,
  time: new Date(wall).toISOString(), timeOriginMs: epoch - 100000, intervalEndMs: wall - epoch + 100000 });
const head = (wall: number) => '[metro-http] ' + JSON.stringify({ event: 'request.start', pid: 123,
  time: new Date(wall).toISOString(), method: 'HEAD', path: '/' });

function armed() {
  const window = new Window(123, epoch - 1000, 0);
  window.metro(heartbeat(epoch - 6500));
  window.clock(epoch + 100, 1100);
  window.native(launch, epoch + 100, 1100);
  assert.equal(window.start(epoch + 100, 1100), true);
  return window;
}

test('existing launch milestone is exact, measured and never returns private line contents', () => {
  assert.equal(launchMilestone(launch), epoch + 29.48);
  assert.equal(launchMilestone(launch.replace('SmartFarmer[', 'OtherApp[')), undefined);
  assert.equal(launchMilestone(launch.replace('setting new value', 'read value')), undefined);
  assert.equal(launchMilestone(launch.replace('-initialUrl', '-other')), undefined);
  const window = armed();
  window.samples.push(record(), record(1));
  const result = window.report(epoch + 400, 1400);
  assert.equal(result.outcome, 'states_observed');
  assert.equal(result.launchReadDelayMs, 70.52001953125);
  assert.equal(result.samples[0].state, 'waiting');
  for (const secret of ['private-uri-sentinel', 'private-address-sentinel', '16030']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('one interval only, with actual recovery/manifest boundaries and explicit late outcomes', () => {
  const window = armed();
  assert.equal(window.start(epoch + 200, 1200), false, 'the observer cannot start a second interval');
  window.samples.push(record(0, { state: 1 }), record(1, { state: 1 }));
  window.metro(heartbeat(epoch + 500));
  assert.equal(window.finished(epoch + 500, 1500), true);
  assert.equal(window.report(epoch + 500, 1500).samples[0].state, 'running_or_runnable');
  assert.equal(JSON.stringify(window.report(epoch + 500, 1500)).includes('starvation'), false);
  window.samples.push(record(2, { wallMs: epoch + 499, wallEndMs: epoch + 501 }));
  assert.equal(window.report(epoch + 600, 1600).reason, 'late_inconclusive');
  const entered = armed();
  entered.samples.push(record(), record(1)); entered.metro(head(epoch + 250));
  assert.equal(entered.report(epoch + 400, 1400).reason, 'late_inconclusive');
  const slow = armed(); slow.samples.push(record(0, { queryNs: '11000000' }));
  assert.equal(slow.report(epoch + 400, 1400).reason, 'reader_slow');
});

test('stale launch, delayed helper, clock movement and duplicate launch never arm', () => {
  const stale = new Window(123, epoch - 1000, 0);
  stale.metro(heartbeat(epoch - 6500)); stale.native(launch, epoch + 1100, 2100);
  assert.equal(stale.start(epoch + 1100, 2100), false);
  assert.equal(stale.report(epoch + 1100, 2100).reason, 'late_milestone');
  const delayed = armed(); delayed.clock(epoch + 900, 1900);
  assert.equal(delayed.report(epoch + 900, 1900).reason, 'helper_late');
  const changed = armed(); changed.clock(epoch + 2000, 1200);
  assert.equal(changed.report(epoch + 2000, 1200).reason, 'clock_changed');
  const duplicate = armed(); duplicate.native(launch, epoch + 200, 1200);
  assert.equal(duplicate.report(epoch + 200, 1200).reason, 'multiple_launches');
  const expired = armed(); assert.equal(expired.finished(epoch + 10030, 11030), true);
});

test('one invalid prelaunch heartbeat clears the baseline and cannot arm without a fresh valid sample', () => {
  const invalid = (wall: number) => {
    const event = JSON.parse(heartbeat(wall).slice(13));
    event.intervalEndMs -= 5375;
    return '[metro-http] ' + JSON.stringify(event);
  };
  const missing = new Window(123, epoch - 10000, 0);
  missing.metro(heartbeat(epoch - 9500));
  missing.metro(invalid(epoch - 9000));
  missing.native(launch, epoch + 100, 10100);
  assert.equal(missing.beat, undefined, 'the prior heartbeat cannot survive an invalid replacement');
  assert.equal(missing.start(epoch + 100, 10100), false);
  assert.equal(missing.report(epoch + 200, 10200).reason, 'prelaunch_baseline_unavailable');
  assert.equal(missing.report(epoch + 200, 10200).prelaunchHeartbeatBaselineRecovered, false);

  const recovered = new Window(123, epoch - 10000, 0);
  recovered.metro(heartbeat(epoch - 9500)); recovered.metro(invalid(epoch - 9000));
  recovered.metro(heartbeat(epoch - 6500));
  recovered.clock(epoch + 100, 10100); recovered.native(launch, epoch + 100, 10100);
  assert.equal(recovered.start(epoch + 100, 10100), true);
  recovered.samples.push(record(), record(1));
  const result = recovered.report(epoch + 400, 10400);
  assert.equal(result.outcome, 'states_observed');
  assert.equal(result.prelaunchHeartbeatResets, 1);
  assert.equal(result.prelaunchHeartbeatBaselineRecovered, true);
  assert.equal(recovered.start(epoch + 500, 10500), false, 'no second observation is permitted');
});

test('prelaunch reset cannot relax active-window, second-mismatch or clock-identity checks', () => {
  const mismatch = (wall: number, changes = {}) => '[metro-http] ' + JSON.stringify({
    ...JSON.parse(heartbeat(wall).slice(13)), intervalEndMs: wall - epoch + 94000, ...changes });
  assert.throws(() => armed().metro(mismatch(epoch + 200)), /log_format_unavailable/);
  const beforeLaunch = new Window(123, epoch - 10000, 0);
  beforeLaunch.metro(mismatch(epoch - 9000)); beforeLaunch.native(launch, epoch + 100, 10100);
  assert.throws(() => beforeLaunch.metro(mismatch(epoch + 200)), /log_format_unavailable/);
  const twice = new Window(123, epoch - 10000, 0);
  twice.metro(mismatch(epoch - 9000)); twice.metro(heartbeat(epoch - 8000));
  assert.throws(() => twice.metro(mismatch(epoch - 7000)), /log_format_unavailable/);
  for (const changed of [heartbeat(epoch - 9000), heartbeat(epoch - 9500),
    '[metro-http] ' + JSON.stringify({ event: 'heartbeat', pid: 123, time: new Date(epoch - 8000).toISOString(),
      timeOriginMs: epoch - 200000, intervalEndMs: 192000 })]) {
    const window = new Window(123, epoch - 10000, 0); window.metro(mismatch(epoch - 9000));
    assert.throws(() => window.metro(changed), /log_changed/);
  }
  const malformed = new Window(123, epoch - 10000, 0);
  assert.throws(() => malformed.metro(mismatch(epoch - 9000, { intervalEndMs: null })), /log_format_unavailable/);
  assert.equal(malformed.prelaunchHeartbeatResets, 0, 'malformed records are never treated as timing drift');
  const backwards = new Window(123, epoch - 10000, 0); backwards.metro(heartbeat(epoch - 8000));
  assert.throws(() => backwards.metro(mismatch(epoch - 9000)), /log_changed/);
  assert.equal(backwards.prelaunchHeartbeatResets, 0, 'reset cannot erase a backwards event timestamp');
});

test('a delayed native milestone cannot reclassify an active-window reset as prelaunch', () => {
  const delayedLaunch = launch.replace('.029480+0000', '.029000+0000');
  for (const resetWall of [epoch + 29, epoch + 200]) {
    const window = new Window(123, epoch - 10000, 0);
    const mismatch = JSON.parse(heartbeat(resetWall).slice(13));
    mismatch.intervalEndMs -= 6000;
    window.metro('[metro-http] ' + JSON.stringify(mismatch));
    window.metro(heartbeat(epoch + 300));
    assert.equal(window.freshHeartbeatRequired, false);
    // Native log delivery is delayed, but the milestone itself is within the
    // existing one-second bound and precedes or equals the reset heartbeat.
    window.native(delayedLaunch, epoch + 500, 10500);
    assert.equal(window.launch.readDelayMs, 471);
    assert.equal(window.start(epoch + 6500, 16500), false);
    assert.equal(window.trigger, undefined);
    const result = window.report(epoch + 6500, 16500);
    assert.equal(result.outcome, 'inconclusive');
    assert.equal(result.reason, 'heartbeat_launch_overlap');
    assert.deepEqual(result.samples, []);
  }
});

test('append-only tails refuse replacement, truncation, symlinks and excessive backlog', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmer-thread-tail-'));
  let tail;
  try {
    const file = join(root, 'log'); writeFileSync(file, 'one\npartial');
    tail = new Tail(file); assert.deepEqual(tail.read(), ['one']);
    writeFileSync(file, 'one\npartial-line\n'); assert.deepEqual(tail.read(), ['partial-line']);
    truncateSync(file, 0); assert.throws(() => tail.read(), /log_changed/); tail.close();
    tail = new Tail(file); renameSync(file, join(root, 'old')); writeFileSync(file, 'new\n');
    assert.throws(() => tail.read(), /log_changed/); tail.close();
    symlinkSync(file, join(root, 'link')); assert.throws(() => new Tail(join(root, 'link')));
    writeFileSync(file, 'x'.repeat(512 * 1024 + 1)); tail = new Tail(file);
    assert.throws(() => tail.read(), /log_backlog/);
  } finally { tail?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a fresh tablet tail reads appended events without consuming earlier phone history', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmer-tablet-tail-'));
  let tail;
  try {
    const file = join(root, 'metro.log');
    writeFileSync(file, 'earlier-phone-history\n'.repeat(30000));
    tail = new Tail(file, true);
    assert.deepEqual(tail.read(), []);
    appendFileSync(file, 'new-tablet-event\npartial');
    assert.deepEqual(tail.read(), ['new-tablet-event']);
    appendFileSync(file, '-line\n');
    assert.deepEqual(tail.read(), ['partial-line']);
    assert.equal(tail.total, Buffer.byteLength('new-tablet-event\npartial-line\n'));
    truncateSync(file, 0);
    assert.throws(() => tail.read(), /log_changed/, 'fresh cursor cannot relax append-only custody');
  } finally { tail?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('tablet watcher uses its own launch log and stop marker after a completed phone observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmer-tablet-watch-'));
  const fixture = `
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const probe=require(${JSON.stringify(join(directory, 'darwin-thread-preflight.cjs'))});
    const {watch}=require(${JSON.stringify(join(directory, 'darwin-thread-watch.cjs'))});
    const root=${JSON.stringify(root)},evidence=path.join(root,'evidence');
    fs.mkdirSync(evidence,{mode:0o700});
    const ctx={root,evidence,target:path.join(root,'target.json'),stop:path.join(root,'stop')};
    fs.writeFileSync(ctx.target,JSON.stringify({...${JSON.stringify(target)},uid:String(process.getuid())}),{mode:0o600});
    for(const name of ['stop','stop-ios-phone'])fs.writeFileSync(path.join(root,name),'');
    const native=path.join(evidence,'ios-tablet-startup.log'),metro=path.join(evidence,'metro.log');
    fs.writeFileSync(path.join(evidence,'ios-phone-startup.log'),'earlier-phone-private-sentinel\\n');
    fs.writeFileSync(native,'');
    fs.writeFileSync(metro,'earlier-phone-history\\n'.repeat(30000));
    probe.qualified=()=>ctx;
    probe.reader=()=>{throw Error('no_reader_expected_after_manifest_entry');};
    (async()=>{
      const observed=watch('ios-tablet');
      setTimeout(()=>{
        const wall=Date.now(),stamp=new Date(wall).toISOString().replace('T',' ').replace('Z','000+0000');
        fs.appendFileSync(native,stamp+'  localhost SmartFarmer[456]: (CoreFoundation) [com.apple.defaults:User Defaults] setting new value private-uri-sentinel for key -initialUrl in CFPrefsSource<private-address-sentinel>\\n');
        fs.appendFileSync(metro,'[metro-http] '+JSON.stringify({event:'request.start',pid:123,time:new Date(wall+1).toISOString(),method:'HEAD',path:'/'})+'\\n');
      },25);
      const first=await observed;
      assert.equal(first.deviceScope,'ios-tablet');assert.equal(first.reason,'not_triggered');
      assert.equal(first.outcome,'inconclusive');assert.ok(first.launchEventWallMs);assert.ok(first.manifestEntryWallMs);
      assert.deepEqual(first.samples,[]);
      fs.writeFileSync(path.join(root,'stop-ios-tablet'),'');
      const stopped=await watch('ios-tablet');
      assert.equal(stopped.reason,'observer_stopped');assert.equal(stopped.deviceScope,'ios-tablet');
      assert.equal(fs.readFileSync(path.join(evidence,'ios-phone-startup.log'),'utf8'),'earlier-phone-private-sentinel\\n');
      console.log(JSON.stringify({first,stopped}));
    })().catch(()=>{process.exitCode=99;});`;
  try {
    const result = spawnSync(process.execPath, ['-e', fixture], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    for (const value of ['private-uri-sentinel', 'private-address-sentinel', 'earlier-phone-private-sentinel']) {
      assert.equal(result.stdout.includes(value), false);
    }
    assert.equal(JSON.parse(result.stdout).first.deviceScope, 'ios-tablet');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watcher refuses arbitrary device paths and extra CLI arguments without exposing them', () => {
  for (const args of [['../../private-scope-sentinel'], ['ios-tablet', 'extra-private-sentinel']]) {
    const result = spawnSync(process.execPath, [join(directory, 'darwin-thread-watch.cjs'), ...args],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, CI: 'false' } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'unavailable diagnostics do not replace the native acceptance outcome');
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { event: 'thread_observation', outcome: 'inconclusive', reason: 'unsupported_scope' });
    assert.equal(result.stdout.includes('private-sentinel'), false);
  }
});

test('real shell observation setup creates each native log before its watcher and refuses reuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmer-native-log-start-'));
  try {
    const evidence = join(root, 'native-evidence');
    const acceptance = join(root, 'smart-farmer-frontend/mobile/acceptance');
    mkdirSync(evidence, { mode: 0o700 });
    mkdirSync(join(root, 'farmer-darwin-thread'), { mode: 0o700 });
    mkdirSync(acceptance, { recursive: true });
    // Only the observer/log setup functions run here, with an owned stream
    // fixture. No simulator, app launch or native acceptance is simulated.
    const source = readFileSync(join(directory, 'ios.sh'), 'utf8');
    const boundary = source.indexOf('\nNATIVE_PHONE=');
    assert.ok(boundary > 0);
    const script = source.slice(0, boundary) + `
      xcrun() { printf 'owned-stream-fixture\\n'; }
      start_native_log fixture-phone ios-phone
      wait "$NATIVE_THREAD_WATCH_PID"
      wait "$NATIVE_LOG_PID"
      stop_native_log
      start_native_log fixture-tablet ios-tablet
      wait "$NATIVE_THREAD_WATCH_PID"
      wait "$NATIVE_LOG_PID"
    `;
    writeFileSync(join(acceptance, 'darwin-thread-watch.cjs'), `
      const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
      const scope=process.argv[2];assert.ok(['ios-phone','ios-tablet'].includes(scope));
      const info=fs.lstatSync(path.join(process.env.RUNNER_TEMP,'native-evidence',scope+'-startup.log'));
      assert.ok(info.isFile());assert.equal(info.mode & 0o777,0o600);
      console.log(JSON.stringify({scope,nativeLogReady:true}));
    `);
    const options = { cwd: root, encoding: 'utf8' as const, timeout: 5000,
      env: { ...process.env, RUNNER_TEMP: root } };
    const first = spawnSync('bash', ['-euc', script], options);
    assert.ifError(first.error); assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(evidence, 'ios-thread-observation.json'), 'utf8')),
      { scope: 'ios-phone', nativeLogReady: true });
    const tablet = readFileSync(join(evidence, 'ios-tablet-thread-observation.json'), 'utf8');
    assert.deepEqual(JSON.parse(tablet), { scope: 'ios-tablet', nativeLogReady: true });
    for (const scope of ['ios-phone', 'ios-tablet']) {
      assert.equal(readFileSync(join(evidence, scope + '-startup.log'), 'utf8'), 'owned-stream-fixture\n');
      assert.equal(readFileSync(join(root, 'farmer-darwin-thread', 'stop-' + scope), 'utf8'), '');
    }
    const duplicate = spawnSync('bash', ['-euc', script], options);
    assert.ifError(duplicate.error); assert.notEqual(duplicate.status, 0, 'an existing log must stop setup before either new child starts');
    assert.equal(readFileSync(join(evidence, 'ios-phone-startup.log'), 'utf8'), 'owned-stream-fixture\n');
    assert.equal(readFileSync(join(evidence, 'ios-tablet-thread-observation.json'), 'utf8'), tablet);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public identity and reader protocol preserve uint64 strings and reject additional data', () => {
  assert.equal(preflight.identity(target).threadId, '9007199254740993');
  for (const wrong of [{ ...target, threadId: 9007199254740992 }, { ...target, threadId: '0' },
    { ...target, threadId: '18446744073709551616' }, { ...target, reason: 'not_main_thread' },
    { ...target, name: 'private-thread-sentinel' }]) assert.throws(() => preflight.identity(wrong));
  assert.equal(preflight.sample(JSON.stringify(record())).state, 3);
  for (const wrong of [{ ...record(), name: 'private-thread-sentinel' }, { ...record(), state: 0 },
    { ...record(), index: 20 }, { ...record(), userNs: 'not-a-counter' }, { reason: 'raw-error-sentinel' }]) {
    assert.throws(() => preflight.sample(JSON.stringify(wrong)));
  }
});

test('real child reader supervision bounds output and cancels only its own helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'farmer-thread-reader-'));
  try {
    const helper = join(root, 'reader');
    writeFileSync(helper, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(record()) + '\n')}); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n`, { mode: 0o700 });
    let instance;
    instance = preflight.reader({ reader: helper }, target, 'observe', () => instance.stop());
    assert.notEqual(instance.child.pid, process.pid);
    const result = await instance.done;
    assert.equal(result.issue, undefined); assert.equal(result.values.length, 1);
    assert.equal(instance.child.exitCode, 0, 'closing the control pipe permits natural helper exit');
    writeFileSync(helper, `#!${process.execPath}\nprocess.stdout.write('private-source-sentinel\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n`);
    const malformed = await preflight.reader({ reader: helper }, target).done;
    assert.equal(malformed.issue, 'reader_protocol');
    assert.equal(JSON.stringify(malformed).includes('private-source-sentinel'), false);
    writeFileSync(helper, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end',()=>{}); setInterval(()=>{},1000);\n`);
    const cancelled = preflight.reader({ reader: helper }, target, 'observe');
    cancelled.stop(); const stopped = await cancelled.done;
    assert.equal(stopped.issue, 'reader_unavailable');
    assert.equal(cancelled.child.signalCode, 'SIGTERM');
    assert.ok(process.pid > 1, 'the process named in this test remains unaffected by helper cleanup');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unqualified instrumentation leaves real HTTP responses and natural process exit unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmer-thread-unavailable-'));
  const fixture = `
    const http=require('node:http'),crypto=require('node:crypto');
    const server=http.createServer((req,res)=>{res.writeHead(201,{'x-test':'header-sentinel'});res.end('body-sentinel');});
    server.listen(0,'127.0.0.1',()=>http.get({host:'127.0.0.1',port:server.address().port,path:'/?private=query-sentinel'},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{console.log(JSON.stringify({status:res.statusCode,
        body:crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),header:res.headers['x-test']}));server.close();});
    }));`;
  try {
    const options = { encoding: 'utf8' as const, timeout: 5000,
      env: { ...process.env, CI: 'true', NODE_ENV: 'test', RUNNER_TEMP: root } };
    const baseline = spawnSync(process.execPath, ['-e', fixture], options);
    const observed = spawnSync(process.execPath, ['--require', join(directory, 'darwin-thread-preload.cjs'), '-e', fixture], options);
    assert.ifError(baseline.error); assert.ifError(observed.error);
    assert.equal(baseline.status, 0); assert.equal(observed.status, 0); assert.equal(observed.signal, null);
    assert.equal(observed.stdout, baseline.stdout); assert.equal(observed.stderr, '');
    const unavailable = spawnSync(process.execPath, [join(directory, 'darwin-thread-preflight.cjs'), 'prepare'],
      { ...options, env: { ...options.env, CI: 'false' } });
    assert.equal(unavailable.status, 1);
    assert.equal(JSON.parse(unavailable.stdout).qualified, false);
    assert.equal(JSON.parse(unavailable.stdout).reason, 'unsupported_context');
    const watcher = spawnSync(process.execPath, [join(directory, 'darwin-thread-watch.cjs')],
      { ...options, env: { ...options.env, CI: 'false' } });
    assert.equal(watcher.status, 0); assert.equal(JSON.parse(watcher.stdout).outcome, 'inconclusive');
    assert.equal(watcher.stderr, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ignored TERM cannot hold the supervisor or control parent open or replace its acceptance result', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmer-thread-forced-cleanup-'));
  try {
    const helper = join(root, 'reader'), control = join(root, 'control.cjs');
    writeFileSync(helper, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); process.stdout.write(${JSON.stringify(JSON.stringify(record()) + '\n')}); process.stdin.resume(); process.stdin.on('end',()=>{}); setInterval(()=>{},1000);\n`, { mode: 0o700 });
    writeFileSync(control, "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000);\n");
    const parent = `
      const assert=require('node:assert/strict'),{fork}=require('node:child_process');
      const probe=require(${JSON.stringify(join(directory, 'darwin-thread-preflight.cjs'))});
      const originalAcceptanceStatus=23;
      (async()=>{
        let ready;const started=new Promise(resolve=>{ready=resolve;});
        const reader=probe.reader({reader:${JSON.stringify(helper)}},${JSON.stringify(target)},'observe',ready);
        await started;reader.stop();const result=await reader.done;
        assert.equal(reader.child.signalCode,'SIGKILL');assert.equal(result.cleanupConfirmed,true);
        const control=fork(${JSON.stringify(control)},[],{stdio:['ignore','ignore','ignore','ipc']});
        await new Promise(resolve=>control.once('message',resolve));
        const cleaned=await probe.terminateOwnedControl(control);
        assert.equal(cleaned,true);assert.equal(control.signalCode,'SIGKILL');
        console.log(JSON.stringify({readerSignal:reader.child.signalCode,readerCleanupConfirmed:result.cleanupConfirmed,
          controlSignal:control.signalCode,controlCleanupConfirmed:cleaned}));
        process.exitCode=originalAcceptanceStatus;
      })().catch(()=>{process.exitCode=99;});`;
    const result = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'the parent must finish naturally');
    assert.equal(result.status, 23, 'owned diagnostic cleanup must retain the pre-existing acceptance result');
    assert.deepEqual(JSON.parse(result.stdout), { readerSignal: 'SIGKILL', readerCleanupConfirmed: true,
      controlSignal: 'SIGKILL', controlCleanupConfirmed: true });
    assert.equal(result.stderr, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
