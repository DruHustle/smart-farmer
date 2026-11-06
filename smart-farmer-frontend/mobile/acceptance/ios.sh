#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_APP="$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator/SmartFarmer.app"
# Expo's pinned native launcher accepts the project URI at process startup.
NATIVE_PROJECT_URL='smartfarmer://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081&__expo_disable_fab=1&disableFab=1'
NATIVE_LOG_PID=''
stop_native_log() {
  if [[ -n "$NATIVE_LOG_PID" ]]; then
    kill "$NATIVE_LOG_PID" 2>/dev/null || true
    wait "$NATIVE_LOG_PID" 2>/dev/null || true
    NATIVE_LOG_PID=''
  fi
}
trap stop_native_log EXIT
launch_native_app() {
  local native_device="$1" native_label="$2" native_launch_output native_app_pid
  # Maestro starts logging after driver setup; retain the app's earlier startup too.
  xcrun simctl spawn "$native_device" log stream --style syslog --level debug --predicate 'process == "SmartFarmer"' > "$EVIDENCE/$native_label-startup.log" 2>&1 &
  NATIVE_LOG_PID=$!
  printf 'Launch requested at %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$EVIDENCE/$native_label-launch.txt"
  native_launch_output=$(xcrun simctl launch "$native_device" eu.onesa.smartfarmer --initialUrl "$NATIVE_PROJECT_URL")
  printf '%s\n' "$native_launch_output" | tee -a "$EVIDENCE/$native_label-launch.txt"
  native_app_pid="${native_launch_output##*: }"
  if [[ "$native_app_pid" =~ ^[0-9]+$ ]]; then
    ps -ww -p "$native_app_pid" -o pid= -o command= > "$EVIDENCE/$native_label-argv.txt" 2>&1 || printf 'Target argv capture unavailable\n' >> "$EVIDENCE/$native_label-argv.txt"
  else
    printf 'No target PID in simctl launch output\n' > "$EVIDENCE/$native_label-argv.txt"
  fi
}
NATIVE_PHONE=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=Object.values(JSON.parse(s).devices).flat();let d=a.find(x=>x.isAvailable&&x.name.startsWith("iPhone"));if(!d)throw Error("iPhone simulator unavailable");process.stdout.write(d.udid);});')
xcrun simctl boot "$NATIVE_PHONE"
xcrun simctl bootstatus "$NATIVE_PHONE" -b
xcrun simctl install "$NATIVE_PHONE" "$NATIVE_APP"
launch_native_app "$NATIVE_PHONE" ios-phone
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-login.xml" --test-output-dir "$EVIDENCE/ios-login" "$NATIVE_DIR/acceptance/login.yaml"
touch "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-offline.xml" --test-output-dir "$EVIDENCE/ios-offline" "$NATIVE_DIR/acceptance/offline.yaml"
NATIVE_CONTAINER=$(xcrun simctl get_app_container "$NATIVE_PHONE" eu.onesa.smartfarmer data)
python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$NATIVE_CONTAINER" > "$EVIDENCE/ios-encryption.txt"
rm "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-reconcile.xml" --test-output-dir "$EVIDENCE/ios-reconcile" "$NATIVE_DIR/acceptance/reconcile.yaml"
node "$NATIVE_DIR/acceptance/fixture.mjs" verify > "$EVIDENCE/ios-exactly-once.txt"
bash "$NATIVE_DIR/acceptance/product-smoke.sh" ios "$NATIVE_PHONE"
stop_native_log
xcrun simctl shutdown "$NATIVE_PHONE"
NATIVE_TABLET=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=Object.values(JSON.parse(s).devices).flat();let d=a.find(x=>x.isAvailable&&x.name.startsWith("iPad"));if(!d)throw Error("iPad simulator unavailable");process.stdout.write(d.udid);});')
xcrun simctl boot "$NATIVE_TABLET"
xcrun simctl bootstatus "$NATIVE_TABLET" -b
xcrun simctl ui "$NATIVE_TABLET" content_size accessibility-extra-large
xcrun simctl install "$NATIVE_TABLET" "$NATIVE_APP"
launch_native_app "$NATIVE_TABLET" ios-tablet
maestro --device "$NATIVE_TABLET" test --format junit --output "$EVIDENCE/ipad-large-font.xml" --test-output-dir "$EVIDENCE/ipad-large-font" "$NATIVE_DIR/acceptance/login.yaml"
read -r NATIVE_PROJECT NATIVE_REMAINING_IDS < <(node "$NATIVE_DIR/acceptance/fixture.mjs" ids)
maestro --device "$NATIVE_TABLET" test -e PROJECT_ID="$NATIVE_PROJECT" --format junit --output "$EVIDENCE/ipad-products.xml" --test-output-dir "$EVIDENCE/ipad-products" "$NATIVE_DIR/acceptance/tablet.yaml"
