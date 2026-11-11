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
    for port in 8081 46501 46502 46504; do adb reverse tcp:"$port" tcp:"$port"; done
    bash "$dir/android-trust/install.sh" "$RUNNER_TEMP/onesa-device/ca.crt"
    adb install -r smart-farmer-frontend/mobile/android/app/build/outputs/apk/debug/app-debug.apk
    device=$(adb get-serialno)
    ;;
  *) exit 2;;
esac
# Each role starts with a freshly cleared browser and Farmer data. Keep every
# resulting credential, cookie and raw Maestro diagnostic on the runner only.
read_fixture() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$fixture" "$1"; }
status=0
for role in member admin; do
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
  prefix=$(echo "$role" | tr '[:lower:]' '[:upper:]')
  email=$(read_fixture "${prefix}_EMAIL")
  opts=(-e ROLE="$role" -e EMAIL="$email" -e PASSWORD="$(read_fixture PASSWORD)" -e MFA="$(read_fixture ADMIN_MFA)" -e INVITE="$(read_fixture "${prefix}_INVITE")" -e FARM_NAME="$(read_fixture FARM_NAME)" -e FORUM_TITLE="$(read_fixture FORUM_TITLE)")
  reference=''
  for state in cold active; do
    private="$RUNNER_TEMP/onesa-device/$role-$state"
    mkdir -p "$private"
    if maestro --device "$device" test "${opts[@]}" --test-output-dir "$private" --debug-output "$private" "$dir/$state.yaml" > "$private/run.log" 2>&1 &&
       mapped=$(node "$dir/verify.mjs" "$role" "$fixture") && [[ "$state" == cold || "$mapped" == "$reference" ]]; then
      reference="$mapped"
      echo "$role $state PASS" | tee -a "$evidence/$platform-results.txt"
    else
      status=1
      echo "$role $state FAIL" | tee -a "$evidence/$platform-results.txt"
      # List the matching visible controls (never screen text, tokens or input).
      maestro --device "$device" hierarchy > "$private/hierarchy.json" 2>/dev/null || true
      node "$dir/redact.mjs" "$private" >> "$evidence/$platform-results.txt"
      if [[ "$state" == cold ]]; then echo "$role active UNTESTED (cold did not complete)" >> "$evidence/$platform-results.txt"; fi
      break
    fi
  done
  if [[ "$platform" == ios ]]; then xcrun simctl shutdown "$device"; fi
done
exit "$status"
