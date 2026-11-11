#!/usr/bin/env bash
set -euo pipefail
platform="${1:?ios or android}"
dir="$PWD/smart-farmer-frontend/mobile/acceptance/onesa"
fixture="$RUNNER_TEMP/onesa-device/ready.json"
evidence="$RUNNER_TEMP/onesa-evidence"
mkdir -p "$evidence"
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
    if ! bash "$dir/android-trust/install.sh" "$RUNNER_TEMP/onesa-device/ca.crt"; then
      echo 'FAIL Android user CA installation in Settings. Portal sign-in scenarios UNTESTED.' > "$evidence/android-results.txt"
      exit 1
    fi
    ;;
  *) exit 2;;
esac
# Each role starts with a freshly cleared browser and Farmer data. Keep every
# resulting credential, cookie and raw Maestro diagnostic on the runner only.
read_fixture() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$fixture" "$1"; }
status=0
roles=(cancel member admin)
if [[ "$platform" == ios && ${ONESA_IOS_CANCEL_ONLY:-0} == 1 ]]; then roles=(cancel); fi
for role in "${roles[@]}"; do
  if [[ "$platform" == ios ]]; then
    xcrun simctl erase "$device"
    xcrun simctl boot "$device"
    xcrun simctl bootstatus "$device" -b
    xcrun simctl keychain "$device" add-root-cert "$RUNNER_TEMP/onesa-device/ca.crt"
    xcrun simctl install "$device" "$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator/SmartFarmer.app"
  else
    adb shell pm clear com.android.chrome
    adb shell pm clear eu.onesa.smartfarmer
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
    if maestro --device "$device" test "$@" --test-output-dir "$private" --debug-output "$private" "$dir/$state.yaml" > "$private/run.log" 2>&1 &&
       { [[ "$state" == cancel ]] || { mapped=$(node "$dir/verify.mjs" "$role" "$fixture") && [[ "$state" == cold || "$mapped" == "$reference" ]]; }; }; then
      reference="${mapped:-}"
      echo "$role $state PASS" | tee -a "$evidence/$platform-results.txt"
    else
      status=1
      echo "$role $state FAIL" | tee -a "$evidence/$platform-results.txt"
      # List the matching visible controls (never screen text, tokens or input).
      maestro --device "$device" hierarchy > "$private/hierarchy.json" 2>/dev/null || true
      node "$dir/redact.mjs" "$private" | tee -a "$evidence/$platform-results.txt"
      if [[ "$state" == cold ]]; then echo "$role active UNTESTED (cold did not complete)" | tee -a "$evidence/$platform-results.txt"; fi
      break
    fi
  done
  if [[ "$platform" == ios && ${ONESA_IOS_CANCEL_ONLY:-0} == 1 ]]; then
    # Only the existence of known milestone frames leaves the disposable runner.
    # A frame is generated only after the corresponding real UI step completes.
    for checkpoint in cancel-choice-tapped return-link-tapped native-denial-visible signed-out-confirmed; do
      seen=false
      if [[ -n "$(find "$private" -type f -name "*only-${checkpoint}.png" -print -quit)" ]]; then seen=true; fi
      printf 'iOS cancellation %s=%s\n' "$checkpoint" "$seen" | tee -a "$evidence/$platform-results.txt"
    done
  fi
  # Only the intentionally named, confirmed signed-out frame is shareable.
  signed_out=$(find "$RUNNER_TEMP/onesa-device/$role-${states[0]}" -type f -iname '*signed-out-smart-farmer*.png' -print -quit)
  if [[ -n "$signed_out" ]]; then cp "$signed_out" "$evidence/$platform-$role-signed-out.png"; fi
  if [[ "$platform" == ios ]]; then xcrun simctl shutdown "$device"; fi
done
exit "$status"
