#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && -t 0 && -z "${CI:-}" ]] || { echo 'Run in an interactive Terminal on a Mac.' >&2; exit 2; }
: "${RUNNER_TEMP:?Set RUNNER_TEMP to the private acceptance directory}"
: "${DATABASE_URL:?Set DATABASE_URL to the isolated local Farmer test database}"
root=$(git rev-parse --show-toplevel)
cd "$root"
dir="$root/smart-farmer-frontend/mobile/acceptance/onesa"
fixture="$RUNNER_TEMP/onesa-device/ready.json"
log="$RUNNER_TEMP/onesa-device/fixture.log"
binary="$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator/SmartFarmer.app"
test -d "$binary" && test -r "$fixture" && test -r "$log" || { echo 'Prepare the simulator build and fresh Portal device fixture first.' >&2; exit 2; }
farmer=$(git rev-parse HEAD)
portal=$(git -C qualification-portal rev-parse HEAD)
test "$portal" = 5732299004dccef89df144e0ff8362d2342b3a94
node - "$fixture" "$farmer" "$portal" <<'JS'
const fs = require('node:fs');
const [file, farmer, portal] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file));
const db = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(db.hostname) || db.pathname !== '/smart_farmer_test' ||
    farmer !== data.FARMER_REVISION || portal !== data.PORTAL_REVISION ||
    (fs.statSync(file).mode & 0o077) !== 0) {
  throw new Error('Expected private local fixture and matching Farmer and Portal revisions.');
}
JS
private=$(mktemp -d "$RUNNER_TEMP/assisted-admin.XXXXXX")
receipt="$private/ios-admin-assisted.txt"
phase=setup
device=''
cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then printf '%s FAIL\n' "$phase" >> "$receipt"; fi
  if [[ "$phase" == cold && $status -ne 0 ]]; then printf 'admin active UNTESTED (cold did not complete)\n' >> "$receipt"; fi
  if [[ -n "$device" ]]; then
    xcrun simctl shutdown "$device" >/dev/null 2>&1 || true
    xcrun simctl delete "$device" >/dev/null 2>&1 || true
  fi
  printf 'Review receipt: %s\n' "$receipt"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Assisted iPhone Simulator\nFarmer %s\nPortal %s\nUTC %s\n' "$farmer" "$portal" "$(date -u +%FT%TZ)" > "$receipt"
target=$(xcrun simctl list devices available -j | node -e '
let s = ""; process.stdin.on("data", x => s += x).on("end", () => {
  for (const [runtime, devices] of Object.entries(JSON.parse(s).devices)) {
    const phone = devices.find(d => d.isAvailable && d.name.startsWith("iPhone") && d.deviceTypeIdentifier);
    if (phone && runtime.includes(".iOS-")) { console.log(runtime, phone.deviceTypeIdentifier); return; }
  }
  process.exitCode = 1;
});')
read -r runtime model <<< "$target"
device=$(xcrun simctl create "Farmer assisted admin ${private##*.}" "$model" "$runtime")
xcrun simctl bootstatus "$device" -b > "$private/boot.log" 2>&1
xcrun simctl keychain "$device" add-root-cert "$RUNNER_TEMP/onesa-device/ca.crt"
xcrun simctl install "$device" "$binary"
open -a Simulator --args -CurrentDeviceUDID "$device"
printf 'Runtime %s\nModel %s\n' "$runtime" "$model" >> "$receipt"
export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-240000}"
read_fixture() { node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1]))[process.argv[2]])' "$fixture" "$1"; }
run_flow() {
  local flow=$1
  mkdir -p "$private/$phase-$flow"
  maestro --device "$device" test --test-output-dir "$private/$phase-$flow" --debug-output "$private/$phase-$flow" \
    -e INVITE="$(read_fixture ADMIN_INVITE)" -e FARM_NAME="$(read_fixture FARM_NAME)" -e FORUM_TITLE="$(read_fixture FORUM_TITLE)" \
    "$dir/$flow.yaml" > "$private/$phase-$flow.log" 2>&1
}
check_receipts() {
  awk -v from="$1" -v role=admin -v phase="$phase" -f "$dir/verify-ios-receipts.awk" "$log"
  # Export exactly the order that the verifier accepted. Private HTTP details stay in the fixture log.
  awk -v from="$1" 'NR>from && /^ONESA_DEVICE_PORTAL (login|continue|cancel) [1-5][0-9][0-9]$/ { print }
    NR>from && NF==4 && $1=="ONESA_DEVICE_HTTP" && $2~/^(authorize|callback-page|session)$/ &&
    $3~/^[1-5][0-9][0-9]$/ && $4~/^[0-9]+$/ && length($4)==13 { print }' "$log" >> "$receipt"
}
printf 'Choose the Simulator named Farmer assisted admin %s. Open %s in a private local editor for the synthetic administrator fields.\n' "${private##*.}" "$fixture"
phase=cold
run_flow entry
start=$(wc -l < "$log")
printf '%s\n' 'Cold: tap the Farmer Onesa sign-in control, confirm the localhost consent, enter ADMIN_EMAIL and PASSWORD in the issuer form, select Remember this browser, and tap Continue. Enter ADMIN_MFA and tap Continue again. Tap the localized return-to-Farmer link. At the native invitation screen press Return here.'
IFS= read -r _
check_receipts "$start"
run_flow ios-xctest-workspace
cold_user=$(node "$dir/verify.mjs" admin "$fixture")
test -n "$cold_user"
printf 'admin cold PASS (issuer and second factor, native invitation, adviser membership and forum)\n' >> "$receipt"
phase=active
run_flow ios-prepare-reauthenticate
start=$(wc -l < "$log")
printf '%s\n' 'Warm: tap the Farmer Onesa control. If the issuer offers Continue as the remembered administrator, tap it. Tap the localized return link. At the restored Farmer forum press Return here.'
IFS= read -r _
check_receipts "$start"
run_flow active-workspace
warm_user=$(node "$dir/verify.mjs" admin "$fixture")
test "$warm_user" = "$cold_user"
printf 'admin active PASS (same issuer-subject, adviser, farm and forum)\n' >> "$receipt"
