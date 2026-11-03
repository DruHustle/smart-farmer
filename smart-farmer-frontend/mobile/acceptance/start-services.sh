#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RUNNER_TEMP/native-evidence"
npm run migrate --prefix smart-farmer-backend
npm run build --prefix smart-farmer-backend
node smart-farmer-backend/dist/server.js > "$RUNNER_TEMP/native-evidence/api.log" 2>&1 &
node -e 'async function run(){for(let i=0;i<60;i++){try{const r=await fetch("http://127.0.0.1:3000/health");if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw new Error("API not ready");}run();'
node smart-farmer-frontend/mobile/acceptance/fixture.mjs seed
node smart-farmer-frontend/mobile/acceptance/fixture.mjs proxy > "$RUNNER_TEMP/native-evidence/proxy.log" 2>&1 &
cd smart-farmer-frontend/mobile
npx expo start --dev-client --localhost > "$RUNNER_TEMP/native-evidence/metro.log" 2>&1 &
node -e 'async function run(){for(let i=0;i<90;i++){try{const r=await fetch("http://127.0.0.1:8081/status");if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw new Error("Metro not ready");}run();'
