#!/usr/bin/env bash
set -euo pipefail
NATIVE_PLATFORM="${1:?Pass android or ios}"
case "$NATIVE_PLATFORM" in android|ios) ;; *) exit 2 ;; esac
mkdir -p "$RUNNER_TEMP/native-evidence"
npm run migrate --prefix smart-farmer-backend
npm run build --prefix smart-farmer-backend
(cd smart-farmer-backend && node dist/server.js) > "$RUNNER_TEMP/native-evidence/api.log" 2>&1 &
node -e 'async function run(){for(let i=0;i<60;i++){try{const r=await fetch("http://127.0.0.1:3000/health");if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw new Error("API not ready");}run();'
node smart-farmer-frontend/mobile/acceptance/fixture.mjs seed
if [ "$NATIVE_PLATFORM" = ios ]; then
  export NATIVE_TLS_DIR="$RUNNER_TEMP/native-tls"
  node smart-farmer-frontend/mobile/acceptance/simulator-tls.mjs prepare
fi
node smart-farmer-frontend/mobile/acceptance/fixture.mjs proxy > "$RUNNER_TEMP/native-evidence/proxy.log" 2>&1 &
if [ "$NATIVE_PLATFORM" = ios ]; then
  node smart-farmer-frontend/mobile/acceptance/simulator-tls.mjs verify > "$RUNNER_TEMP/native-evidence/ios-tls.txt"
  exit 0
fi
cd smart-farmer-frontend/mobile
npx expo start --dev-client --localhost > "$RUNNER_TEMP/native-evidence/metro.log" 2>&1 &
node -e 'async function run(){for(let i=0;i<90;i++){try{const r=await fetch("http://127.0.0.1:8081/status");if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw new Error("Metro not ready");}run();'
# Avoid compiling the first development bundle while the emulator is still settling.
curl --fail --show-error --silent --max-time 180 --output /dev/null "http://127.0.0.1:8081/index.bundle?platform=$NATIVE_PLATFORM&dev=true&minify=false&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1"
