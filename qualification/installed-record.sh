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
adb install -r "$mobile/android/app/build/outputs/apk/debug/app-debug.apk"
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
rm "$NATIVE_OFFLINE_FLAG"
curl -fsS http://127.0.0.1:3001/health > /dev/null
printf '%s\n' 'The installed Android app displayed the unique web observation and exact 3 kg quantity online and with the API returning HTTP 503. Restoring the API returned HTTP 200.' > "$proof/android.txt"
