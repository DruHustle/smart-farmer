#!/usr/bin/env bash
set -euo pipefail
platform="${1:?ios or android}"
case "$platform" in ios|android) ;; *) exit 2;; esac
mode=${2:-metro}
case "$mode" in
  standalone)
    [[ "$platform" == ios && "$EXPO_PUBLIC_API_URL" == https://127.0.0.1:46502 ]] || exit 2
    export FARMER_TEST_ORIGIN="$EXPO_PUBLIC_API_URL"
    ;;
  metro) ;;
  *) exit 2 ;;
esac
work="$RUNNER_TEMP/onesa-device"
mkdir -p -m 700 "$work"
umask 077
cat > "$work/ca.cnf" <<'CONFIG'
[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=Onesa temporary device fixture
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
CONFIG
cat > "$work/leaf.cnf" <<'CONFIG'
[req]
distinguished_name=dn
prompt=no
[dn]
CN=localhost
[leaf]
basicConstraints=critical,CA:FALSE
subjectAltName=DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
keyUsage=critical,digitalSignature,keyEncipherment
CONFIG
openssl req -new -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -config "$work/ca.cnf" -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -config "$work/leaf.cnf" -keyout "$work/leaf.key" -out "$work/leaf.csr" 2>/dev/null
openssl x509 -req -in "$work/leaf.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 1 -sha256 -extfile "$work/leaf.cnf" -extensions leaf -out "$work/leaf.crt" 2>/dev/null
cat "$work/leaf.crt" "$work/ca.crt" > "$work/chain.pem"
export NODE_EXTRA_CA_CERTS="$work/ca.crt" TEST_TLS_CERT="$work/chain.pem" TEST_TLS_KEY="$work/leaf.key" FIXTURE_READY_FILE="$work/ready.json"
export PORTAL_CHECKOUT="$PWD/qualification-portal"
base="${DATABASE_URL%/*}"
export PORTAL_TEST_DATABASE_URL="$base/portal_device_test" FARMER_TEST_DATABASE_URL="$base/farmer_device_test"
for db in portal_device_test farmer_device_test; do
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "CREATE DATABASE $db" >/dev/null
done
node scripts/portal-device-fixture.mjs > "$work/fixture.log" 2>&1 &
fixture_pid=$!
for attempt in {1..120}; do
  [[ -s "$FIXTURE_READY_FILE" ]] && break
  if ! kill -0 "$fixture_pid" 2>/dev/null; then tail -20 "$work/fixture.log"; exit 1; fi
  sleep 1
done
test -s "$FIXTURE_READY_FILE"
if [[ "$mode" == standalone ]]; then
  curl -fsS --noproxy '*' --cacert "$work/ca.crt" "$FARMER_TEST_ORIGIN/v1/onesa/config" -o /dev/null
  exit 0
fi
export EXPO_PUBLIC_API_URL=http://127.0.0.1:46504
cd smart-farmer-frontend/mobile
native_bundle_path="/index.bundle?platform=$platform&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable"
if [[ "$platform" == ios ]]; then
  # Use the farm suite's real GET result for Expo's short HEAD MIME probe.
  export ONESA_IOS_ACCEPTANCE_BUNDLE_PATH="$native_bundle_path"
  export EXPO_OVERRIDE_METRO_CONFIG="$PWD/acceptance/ios-bundle-metro.cjs"
fi
npx --no-install expo start --dev-client --localhost > "$work/metro.log" 2>&1 &
for attempt in {1..90}; do
  if curl -fsS http://127.0.0.1:8081/status > /dev/null 2>&1; then break; fi
  sleep 1
done
native_bundle_url="http://127.0.0.1:8081$native_bundle_path"
curl -fsS -o /dev/null --max-time 240 "$native_bundle_url"
if [[ "$platform" == ios ]]; then
  curl -fsSI --max-time 10 "$native_bundle_url" |
    grep -Ei '^content-type: *(application|text)/javascript([;[:space:]]|$)' >/dev/null
fi
