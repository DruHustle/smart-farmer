import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout} from 'node:timers/promises';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const apiOrigin = 'https://api.example.invalid'; // Embedded only; the check never contacts it.
const revision = 'a'.repeat(40); // Synthetic commit used only for image qualification.
const env = {...process.env, VITE_API_URL:apiOrigin};
function docker(args, stdio = 'pipe') {
  return execFileSync('docker', args, {cwd, env, encoding:'utf8', stdio, timeout:600_000});
}

// This is a required image check in CI: an absent Docker daemon is a failure, not a skip.
docker(['info']);
const config = JSON.parse(docker(['compose', '-f', '../compose.yml', 'config', '--format', 'json']));
assert.deepEqual(Object.keys(config.services), ['web']);
const service = config.services.web;
assert.equal(service.build.args.VITE_API_URL, apiOrigin);
assert.equal(service.read_only, true);
assert.ok(service.cap_drop.includes('ALL'));
assert.ok(service.security_opt.includes('no-new-privileges:true'));
assert.equal(service.ports.length, 1);
assert.equal(service.ports[0].host_ip, '127.0.0.1');
assert.equal(service.ports[0].target, 8080);
assert.ok(!service.volumes?.length); // No database or credentials in the static frontend.

const temp = await mkdtemp(join(tmpdir(), 'smart-farmer-web-image-'));
let containerId;
try {
  const iid = join(temp, 'image-id');
  docker(['build', '--iidfile', iid, '--build-arg', `VITE_API_URL=${apiOrigin}`, '--build-arg', `APP_REVISION=${revision}`, '.'], 'inherit');
  const imageId = (await readFile(iid, 'utf8')).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(docker(['image', 'inspect', imageId]))[0].Config.Labels['org.opencontainers.image.revision'], revision);

  const missingOrigin = spawnSync('docker', ['build', '--target', 'build', '--build-arg', 'VITE_API_URL=', '.'],
    {cwd, env, encoding:'utf8', timeout:120_000, maxBuffer:2_000_000});
  assert.notEqual(missingOrigin.status, 0, 'missing API origin must fail the actual image build');
  assert.match(missingOrigin.stdout + missingOrigin.stderr, /VITE_API_URL must be/);

  // A real readable dotfile proves the HTTP refusal is routing policy, not absence.
  const hiddenPath = '/assets/.container-security-probe';
  const hiddenTarget = '/usr/share/nginx/html' + hiddenPath;
  const hiddenSource = join(temp, '.container-security-probe');
  const hiddenContents = 'Synthetic static-container probe.\n';
  await writeFile(hiddenSource, hiddenContents, {encoding:'utf8', mode:0o644, flag:'wx'});
  await chmod(hiddenSource, 0o644);
  containerId = docker(['run', '--detach', '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
    '--mount', `type=bind,source=${hiddenSource},target=${hiddenTarget},readonly`,
    '--publish', '127.0.0.1::8080', imageId]).trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const runtime = JSON.parse(docker(['inspect', containerId]))[0];
  assert.equal(runtime.Config.User, '101:101');
  assert.equal(runtime.HostConfig.ReadonlyRootfs, true);
  assert.ok(runtime.HostConfig.CapDrop.includes('ALL'));
  assert.equal(docker(['exec', containerId, 'id', '-u']).trim(), '101');
  const hiddenMount = runtime.Mounts.find((mount) => mount.Destination === hiddenTarget);
  assert.equal(hiddenMount?.Type, 'bind');
  assert.equal(hiddenMount.Source, hiddenSource);
  assert.equal(hiddenMount.RW, false);
  assert.equal(docker(['exec', containerId, 'cat', hiddenTarget]), hiddenContents);
  const binding = runtime.NetworkSettings.Ports['8080/tcp'];
  assert.equal(binding.length, 1);
  assert.equal(binding[0].HostIp, '127.0.0.1');
  const base = `http://127.0.0.1:${binding[0].HostPort}`;
  async function request(path, options = {}) {
    return fetch(base + path, {...options, redirect:'error', signal:AbortSignal.timeout(3_000)});
  }
  const deadline = Date.now() + 15_000;
  while (true) {
    try { const response = await request('/healthz'); if (response.ok) break; }
    catch { /* Wait only for this newly started container. */ }
    assert.ok(Date.now() < deadline, 'static container did not become ready');
    await setTimeout(250);
  }
  assert.deepEqual(await (await request('/healthz')).json(), {status:'ok', service:'smart-farmer-web'});
  assert.deepEqual(await (await request('/release.json')).json(), {revision});
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const html = await page.text();
  assert.match(html, /<div id="root"><\/div>/);
  const script = html.match(/<script[^>]+src="(\/assets\/[^"?]+\.js)"/)?.[1];
  assert.ok(script, 'Vite entry module must be served from this image');
  const js = await request(script);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.ok((await js.text()).includes(apiOrigin), 'built bundle must contain the selected public API origin');
  // Vite's offline-shell plugin and every public asset must survive image packaging.
  // Compare real bytes so the SPA fallback cannot disguise a missing manifest/icon.
  for (const [path, contentType] of [
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/icon.svg', 'image/svg+xml'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'],
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type')?.split(';')[0], contentType, path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(cwd, 'public', path.slice(1))), path);
  }
  const worker = await request('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);
  assert.equal(worker.headers.get('cache-control'), 'no-store');
  const workerSource = await worker.text();
  assert.match(workerSource, /smart-farmer-shell-[a-f0-9]{12}/);
  const precacheMatch = workerSource.match(/const FILES=(\[[^\n]*\]);/);
  assert.ok(precacheMatch, 'the built offline worker must declare its exact shell files');
  const shellFiles = JSON.parse(precacheMatch[1]);
  for (const path of ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', script]) {
    assert.ok(shellFiles.includes(path), `offline shell must include ${path}`);
  }
  for (const path of shellFiles) {
    assert.equal(typeof path, 'string');
    assert.ok(path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/v1/'), 'shell cache must stay within static same-origin paths');
    assert.ok(!/^\/assets\/hls-/.test(path), 'private video player remains lazy, outside shell precache');
    const response = await request(path);
    assert.equal(response.status, 200, `precache target ${path}`);
    if (path.endsWith('.js')) assert.match(response.headers.get('content-type'), /javascript/, path);
    if (path.endsWith('.css')) assert.match(response.headers.get('content-type'), /text\/css/, path);
    await response.arrayBuffer();
  }
  assert.equal(await (await request('/farms/example')).text(), html, 'SPA deep links serve the same index');
  assert.equal((await request(hiddenPath)).status, 404, 'readable asset dotfiles must not be served');
  for (const path of ['/.env', '/v1', '/v1/farms', '/assets/missing.js']) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.equal((await request('/', {method:'POST'})).status, 405);
  const head = await request('/', {method:'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  docker(['exec', containerId, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/healthz']);
  console.log('Smart Farmer frontend image: build, origin refusal, non-root read-only runtime, PWA assets, readable-dotfile refusal, health and routing passed.');
} finally {
  // Only the container ID created by this check is removed; shared images/volumes are retained.
  if (containerId) docker(['rm', '--force', containerId]);
  await rm(temp, {recursive:true, force:true});
}
