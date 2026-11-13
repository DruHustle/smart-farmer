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
    case "$role" in cancel|member|admin) ;; *) exit 2 ;; esac
    context="$role cold"
    if [[ "$role" == cancel ]]; then context=cancel; fi
    run=$(mktemp -d "$work/$role.XXXXXX")
    trap 'rm -rf "$run"' EXIT
    fixture="$RUNNER_TEMP/onesa-device/ready.json"
    read_fixture() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$fixture" "$1"; }
    export TEST_RUNNER_FARMER_ROLE="$role"
    if [[ "$role" == admin ]]; then
      TEST_RUNNER_FARMER_EMAIL=$(read_fixture ADMIN_EMAIL)
      TEST_RUNNER_FARMER_MFA=$(read_fixture ADMIN_MFA)
      export TEST_RUNNER_FARMER_MFA
    elif [[ "$role" == member ]]; then
      TEST_RUNNER_FARMER_EMAIL=$(read_fixture MEMBER_EMAIL)
    fi
    if [[ "$role" != cancel ]]; then
      TEST_RUNNER_FARMER_PASSWORD=$(read_fixture PASSWORD)
      export TEST_RUNNER_FARMER_EMAIL TEST_RUNNER_FARMER_PASSWORD
    fi
    runs=("$work"/build/Build/Products/*.xctestrun)
    [[ ${#runs[@]} == 1 && -f "${runs[0]}" ]] || report_failure test-bundle
    # Xcode logs and .xcresult may contain synthetic inputs. Keep them private on the runner.
    if ! xcodebuild test-without-building -xctestrun "${runs[0]}" -destination "platform=iOS Simulator,id=$device" \
      -parallel-testing-enabled NO -test-timeouts-enabled YES -maximum-test-execution-time-allowance 330 \
      -resultBundlePath "$run/identity.xcresult" \
      -only-testing:FarmerBrowserTests/PortalColdTests/testColdPortal > "$run/xcode.log" 2>&1; then
      # One enum token on a whole line, at most one token in the report.
      last=$(awk '/^FARMER_XCUI_CHECKPOINT (fixture|signedOut|consent|systemPrompt|browserForm|email|password|remember|firstSubmit|mfa|secondSubmit|cancelAction|returnLink|nativeDenial|nativeInvitation|completed)$/ { phase=$2 } END { print phase }' "$run/xcode.log")
      report_failure "${last:-test-launch}"
    fi
    xcrun xcresulttool get test-results summary --path "$run/identity.xcresult" > "$run/summary.json" || report_failure result-summary
    node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1])); if(s.passedTests!==1||s.failedTests!==0||s.skippedTests!==0)process.exit(1)' "$run/summary.json" || report_failure test-count
    ;;
  *) exit 2 ;;
esac
