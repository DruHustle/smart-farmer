#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_APP="$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator/SmartFarmer.app"
NATIVE_PHONE=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=Object.values(JSON.parse(s).devices).flat();let d=a.find(x=>x.isAvailable&&x.name.startsWith("iPhone"));if(!d)throw Error("iPhone simulator unavailable");process.stdout.write(d.udid);});')
xcrun simctl boot "$NATIVE_PHONE"
xcrun simctl bootstatus "$NATIVE_PHONE" -b
xcrun simctl install "$NATIVE_PHONE" "$NATIVE_APP"
xcrun simctl launch "$NATIVE_PHONE" eu.onesa.smartfarmer
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-login.xml" --test-output-dir "$EVIDENCE/ios-login" "$NATIVE_DIR/acceptance/login.yaml"
touch "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-offline.xml" --test-output-dir "$EVIDENCE/ios-offline" "$NATIVE_DIR/acceptance/offline.yaml"
NATIVE_CONTAINER=$(xcrun simctl get_app_container "$NATIVE_PHONE" eu.onesa.smartfarmer data)
python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$NATIVE_CONTAINER" > "$EVIDENCE/ios-encryption.txt"
rm "$NATIVE_OFFLINE_FLAG"
maestro --device "$NATIVE_PHONE" test --format junit --output "$EVIDENCE/ios-reconcile.xml" --test-output-dir "$EVIDENCE/ios-reconcile" "$NATIVE_DIR/acceptance/reconcile.yaml"
node "$NATIVE_DIR/acceptance/fixture.mjs" verify > "$EVIDENCE/ios-exactly-once.txt"
xcrun simctl shutdown "$NATIVE_PHONE"
NATIVE_TABLET=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=Object.values(JSON.parse(s).devices).flat();let d=a.find(x=>x.isAvailable&&x.name.startsWith("iPad"));if(!d)throw Error("iPad simulator unavailable");process.stdout.write(d.udid);});')
xcrun simctl boot "$NATIVE_TABLET"
xcrun simctl bootstatus "$NATIVE_TABLET" -b
xcrun simctl ui "$NATIVE_TABLET" content_size accessibility-extra-large
xcrun simctl install "$NATIVE_TABLET" "$NATIVE_APP"
xcrun simctl launch "$NATIVE_TABLET" eu.onesa.smartfarmer
maestro --device "$NATIVE_TABLET" test --format junit --output "$EVIDENCE/ipad-large-font.xml" --test-output-dir "$EVIDENCE/ipad-large-font" "$NATIVE_DIR/acceptance/login.yaml"
