#!/usr/bin/env bash
set -euo pipefail
platform="${1:?ios or android}"
dir="$PWD/smart-farmer-frontend/mobile/acceptance/onesa"
fixture="$RUNNER_TEMP/onesa-device/ready.json"
evidence="$RUNNER_TEMP/onesa-evidence"
mkdir -p "$evidence"
grant_android_debug_network() {
  # API 37 gates Expo's localhost bundle behind this runtime grant.
  # Clearing the disposable debug app removes it; older images lack the permission.
  if [[ "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" -ge 37 ]]; then
    adb shell pm grant eu.onesa.smartfarmer android.permission.ACCESS_LOCAL_NETWORK
  fi
}
case "$platform" in
  ios)
    device=$(xcrun simctl list devices available -j | node -e "let t='';process.stdin.on('data',s=>t+=s).on('end',()=>console.log(Object.values(JSON.parse(t).devices).flat().find(d=>d.isAvailable&&d.name.startsWith('iPhone')).udid))")
    ;;
  android)
    # Exercise the dedicated Portal run at a 360x640dp compact phone viewport.
    # Both commands operate on this fresh CI emulator. Record what it applied.
    adb shell wm size 720x1280
    adb shell wm density 320
    { adb shell wm size; adb shell wm density; } | tee "$evidence/android-display.txt"
    for port in 8081 46501 46502 46504; do adb reverse tcp:"$port" tcp:"$port"; done
    user_id=$(adb shell am get-current-user | tr -d '\r')
    for attempt in {1..45}; do
      if adb shell am get-started-user-state "$user_id" | grep -q RUNNING_UNLOCKED; then break; fi
      sleep 1
    done
    adb install -r smart-farmer-frontend/mobile/android/app/build/outputs/apk/debug/app-debug.apk
    device=$(adb get-serialno)
    grant_android_debug_network
    # Reading the actual app's sign-in config needs only the local debug API;
    # its signed-out screenshot can survive a separate OS trust failure.
    private="$RUNNER_TEMP/onesa-device/before-trust"
    mkdir -p "$private"
    adb shell am start -n eu.onesa.smartfarmer/.MainActivity
    if maestro --device "$device" test --test-output-dir "$private" --debug-output "$private" "$dir/entry.yaml" > "$private/run.log" 2>&1; then
      screenshot=$(find "$private" -type f -iname '*signed-out-smart-farmer*.png' -print -quit)
      if [[ -n "$screenshot" ]]; then cp "$screenshot" "$evidence/android-signed-out.png"; fi
      echo 'Native sign-in entry shown before credential input' | tee "$evidence/android-entry.txt"
    else
      node "$dir/redact.mjs" "$private" | tee "$evidence/android-entry.txt"
    fi
    ca_private="$RUNNER_TEMP/onesa-device/ca-install"
    mkdir -p "$ca_private"
    if ! bash "$dir/android-trust/install.sh" "$RUNNER_TEMP/onesa-device/ca.crt" > "$ca_private/run.log" 2>&1; then
      echo 'FAIL Android user CA installation in Settings. Portal sign-in scenarios UNTESTED.' > "$evidence/android-results.txt"
      maestro --device "$device" hierarchy > "$ca_private/hierarchy.json" 2>/dev/null || true
      node "$dir/redact.mjs" "$ca_private" > "$evidence/android-ca-landmarks.txt"
      exit 1
    fi
    ;;
  *) exit 2;;
