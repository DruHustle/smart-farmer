#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_APP="$RUNNER_TEMP/native-ios/Build/Products/Release-iphonesimulator/SmartFarmer.app"
NATIVE_IOS_SDK=$(xcrun --sdk iphonesimulator --show-sdk-version)
xcodebuild -version > "$EVIDENCE/ios-toolchain.txt"
printf 'Simulator SDK: %s\n' "$NATIVE_IOS_SDK" >> "$EVIDENCE/ios-toolchain.txt"
xcrun simctl list devices available -j > "$EVIDENCE/ios-device-inventory.json"
NATIVE_PHONE=$(node "$NATIVE_DIR/acceptance/ios-device.mjs" "$NATIVE_IOS_SDK" 'iPhone 17 Pro' "$EVIDENCE/ios-device-inventory.json")
xcrun simctl boot "$NATIVE_PHONE"
xcrun simctl bootstatus "$NATIVE_PHONE" -b
xcrun simctl keychain "$NATIVE_PHONE" add-root-cert "$RUNNER_TEMP/native-tls/ca.pem"
xcrun simctl install "$NATIVE_PHONE" "$NATIVE_APP"
NATIVE_TLS_DIR="$RUNNER_TEMP/native-tls" node "$NATIVE_DIR/acceptance/simulator-tls.mjs" ready >> "$EVIDENCE/ios-tls-after-boot.txt"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-login.xml" --debug-output "$EVIDENCE/ios-login" --test-output-dir "$EVIDENCE/ios-login" "$NATIVE_DIR/acceptance/login.yaml"
touch "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-offline.xml" --debug-output "$EVIDENCE/ios-offline" --test-output-dir "$EVIDENCE/ios-offline" "$NATIVE_DIR/acceptance/offline.yaml"
NATIVE_CONTAINER=$(xcrun simctl get_app_container "$NATIVE_PHONE" eu.onesa.smartfarmer data)
python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$NATIVE_CONTAINER" > "$EVIDENCE/ios-encryption.txt"
rm "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-reconcile.xml" --debug-output "$EVIDENCE/ios-reconcile" --test-output-dir "$EVIDENCE/ios-reconcile" "$NATIVE_DIR/acceptance/reconcile.yaml"
node "$NATIVE_DIR/acceptance/fixture.mjs" verify > "$EVIDENCE/ios-exactly-once.txt"
bash "$NATIVE_DIR/acceptance/product-smoke.sh" ios "$NATIVE_PHONE"
xcrun simctl shutdown "$NATIVE_PHONE"
NATIVE_TABLET=$(node "$NATIVE_DIR/acceptance/ios-device.mjs" "$NATIVE_IOS_SDK" 'iPad Pro 13-inch (M5)' "$EVIDENCE/ios-device-inventory.json")
xcrun simctl boot "$NATIVE_TABLET"
xcrun simctl bootstatus "$NATIVE_TABLET" -b
xcrun simctl keychain "$NATIVE_TABLET" add-root-cert "$RUNNER_TEMP/native-tls/ca.pem"
xcrun simctl ui "$NATIVE_TABLET" content_size accessibility-extra-large
xcrun simctl install "$NATIVE_TABLET" "$NATIVE_APP"
NATIVE_TLS_DIR="$RUNNER_TEMP/native-tls" node "$NATIVE_DIR/acceptance/simulator-tls.mjs" ready >> "$EVIDENCE/ios-tls-after-boot.txt"
maestro --device "$NATIVE_TABLET" test --format junit --output "$EVIDENCE/ipad-large-font.xml" --debug-output "$EVIDENCE/ipad-large-font" --test-output-dir "$EVIDENCE/ipad-large-font" "$NATIVE_DIR/acceptance/login.yaml"
read -r NATIVE_PROJECT NATIVE_REMAINING_IDS < <(node "$NATIVE_DIR/acceptance/fixture.mjs" ids)
maestro --device "$NATIVE_TABLET" test -e PROJECT_ID="$NATIVE_PROJECT" --format junit --output "$EVIDENCE/ipad-products.xml" --debug-output "$EVIDENCE/ipad-products" --test-output-dir "$EVIDENCE/ipad-products" "$NATIVE_DIR/acceptance/tablet.yaml"
