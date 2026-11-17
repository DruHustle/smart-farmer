#!/usr/bin/env bash
set -euo pipefail
umask 077
mode=${1:?prepare or test}
device=${2:?simulator UDID}
dir=$(cd "$(dirname "$0")" && pwd)
work="$RUNNER_TEMP/onesa-device/native-browser-driver"
evidence="$RUNNER_TEMP/onesa-evidence"
context=prepare
mkdir -p "$evidence"
# Xcode may log input and accessibility trees. Report the operation and an
# explicitly known checkpoint only. Keep compiler output and xcresult private.
report_failure() {
  local stage="$1"
  printf 'FAIL iOS native browser driver: %s\n' "$context $stage" | tee -a "$evidence/ios-results.txt" >&2
  exit 1
}
case "$mode" in
  prepare)
    mkdir -p "$work"
    if ! ruby -rxcodeproj -e 'exit' >/dev/null 2>&1; then
      gem install xcodeproj --version 1.27.0 --install-dir "$work/gems" --no-document > "$work/gems.log" 2>&1 || report_failure project-dependency
      export GEM_PATH="$work/gems:$(ruby -e 'puts Gem.path.join(":")')"
    fi
    ruby "$dir/project.rb" "$work/project" > "$work/project.log" 2>&1 || report_failure project-generation
    xcodebuild build-for-testing -project "$work/project/FarmerBrowser.xcodeproj" -scheme FarmerBrowser \
      -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$work/build" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
      > "$work/build.log" 2>&1 || report_failure simulator-build
    ;;
  test)
    role=${3:?cancel, member or admin}
    case "$role" in
      cancel) context="cancel cancel"; test_name=testCancelPortal ;;
      member|admin) context="$role cold"; test_name=testColdPortal ;;
      *) exit 2 ;;
    esac
    run=$(mktemp -d "$work/$role.XXXXXX")
    capture_pid=
    stop_capture() {
      if [[ -n "$capture_pid" ]]; then
        if jobs -pr | grep -qx "$capture_pid"; then kill "$capture_pid" 2>/dev/null || true; fi
        wait "$capture_pid" 2>/dev/null || true
        capture_pid=
      fi
    }
    trap 'stop_capture; rm -rf "$run"' EXIT
    fixture="$RUNNER_TEMP/onesa-device/ready.json"
    export TEST_RUNNER_FARMER_XCUI_EVIDENCE_DIR="$evidence"
    read_fixture() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$fixture" "$1"; }
    export TEST_RUNNER_FARMER_ROLE="$role"
    # Cancellation does not require or load credentials from the fixture.
    if [[ "$role" != cancel ]]; then
      if [[ "$role" == admin ]]; then
        TEST_RUNNER_FARMER_EMAIL=$(read_fixture ADMIN_EMAIL)
        TEST_RUNNER_FARMER_MFA=$(read_fixture ADMIN_MFA)
        export TEST_RUNNER_FARMER_MFA
      else
        TEST_RUNNER_FARMER_EMAIL=$(read_fixture MEMBER_EMAIL)
      fi
      TEST_RUNNER_FARMER_INVITE=$(read_fixture "$(echo "$role" | tr '[:lower:]' '[:upper:]')_INVITE")
      TEST_RUNNER_FARMER_FARM=$(read_fixture FARM_NAME)
      TEST_RUNNER_FARMER_DISCUSSION=$(read_fixture FORUM_TITLE)
      export TEST_RUNNER_FARMER_INVITE TEST_RUNNER_FARMER_FARM TEST_RUNNER_FARMER_DISCUSSION
      TEST_RUNNER_FARMER_PASSWORD=$(read_fixture PASSWORD)
      export TEST_RUNNER_FARMER_EMAIL TEST_RUNNER_FARMER_PASSWORD
    fi
    runs=("$work"/build/Build/Products/*.xctestrun)
    [[ ${#runs[@]} == 1 && -f "${runs[0]}" ]] || report_failure test-bundle
    fixture_log="$RUNNER_TEMP/onesa-device/fixture.log"
    for attempt in 1 2; do
      result="$run/identity-$attempt.xcresult"
      log="$run/xcode-$attempt.log"
      if [[ "$role" == cancel ]]; then
        initial_lines=$(wc -l < "$fixture_log")
        python3 "$dir/failure-evidence.py" watch-cancel "$log" "$device" "$evidence" &
        capture_pid=$!
      fi
      if xcodebuild test-without-building -xctestrun "${runs[0]}" -destination "platform=iOS Simulator,id=$device" \
        -parallel-testing-enabled NO -test-timeouts-enabled YES -maximum-test-execution-time-allowance 330 \
        -resultBundlePath "$result" \
        -only-testing:FarmerBrowserTests/PortalColdTests/"$test_name" > "$log" 2>&1; then
        stop_capture
        break
      fi
      stop_capture
      last=$(awk '/^FARMER_XCUI_CHECKPOINT (fixture|signedOut|localLauncher|introduction|developerMenu|signInControl|consent|email|password|remember|firstSubmit|mfa|secondSubmit|returnLink|nativeInvitation|joinFarm|farmWorkspace|forumTab|forumScreen|forumFeed|completed)$/ { phase=$2 } END { print phase }' "$log")
      # XCTest can abort during a snapshot before the Swift capture hook runs.
      # Capture from the host only before credentials, and emit fixed categories
      # plus source line numbers instead of copying private XCTest output.
      python3 "$dir/failure-evidence.py" "$log" "$role" "${last:-test-launch}" "$device" "$evidence"
      [[ "$role" == cancel && "$attempt" == 1 && -z "$last" ]] || report_failure "${last:-test-launch}"
      xcrun xcresulttool get test-results summary --path "$result" > "$run/summary.json" 2> "$run/result-error.log" || true
      reason=$(python3 "$dir/failure-evidence.py" launch-retry "$log" "$run/summary.json" "$fixture_log" "$initial_lines") || report_failure test-launch
      mv "$evidence/ios-cancel-failure.json" "$evidence/ios-cancel-first-launch.json"
      printf 'First cancellation runner failed before the test (%s). Restarting simulator once.\n' "$reason" | tee -a "$evidence/ios-results.txt"
      # Reboot the existing device with its installed Farmer, trusted CA and
      # original issuer. The next attempt must execute the full denial journey.
      xcrun simctl shutdown "$device" > "$run/shutdown.log" 2>&1 || report_failure simulator-shutdown
      xcrun simctl bootstatus "$device" -b > "$run/boot.log" 2>&1 || report_failure simulator-boot
    done
    xcrun xcresulttool get test-results summary --path "$result" > "$run/summary.json" || report_failure result-summary
    node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1])); if(s.passedTests!==1||s.failedTests!==0||s.skippedTests!==0)process.exit(1)' "$run/summary.json" || report_failure test-count
    ;;
  *) exit 2 ;;
esac