esac
# Each role starts with a freshly cleared browser and Farmer data. Keep every
# resulting credential, cookie and raw Maestro diagnostic on the runner only.
read_fixture() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$fixture" "$1"; }
run_identity_flow() {
  local phase_state="$1" phase_role="$2" phase_dir="$3"
  shift 3
  if [[ "$platform" == android ]]; then
    # One UI driver at a time. Chrome DOM interaction uses the already-open OS
    # browser and its real cookies; it never extracts or injects a callback.
    mkdir -p "$phase_dir/entry" "$phase_dir/complete"
    maestro --device "$device" test "$@" -e FLOW_STATE="$phase_state" --test-output-dir "$phase_dir/entry" --debug-output "$phase_dir/entry" "$dir/android-entry.yaml" > "$phase_dir/entry.log" 2>&1 &&
      node "$dir/chrome-browser.mjs" "$phase_role" "$phase_state" "$fixture" "$device" "$phase_dir/browser-target.json" > "$phase_dir/browser.log" 2>&1 &&
      maestro --device "$device" test "$@" -e FLOW_STATE="$phase_state" --test-output-dir "$phase_dir/complete" --debug-output "$phase_dir/complete" "$dir/android-complete.yaml" > "$phase_dir/complete.log" 2>&1
  else
    mkdir -p "$phase_dir/complete"
    # Prepare the native driver before the app creates the timed PKCE request.
    if [[ "$phase_state" != active ]]; then
      maestro --device "$device" hierarchy > "$phase_dir/driver-ready.json" 2> "$phase_dir/driver-ready.log" || return 1
    fi
    local flow=ios-journey
    if [[ "$phase_state" == cold ]]; then
      # Native consent may transfer focus to SafariViewService. Reattach once
      # before entering either credential; never replay the authorization request.
      mkdir -p "$phase_dir/entry"
      maestro --device "$device" test --no-reinstall-driver "$@" -e FLOW_STATE=cold \
        --test-output-dir "$phase_dir/entry" --debug-output "$phase_dir/entry" \
        "$dir/ios-entry.yaml" > "$phase_dir/entry.log" 2>&1 || return 1
      flow=ios-cold-browser
    fi
    maestro --device "$device" test --no-reinstall-driver "$@" -e FLOW_STATE="$phase_state" \
      --test-output-dir "$phase_dir/complete" --debug-output "$phase_dir/complete" \
      "$dir/$flow.yaml" > "$phase_dir/complete.log" 2>&1
  fi
}
status=0
for role in cancel member admin; do
  if [[ "$platform" == ios ]]; then
    xcrun simctl erase "$device"
    xcrun simctl boot "$device"
    xcrun simctl bootstatus "$device" -b
    xcrun simctl keychain "$device" add-root-cert "$RUNNER_TEMP/onesa-device/ca.crt"
    xcrun simctl install "$device" "$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator/SmartFarmer.app"
  else
    adb shell pm clear com.android.chrome
    adb shell pm clear eu.onesa.smartfarmer
    grant_android_debug_network
    adb shell am start -n eu.onesa.smartfarmer/.MainActivity
  fi
  states=(cancel)
  opts=()
  if [[ "$role" != cancel ]]; then
    states=(cold active)
    prefix=$(echo "$role" | tr '[:lower:]' '[:upper:]')
    opts=(-e ROLE="$role" -e EMAIL="$(read_fixture "${prefix}_EMAIL")" -e PASSWORD="$(read_fixture PASSWORD)" -e MFA="$(read_fixture ADMIN_MFA)" -e INVITE="$(read_fixture "${prefix}_INVITE")" -e FARM_NAME="$(read_fixture FARM_NAME)" -e FORUM_TITLE="$(read_fixture FORUM_TITLE)")
  fi
  reference=''
  for state in "${states[@]}"; do
    private="$RUNNER_TEMP/onesa-device/$role-$state"
    mkdir -p "$private"
    # Add arguments through positional parameters, including the empty cancel set
    # on the older Bash shipped by macOS runners.
    set -- ${opts[@]+"${opts[@]}"}
    # Bind allowlisted issuer responses to the appropriate planned role/phase.
    if [[ "$platform" == ios ]]; then
      portal_log_start=$(wc -l < "$RUNNER_TEMP/onesa-device/fixture.log")
    fi
    if run_identity_flow "$state" "$role" "$private" "$@" &&
       { [[ "$platform" != ios ]] || awk -v from="$portal_log_start" -v role="$role" -v phase="$state" \
           -f "$dir/verify-ios-receipts.awk" "$RUNNER_TEMP/onesa-device/fixture.log"; } &&
       { [[ "$state" == cancel ]] || { mapped=$(node "$dir/verify.mjs" "$role" "$fixture") && [[ "$state" == cold || "$mapped" == "$reference" ]]; }; } &&
       { [[ "$platform" != android ]] || node "$dir/chrome-complete.mjs" "$device" "$private/browser-target.json" > "$private/browser-cleanup.log" 2>&1; }; then
      reference="${mapped:-}"
      echo "$role $state PASS" | tee -a "$evidence/$platform-results.txt"
      passed=true
    else
      status=1
      echo "$role $state FAIL" | tee -a "$evidence/$platform-results.txt"
      # List the matching visible controls (never screen text, tokens or input).
      if [[ "$platform" == ios ]]; then
        maestro --device "$device" hierarchy --no-reinstall-driver > "$private/hierarchy.json" 2>/dev/null || true
      else
        maestro --device "$device" hierarchy > "$private/hierarchy.json" 2>/dev/null || true
      fi
      node "$dir/redact.mjs" "$private" | tee -a "$evidence/$platform-results.txt"
      if [[ "$state" == cold ]]; then echo "$role active UNTESTED (cold did not complete)" | tee -a "$evidence/$platform-results.txt"; fi
      passed=false
    fi
    if [[ "$platform" == ios ]]; then
      # Raw logs, data, credentials and callbacks stay private to the runner.
      awk -v from="$portal_log_start" 'NR>from && NF==4 && $1=="ONESA_DEVICE_HTTP" && $2~/^(authorize|callback-page|session)$/ && $3~/^[1-5][0-9][0-9]$/ && $4~/^[0-9]+$/ && length($4)==13 { print }' "$RUNNER_TEMP/onesa-device/fixture.log" | tee -a "$evidence/$platform-results.txt"
      awk -v from="$portal_log_start" 'NR>from && /^ONESA_DEVICE_PORTAL (login|continue|cancel) [1-5][0-9][0-9]$/ {print; seen=1} END {if (!seen) print "No Portal interaction submission response observed for this attempt."}' "$RUNNER_TEMP/onesa-device/fixture.log" | tee -a "$evidence/$platform-results.txt"
    fi
    if [[ "$passed" == false ]]; then break; fi
  done
  # Only the intentionally named, confirmed signed-out frame is shareable.
  signed_out=$(find "$RUNNER_TEMP/onesa-device/$role-${states[0]}" -type f -iname '*signed-out-smart-farmer*.png' -print -quit)
  if [[ -n "$signed_out" ]]; then cp "$signed_out" "$evidence/$platform-$role-signed-out.png"; fi
  if [[ "$platform" == ios ]]; then xcrun simctl shutdown "$device"; fi
done
exit "$status"
