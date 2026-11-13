#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_APP="$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator/SmartFarmer.app"
NATIVE_SUITE="${1:-farm}"
case "$NATIVE_SUITE" in farm|invoice) ;; *) exit 2 ;; esac
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
  local device="$1" layout="$2" label="$3" flow="${4:-login}"
  local report="$EVIDENCE/$label.xml" prompt_image="$RUNNER_TEMP/$layout-current-password-sheet.png" prompt_point
  if maestro --device "$device" test --format junit --output "$report" --debug-output "$EVIDENCE/$label" --flatten-debug-output --test-output-dir "$EVIDENCE/$label" "$NATIVE_DIR/acceptance/$flow.yaml"; then
    return 0
  fi
  # One user retry is allowed only in the isolated invoice fixture, on the
  # initial sign-in screen. No account proof, financial action or record is replayed.
  if [[ "$NATIVE_SUITE" == invoice && "$flow" == login && "$label" == ios-login ]]; then
    local login_case
    for login_case in closed-response client-validation; do
      if python3 "$NATIVE_DIR/acceptance/ios-login-delivery.py" "$EVIDENCE" "$login_case"; then
        mv "$report" "$EVIDENCE/$label-before-$login_case.xml"
        printf '%s\n' "$login_case" > "$EVIDENCE/$label-recovery.txt"
        maestro --device "$device" test --no-reinstall-driver -e LOGIN_CASE="$login_case" --format junit --output "$report" \
          --test-output-dir "$EVIDENCE/$label-after-$login_case" "$NATIVE_DIR/acceptance/ios-retry-invoice-login.yaml"
        return $?
      fi
    done
  fi
  local check="$NATIVE_DIR/acceptance/ios-password-sheet.py" checkpoint
  local resume="$NATIVE_DIR/acceptance/ios-resume-after-password-sheet.yaml"
  checkpoint=$(python3 "$check" checkpoint "$report" "$EVIDENCE/$label/$flow/commands.json") || return 1
  xcrun simctl io "$device" screenshot "$prompt_image" || return 1
  if ! prompt_point=$(python3 "$check" locate "$prompt_image" "$layout"); then
    if [[ "$checkpoint" == record-assertion ]]; then
      # On a failed Record assertion, require the exact sheet in the failure frame.
      local failed_frames=("$EVIDENCE/$label/$flow/screenshots"/step-*-assertCondition-tab-record.png)
      if [[ ${#failed_frames[@]} != 1 || ! -f "${failed_frames[0]}" ]] ||
         ! python3 "$check" locate "${failed_frames[0]}" "$layout" > /dev/null; then
        rm -f "$prompt_image"
        return 1
      fi
    fi
    # The submitted-login trace can end inside Apple's decline handler when
    # XCTest disconnects. Restore focus without resubmitting the login.
    xcrun simctl launch "$device" eu.onesa.smartfarmer > /dev/null || return 1
    xcrun simctl io "$device" screenshot "$prompt_image" || return 1
    if ! prompt_point=$(python3 "$check" locate "$prompt_image" "$layout"); then
      # Never tap coordinates from an old frame. Require real signed-in controls.
      resume="$NATIVE_DIR/acceptance/record-after-login.yaml"
    fi
  fi
  set --
  if [[ -n "$prompt_point" ]]; then
    set -- -e NOT_NOW_POINT="$prompt_point"
    mv "$prompt_image" "$EVIDENCE/$layout-confirmed-system-password-sheet.png"
  else
    rm -f "$prompt_image"
  fi
  mv "$report" "$EVIDENCE/$label-before-password-sheet.xml"
  maestro --device "$device" test --no-reinstall-driver "$@" \
    --format junit --output "$report" --test-output-dir "$EVIDENCE/$label-after-password-sheet" \
    "$resume"
}
NATIVE_PHONE=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=Object.values(JSON.parse(s).devices).flat();let d=a.find(x=>x.isAvailable&&x.name.startsWith("iPhone"));if(!d)throw Error("iPhone simulator unavailable");process.stdout.write(d.udid);});')
xcrun simctl boot "$NATIVE_PHONE"
xcrun simctl bootstatus "$NATIVE_PHONE" -b
# A customer already has the source photo before signing in. Seed the real
# OS library before opening Farmer; opening Photos later would lock the app.
NATIVE_INVOICE_IMAGE="$NATIVE_DIR/acceptance/assets/native-supplier-invoice.png"
node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" image "$NATIVE_INVOICE_IMAGE" > "$EVIDENCE/ios-intake-source.txt"
xcrun simctl launch "$NATIVE_PHONE" com.apple.mobileslideshow > /dev/null
xcrun simctl addmedia "$NATIVE_PHONE" "$NATIVE_INVOICE_IMAGE"
printf '%s\n' 'Apple Simulator imported the synthetic invoice into Photos before sign-in.' >> "$EVIDENCE/ios-intake-source.txt"
xcrun simctl install "$NATIVE_PHONE" "$NATIVE_APP"
start_native_log "$NATIVE_PHONE" ios-phone
run_native_login "$NATIVE_PHONE" iphone ios-login
if [[ "$NATIVE_SUITE" == invoice ]]; then
  # Independent clean install and seeded API. The full farm suite below keeps
  # its original order, including all product and accounting assertions.
  bash "$NATIVE_DIR/acceptance/accounting-intake.sh" ios "$NATIVE_PHONE"
  stop_native_log
  xcrun simctl shutdown "$NATIVE_PHONE"
  exit 0
fi
touch "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-offline.xml" --test-output-dir "$EVIDENCE/ios-offline" "$NATIVE_DIR/acceptance/offline.yaml"
NATIVE_CONTAINER=$(xcrun simctl get_app_container "$NATIVE_PHONE" eu.onesa.smartfarmer data)
python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$NATIVE_CONTAINER" > "$EVIDENCE/ios-encryption.txt"
rm "$NATIVE_OFFLINE_FLAG"
# AutoFill can offer to save the password again when the offline workspace is
# unlocked. Recover only at the post-sign-in checkpoint, before any record work.
run_native_login "$NATIVE_PHONE" iphone ios-reconcile-login reconcile-signin
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-reconcile.xml" --test-output-dir "$EVIDENCE/ios-reconcile" "$NATIVE_DIR/acceptance/reconcile-records.yaml"
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
