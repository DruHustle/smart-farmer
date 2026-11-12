#!/usr/bin/env bash
set -euo pipefail
# Drive the platform Settings certificate installer on this disposable AVD.
# The user's CA must be present in Trusted credentials before Chrome is opened.
[[ -n "${CI:-}" && "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
here=$(cd "$(dirname "$0")" && pwd)
work="$RUNNER_TEMP/onesa-device/ca-install"
mkdir -p "$work"
openssl x509 -in "${1:?Public fixture CA required}" -outform DER -out "$work/farmer-device-ca.crt"
# Ask the display user to choose the public CA through the normal DocumentsUI
# picker. Play's modern scoped storage disallows shell writes to Downloads.
bash "$here/provider/install.sh" "$work/farmer-device-ca.crt"
# Credential storage can ask for the secure lock in either side of the picker.
pin=314159
adb shell locksettings set-pin "$pin"
adb shell am start -W -a com.android.settings.security.SECURITY_ADVANCED_SETTINGS >/dev/null
if ! maestro test -e TEST_LOCK="$pin" --test-output-dir "$work" --debug-output "$work" "$here/settings.yaml"; then
  # The OS picker runs outside Farmer. Keep raw UI and system messages private;
  # log only known system resource IDs, fixed public labels and error classes.
  device_dump=/data/local/tmp/onesa-picker-qualification.xml
  adb shell uiautomator dump "$device_dump" >/dev/null 2>&1 || true
  adb exec-out cat "$device_dump" > "$work/system-picker.xml" 2>/dev/null || true
  adb shell rm -f "$device_dump"
  adb logcat -d -s DirectoryLoader DocumentsUI DocumentsProvider > "$work/picker-system.log" || true
  python3 "$here/picker-diagnostics.py" "$work/system-picker.xml" "$work/picker-system.log"
  exit 1
fi
adb shell am start -W -a com.android.settings.TRUSTED_CREDENTIALS_USER >/dev/null
maestro test --test-output-dir "$work" --debug-output "$work" "$here/installed.yaml"
# A subject label can match more than one certificate. Verify the exact public
# DER in Android's user CA store before the browser qualifies any real login.
proof=$(adb shell am instrument -w -e verifyInstalled true eu.onesa.qualification.documents/.ProviderCheck)
printf '%s\n' "$proof"
grep -Fq 'trustedIssuerProof=exact-user-ca-sha256' <<< "$proof"
