#!/usr/bin/env bash
set -euo pipefail
NATIVE_PLATFORM="${1:?Pass android or ios}"
case "$NATIVE_PLATFORM" in android|ios) ;; *) exit 2 ;; esac
mkdir -p "$RUNNER_TEMP/native-evidence"
export MEDIA_ROOT="$RUNNER_TEMP/native-private-media"
npm run migrate --prefix smart-farmer-backend
npm run build --prefix smart-farmer-backend
if [[ "$NATIVE_PLATFORM" == ios ]]; then
  NATIVE_API_OBSERVER="$PWD/smart-farmer-frontend/mobile/acceptance/api-request-observer.cjs"
  (cd smart-farmer-backend && node --require "$NATIVE_API_OBSERVER" dist/server.js) > "$RUNNER_TEMP/native-evidence/api.log" 2>&1 &
else
  (cd smart-farmer-backend && node dist/server.js) > "$RUNNER_TEMP/native-evidence/api.log" 2>&1 &
fi
node -e 'async function run(){for(let i=0;i<60;i++){try{const r=await fetch("http://127.0.0.1:3000/health");if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw new Error("API not ready");}run();'
node smart-farmer-frontend/mobile/acceptance/fixture.mjs seed
node smart-farmer-frontend/mobile/acceptance/fixture.mjs proxy > "$RUNNER_TEMP/native-evidence/proxy.log" 2>&1 &
cd smart-farmer-frontend/mobile
native_bundle_path="/index.bundle?platform=$NATIVE_PLATFORM&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable"
native_bundle_url="http://127.0.0.1:8081$native_bundle_path"
if [[ "$NATIVE_PLATFORM" == ios ]]; then
  NATIVE_THREAD_PRELOAD=''
  if node "$PWD/acceptance/darwin-thread-preflight.cjs" prepare > "$RUNNER_TEMP/native-evidence/ios-thread-preflight.json" 2>/dev/null; then
    NATIVE_THREAD_PRELOAD=" --require \"$PWD/acceptance/darwin-thread-preload.cjs\""
  fi
  # Capture HTTP lifecycle metadata, never headers, query strings or payloads.
  ONESA_IOS_ACCEPTANCE_BUNDLE_PATH="$native_bundle_path" \
  EXPO_OVERRIDE_METRO_CONFIG="$PWD/acceptance/ios-bundle-metro.cjs" \
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require \"$PWD/acceptance/metro-request-observer.cjs\"$NATIVE_THREAD_PRELOAD" \
    npx expo start --dev-client --localhost > "$RUNNER_TEMP/native-evidence/metro.log" 2>&1 &
else
  npx expo start --dev-client --localhost > "$RUNNER_TEMP/native-evidence/metro.log" 2>&1 &
fi
node -e 'async function run(){for(let i=0;i<90;i++){try{const r=await fetch("http://127.0.0.1:8081/status");if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw new Error("Metro not ready");}run();'
# Warm the same development graph requested by Expo SDK 58's native client.
# The router root and Hermes transform profile are part of that graph's identity.
curl --fail --show-error --silent --max-time 180 --output /dev/null "$native_bundle_url"
if [[ "$NATIVE_PLATFORM" == ios ]]; then
  # Require the same successful GET's real MIME type on the cached HEAD path.
  curl --fail --show-error --silent --max-time 10 --head "$native_bundle_url" |
    grep -Ei '^content-type: *(application|text)/javascript([;[:space:]]|$)' >/dev/null
  # Retain separate manifest diagnostics. iOS acceptance launches the warmed
  # bundle directly, avoiding dynamic manifest resolution. Expo still performs
  # a HEAD content-type probe against that exact bundle URL.
  NATIVE_MANIFEST_URL='http://127.0.0.1:8081/'
  NATIVE_MANIFEST_HEADERS=(
    --header 'expo-platform: ios'
    --header 'accept: application/expo+json,application/json'
    --header 'Expo-AppMetrics-Skip: 1'
    --header 'Forwarded: host="127.0.0.1:8081";proto=http'
    --header 'X-Forwarded-Host: 127.0.0.1:8081'
    --header 'X-Forwarded-Proto: http'
  )
  curl --fail --show-error --silent --max-time 180 --head "${NATIVE_MANIFEST_HEADERS[@]}" \
    --dump-header "$RUNNER_TEMP/native-evidence/ios-manifest-head.headers" --output /dev/null \
    --write-out 'method=HEAD status=%{http_code} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
    "$NATIVE_MANIFEST_URL" > "$RUNNER_TEMP/native-evidence/ios-manifest-head-timing.txt"
  curl --fail --show-error --silent --max-time 10 "${NATIVE_MANIFEST_HEADERS[@]}" \
    --dump-header "$RUNNER_TEMP/native-evidence/ios-manifest-get.headers" --output "$RUNNER_TEMP/native-evidence/ios-manifest.json" \
    --write-out 'method=GET status=%{http_code} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
    "$NATIVE_MANIFEST_URL" > "$RUNNER_TEMP/native-evidence/ios-manifest-get-timing.txt"
  node - "$RUNNER_TEMP/native-evidence" "$NATIVE_MANIFEST_URL" > "$RUNNER_TEMP/native-evidence/ios-manifest-validation.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [evidence, manifestUrl] = process.argv.slice(2);
for (const method of ['head', 'get']) {
  const headers = fs.readFileSync(path.join(evidence, `ios-manifest-${method}.headers`), 'utf8');
  if (!/^HTTP\/\S+\s+200\b/m.test(headers) || !/^content-type:\s*application\/(?:expo\+)?json\b/im.test(headers)) {
    throw new Error(`Native manifest ${method.toUpperCase()} did not return HTTP 200 JSON`);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(evidence, 'ios-manifest.json'), 'utf8'));
if (typeof manifest.launchAsset?.url !== 'string' || manifest.extra?.expoClient?.slug !== 'smart-farmer') {
  throw new Error('Native manifest is missing the Smart Farmer launch asset');
}
const bundleUrl = new URL(manifest.launchAsset.url, manifestUrl);
const platforms = bundleUrl.searchParams.getAll('platform');
if (bundleUrl.origin !== new URL(manifestUrl).origin || bundleUrl.pathname !== '/index.bundle' ||
    bundleUrl.username || bundleUrl.password || bundleUrl.hash || platforms.length !== 1 || platforms[0] !== 'ios') {
  throw new Error('Native manifest launch asset must use the same loopback origin and iOS bundle');
}
console.log(JSON.stringify({ platform: 'ios', bundleUrl: bundleUrl.href }));
NODE
fi
