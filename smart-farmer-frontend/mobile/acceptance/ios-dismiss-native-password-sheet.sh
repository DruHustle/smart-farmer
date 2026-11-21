#!/usr/bin/env bash
set -euo pipefail
# Used only after a real, completed simulator login. XCTest may dismiss
# Apple's exact Save Password? sheet (not accessible to Maestro) and must
# independently prove the existing authenticated record tab is visible.
# Never re-submit credentials, revoke sessions, or bypass local unlock.
device=${1:?simulator UDID required}
layout=${2:-ipad}
case "$layout" in ipad|iphone) ;; *) exit 2 ;; esac
native="$PWD/smart-farmer-frontend/mobile"
evidence="$RUNNER_TEMP/native-evidence"
work="$RUNNER_TEMP/onesa-device/native-browser-driver"
mkdir -p "$evidence"
bash "$native/acceptance/onesa/ios-xctest/browser.sh" prepare "$device"
shopt -s nullglob
runs=("$work"/build/Build/Products/*.xctestrun)
[[ ${#runs[@]} == 1 && -f "${runs[0]}" ]] || { echo 'Missing native system UI test runner' >&2; exit 1; }
result="$RUNNER_TEMP/$layout-system-password-dismiss.xcresult"
if ! xcodebuild test-without-building -xctestrun "${runs[0]}" \
    -destination "platform=iOS Simulator,id=$device" \
    -parallel-testing-enabled NO -test-timeouts-enabled YES \
    -maximum-test-execution-time-allowance 180 \
    -resultBundlePath "$result" \
    -only-testing:FarmerBrowserTests/PortalColdTests/testDismissSystemPasswordSheet \
    > "$evidence/ios-system-password-dismiss.log" 2>&1; then
  echo 'Apple system password dismissal or authenticated workspace check failed; native acceptance remains red' >&2
  exit 1
fi
xcrun xcresulttool get test-results summary --path "$result" | node -e '
let raw="";
process.stdin.on("data", x => raw+=x);
process.stdin.on("end", () => {
  const s=JSON.parse(raw);
  if (s.passedTests !== 1 || s.failedTests !== 0 || s.skippedTests !== 0) process.exit(1);
});'
