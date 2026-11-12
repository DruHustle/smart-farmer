#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_APP="$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator/SmartFarmer.app"
NATIVE_LOG_PID=''
NATIVE_THREAD_WATCH_PID=''
NATIVE_THREAD_STOP_FILE=''
stop_native_log() {
  if [[ -n "$NATIVE_THREAD_WATCH_PID" ]]; then
    : > "$NATIVE_THREAD_STOP_FILE" 2>/dev/null || true
    wait "$NATIVE_THREAD_WATCH_PID" 2>/dev/null || true
    NATIVE_THREAD_WATCH_PID=''
    NATIVE_THREAD_STOP_FILE=''
  fi
  if [[ -n "$NATIVE_LOG_PID" ]]; then
    kill "$NATIVE_LOG_PID" 2>/dev/null || true
    wait "$NATIVE_LOG_PID" 2>/dev/null || true
    NATIVE_LOG_PID=''
  fi
}
finish_native_run() {
  local result=$?
  stop_native_log
  if (( result != 0 )); then
    # Only enumerated markers, without preceding or following OS/JS log data.
    node "$NATIVE_DIR/acceptance/onesa/signout-phases.mjs" "$EVIDENCE/ios-phone-startup.log" "$EVIDENCE/metro.log"
  fi
  return "$result"
}
trap finish_native_run EXIT
start_native_log() {
  local native_device="$1" native_label="$2" native_thread_output native_log
  case "$native_label" in
    ios-phone) native_thread_output="$EVIDENCE/ios-thread-observation.json" ;;
    ios-tablet) native_thread_output="$EVIDENCE/ios-tablet-thread-observation.json" ;;
    *) return 2 ;;
  esac
  native_log="$EVIDENCE/$native_label-startup.log"
  # Create the fresh file before either background process can be scheduled.
  (
    umask 077
    set -o noclobber
    : > "$native_log"
  )
  # Retain app logs before Maestro initializes its driver and launches the app.
  printf 'Native log capture requested at %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$EVIDENCE/$native_label-log-capture.txt"
  xcrun simctl spawn "$native_device" log stream --style syslog --level debug --predicate 'process == "SmartFarmer"' >> "$native_log" 2>&1 &
  NATIVE_LOG_PID=$!
  NATIVE_THREAD_STOP_FILE="$RUNNER_TEMP/farmer-darwin-thread/stop-$native_label"
  node "$NATIVE_DIR/acceptance/darwin-thread-watch.cjs" "$native_label" > "$native_thread_output" 2>/dev/null &
  NATIVE_THREAD_WATCH_PID=$!
}
run_native_login() {
  local device="$1" layout="$2" label="$3"
  local report="$EVIDENCE/$label.xml" prompt_image="$RUNNER_TEMP/$layout-current-password-sheet.png" prompt_point
  if maestro --device "$device" test --format junit --output "$report" --debug-output "$EVIDENCE/$label" --flatten-debug-output --test-output-dir "$EVIDENCE/$label" "$NATIVE_DIR/acceptance/login.yaml"; then
    return 0
  fi
  # Capture the current system UI. Accept only the specific blocked assertion
  # and full matching AutoFill sheet; never replay the completed sign-in.
  xcrun simctl io "$device" screenshot "$prompt_image"
  if ! prompt_point=$(python3 "$NATIVE_DIR/acceptance/ios-password-sheet.py" "$report" "$prompt_image" "$layout"); then
    rm -f "$prompt_image"
    return 1
  fi
  mv "$prompt_image" "$EVIDENCE/$layout-confirmed-system-password-sheet.png"
  mv "$report" "$EVIDENCE/$label-before-password-sheet.xml"
  maestro --device "$device" test --no-reinstall-driver -e NOT_NOW_POINT="$prompt_point" \
    --format junit --output "$report" --test-output-dir "$EVIDENCE/$layout-after-password-sheet" \
    "$NATIVE_DIR/acceptance/ios-resume-after-password-sheet.yaml"
}
NATIVE_PHONE=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=Object.values(JSON.parse(s).devices).flat();let d=a.find(x=>x.isAvailable&&x.name.startsWith("iPhone"));if(!d)throw Error("iPhone simulator unavailable");process.stdout.write(d.udid);});')
xcrun simctl boot "$NATIVE_PHONE"
xcrun simctl bootstatus "$NATIVE_PHONE" -b
xcrun simctl install "$NATIVE_PHONE" "$NATIVE_APP"
start_native_log "$NATIVE_PHONE" ios-phone
run_native_login "$NATIVE_PHONE" iphone ios-login
touch "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-offline.xml" --test-output-dir "$EVIDENCE/ios-offline" "$NATIVE_DIR/acceptance/offline.yaml"
NATIVE_CONTAINER=$(xcrun simctl get_app_container "$NATIVE_PHONE" eu.onesa.smartfarmer data)
python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$NATIVE_CONTAINER" > "$EVIDENCE/ios-encryption.txt"
rm "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-reconcile.xml" --test-output-dir "$EVIDENCE/ios-reconcile" "$NATIVE_DIR/acceptance/reconcile.yaml"
node "$NATIVE_DIR/acceptance/fixture.mjs" verify > "$EVIDENCE/ios-exactly-once.txt"
bash "$NATIVE_DIR/acceptance/product-smoke.sh" ios "$NATIVE_PHONE"
bash "$NATIVE_DIR/acceptance/accounting-intake.sh" ios "$NATIVE_PHONE"
stop_native_log
xcrun simctl shutdown "$NATIVE_PHONE"
NATIVE_TABLET=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=Object.values(JSON.parse(s).devices).flat();let d=a.find(x=>x.isAvailable&&x.name.startsWith("iPad"));if(!d)throw Error("iPad simulator unavailable");process.stdout.write(d.udid);});')
xcrun simctl boot "$NATIVE_TABLET"
xcrun simctl bootstatus "$NATIVE_TABLET" -b
xcrun simctl ui "$NATIVE_TABLET" content_size accessibility-extra-large
xcrun simctl install "$NATIVE_TABLET" "$NATIVE_APP"
start_native_log "$NATIVE_TABLET" ios-tablet
run_native_login "$NATIVE_TABLET" ipad ipad-large-font
read -r NATIVE_PROJECT NATIVE_REMAINING_IDS < <(node "$NATIVE_DIR/acceptance/fixture.mjs" ids)
maestro --device "$NATIVE_TABLET" test -e PROJECT_ID="$NATIVE_PROJECT" --format junit --output "$EVIDENCE/ipad-products.xml" --test-output-dir "$EVIDENCE/ipad-products" "$NATIVE_DIR/acceptance/tablet.yaml"
