#!/usr/bin/env bash
set -euo pipefail
mobile=smart-farmer-frontend/mobile
proof="$RUNNER_TEMP/record-proof"
private="$RUNNER_TEMP/record-private"
mkdir -p "$private"
note=$(node -p "require(process.argv[1]).note" "$proof/web.json")
[[ "$note" =~ ^Field\ sample\ [0-9a-f]{8}$ ]]
row="^${note} · 3([.]0+)? kg$"
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3001 tcp:3001
[[ "${CI:-}" == true && "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
test_pin=314159
adb shell locksettings set-pin "$test_pin" > "$private/device-lock.log"
apk="$mobile/android/app/build/outputs/apk/debug/app-debug.apk"
adb install -r "$apk"
package_path=$(adb shell pm path eu.onesa.smartfarmer | tr -d '\r' | sed -n 's/^package://p')
[[ "$package_path" == */base.apk ]]
adb pull "$package_path" "$private/installed.apk" > /dev/null
cmp "$apk" "$private/installed.apk"
sha256sum "$apk" | cut -d ' ' -f 1 > "$proof/installed-apk-sha256.txt"
adb shell am start -n eu.onesa.smartfarmer/.MainActivity
maestro test --test-output-dir "$private/login" --debug-output "$private/login" "$mobile/acceptance/login.yaml" >"$private/login.log" 2>&1 || { echo 'Installed login failed'; exit 1; }
maestro test -e ROW="$row" --test-output-dir "$private/read" --debug-output "$private/read" qualification/read-note.yaml >"$private/read.log" 2>&1 || { echo 'Installed Today observation not found'; exit 1; }
adb exec-out screencap -p > "$proof/android-online.png"
maestro hierarchy > "$private/hierarchy.json"
python3 qualification/verify-visible.py "$private/hierarchy.json" "$note"
touch "$NATIVE_OFFLINE_FLAG"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health)
[[ "$code" == 503 ]]
adb exec-out run-as eu.onesa.smartfarmer tar -cf - files > "$private/cache.tar"
tar -xf "$private/cache.tar" -C "$private"
python3 "$mobile/acceptance/assert-encrypted.py" "$private" > "$proof/encryption.txt"
maestro test -e ROW="$row" --test-output-dir "$private/offline" --debug-output "$private/offline" qualification/read-note.yaml >"$private/offline.log" 2>&1 || { echo 'Cached observation not found while offline'; exit 1; }
adb exec-out screencap -p > "$proof/android-offline.png"
maestro test --test-output-dir "$private/restart" --debug-output "$private/restart" qualification/restart-locked.yaml >"$private/restart.log" 2>&1 || { echo 'Restarted app did not reach its private device lock'; exit 1; }
adb exec-out screencap -p > "$proof/android-restarted-locked.png"
maestro test -e TEST_LOCK="$test_pin" --test-output-dir "$private/unlock" --debug-output "$private/unlock" qualification/unlock-os.yaml >"$private/unlock.log" 2>&1 || { echo 'Device credential did not return to the private app'; exit 1; }
maestro test -e ROW="$row" --test-output-dir "$private/reopened" --debug-output "$private/reopened" qualification/read-note.yaml >"$private/reopened.log" 2>&1 || { echo 'Offline reopened workspace did not contain the original web observation'; exit 1; }
maestro hierarchy > "$private/reopened.json"
python3 qualification/verify-visible.py "$private/reopened.json" "$note"
adb exec-out screencap -p > "$proof/android-reopened-offline.png"
[[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health)" == 503 ]]
echo 'The restarted app was locked. The user entered the disposable Android device PIN through the operating system. The reopened SQLCipher workspace displayed exactly one matching web observation while the API still returned 503.' > "$proof/restart.txt"
rm "$NATIVE_OFFLINE_FLAG"
curl -fsS http://127.0.0.1:3001/health > /dev/null
printf '%s\n' 'The installed Android app displayed the unique web observation and exact 3 kg quantity online and with the API returning HTTP 503. Restoring the API returned HTTP 200.' > "$proof/android.txt"
