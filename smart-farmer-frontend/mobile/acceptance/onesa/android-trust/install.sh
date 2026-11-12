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
maestro test -e TEST_LOCK="$pin" --test-output-dir "$work" --debug-output "$work" "$here/settings.yaml"
adb shell am start -W -a com.android.settings.TRUSTED_CREDENTIALS_USER >/dev/null
maestro test --test-output-dir "$work" --debug-output "$work" "$here/installed.yaml"
