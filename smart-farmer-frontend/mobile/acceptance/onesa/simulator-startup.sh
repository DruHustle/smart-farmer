#!/usr/bin/env bash
set -euo pipefail
# A separate, newly created simulator has no account, credentials, or records.
# Its screenshot may show Expo or OS startup and is deliberately labelled so.
root="$RUNNER_TEMP/native-ios/Build/Products/Debug-iphonesimulator"
[[ -d "$root/SmartFarmer.app" ]] || exit 0
device_type=$(xcrun simctl list devicetypes -j | node -e "let t='';process.stdin.on('data',s=>t+=s).on('end',()=>console.log(JSON.parse(t).devicetypes.find(d=>d.name.startsWith('iPhone 17')).identifier))")
runtime=$(xcrun simctl list runtimes -j | node -e "let t='';process.stdin.on('data',s=>t+=s).on('end',()=>console.log(JSON.parse(t).runtimes.filter(r=>r.isAvailable&&r.name.startsWith('iOS')).at(-1).identifier))")
device=$(xcrun simctl create Farmer-startup-capture "$device_type" "$runtime")
trap 'xcrun simctl shutdown "$device" 2>/dev/null || true; xcrun simctl delete "$device"' EXIT
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$root/SmartFarmer.app"
xcrun simctl launch "$device" eu.onesa.smartfarmer --initialUrl 'smartfarmer://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081&__expo_disable_fab=1&disableFab=1'
sleep 15
mkdir -p "$RUNNER_TEMP/onesa-evidence"
xcrun simctl io "$device" screenshot "$RUNNER_TEMP/onesa-evidence/fresh-simulator-startup.png"
