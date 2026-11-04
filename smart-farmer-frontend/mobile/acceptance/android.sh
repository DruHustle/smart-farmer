#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3001 tcp:3001
adb install -r "$NATIVE_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
adb shell am start -n eu.onesa.smartfarmer/.MainActivity
maestro test --format junit --output "$EVIDENCE/android-login.xml" --test-output-dir "$EVIDENCE/android-login" "$NATIVE_DIR/acceptance/login.yaml"
touch "$NATIVE_OFFLINE_FLAG"
maestro test --format junit --output "$EVIDENCE/android-offline.xml" --test-output-dir "$EVIDENCE/android-offline" "$NATIVE_DIR/acceptance/offline.yaml"
mkdir -p "$RUNNER_TEMP/native-encryption"
adb exec-out run-as eu.onesa.smartfarmer tar -cf - files > "$RUNNER_TEMP/native-encryption/cache.tar"
tar -xf "$RUNNER_TEMP/native-encryption/cache.tar" -C "$RUNNER_TEMP/native-encryption"
python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$RUNNER_TEMP/native-encryption" > "$EVIDENCE/android-encryption.txt"
rm "$NATIVE_OFFLINE_FLAG"
maestro test --format junit --output "$EVIDENCE/android-reconcile.xml" --test-output-dir "$EVIDENCE/android-reconcile" "$NATIVE_DIR/acceptance/reconcile.yaml"
node "$NATIVE_DIR/acceptance/fixture.mjs" verify > "$EVIDENCE/android-exactly-once.txt"
bash "$NATIVE_DIR/acceptance/product-smoke.sh" android
# Never upload raw databases, session credentials, or key material as evidence.
rm -rf "$RUNNER_TEMP/native-encryption"
