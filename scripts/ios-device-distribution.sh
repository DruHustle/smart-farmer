#!/usr/bin/env bash
# Run from the native package after installing its locked dependencies and pods.
set -euo pipefail
action=${1:?Use check, archive, or export}
archive=${2:?Pass an absolute .xcarchive path}
scheme=SmartFarmer
bundle=eu.onesa.smartfarmer
case "$archive" in /*.xcarchive) ;; *) echo 'Use an absolute .xcarchive path.' >&2; exit 2;; esac

inspect_app() {
  local app="$1" binary
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")" = "$bundle"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleSupportedPlatforms:0' "$app/Info.plist")" = iPhoneOS
  binary="$app/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Info.plist")"
  xcrun lipo "$binary" -verify_arch arm64
  xcrun vtool -show-build "$binary" | grep -Eq 'platform[[:space:]]+(IOS|2)$'
  test -s "$app/main.jsbundle"
}
check_distribution_identity() {
  local app="$1" signed_app_id signing_team
  codesign --verify --strict "$app"
  signing_team=$(codesign -dv --verbose=4 "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  test "$signing_team" = "$APPLE_TEAM_ID"
  signed_app_id=$(codesign -d --entitlements - "$app" 2>/dev/null | plutil -extract application-identifier raw -)
  # Apple can assign an App ID prefix distinct from the team identifier.
  test "${signed_app_id#*.}" = "$bundle"
}
case "$action" in
  check|archive)
    test ! -e "$archive" || { echo 'Choose a new archive path.' >&2; exit 1; }
    # The app fails closed if its release bundle has no API origin.
    export EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL:-https://farmer.onesa.eu}
    node --import tsx --input-type=commonjs -e "require('./src/api.ts').apiOrigin(process.env.EXPO_PUBLIC_API_URL, false)"
    options=()
    if [[ "$action" == check ]]; then
      options+=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)
    else
      bash ../../scripts/check-store-policies.sh
      : "${APPLE_TEAM_ID:?Set the enrolled Apple team ID}"
      options+=("DEVELOPMENT_TEAM=$APPLE_TEAM_ID")
    fi
    xcodebuild -workspace "ios/$scheme.xcworkspace" -scheme "$scheme" -configuration Release \
      -sdk iphoneos -destination 'generic/platform=iOS' -archivePath "$archive" \
      "${options[@]}" archive
    inspect_app "$archive/Products/Applications/$scheme.app"
    if [[ "$action" == archive ]]; then check_distribution_identity "$archive/Products/Applications/$scheme.app"; fi
    printf 'Verified generic iPhoneOS ARM64 archive for %s\n' "$bundle"
    ;;
  export)
    : "${APPLE_TEAM_ID:?Set the enrolled Apple team ID}"
    destination=${3:?Pass an empty export directory}
    app="$archive/Products/Applications/$scheme.app"
    inspect_app "$app"
    check_distribution_identity "$app"
    mkdir -p "$destination"
    test -z "$(ls -A "$destination")" || { echo 'Use an empty export directory.' >&2; exit 1; }
    temp=$(mktemp -d)
    trap 'rm -rf "$temp"' EXIT
    python3 - "$temp/ExportOptions.plist" "$APPLE_TEAM_ID" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as output:
    plistlib.dump({'method': 'app-store-connect', 'destination': 'export',
                   'teamID': sys.argv[2], 'signingStyle': 'automatic'}, output)
PY
    xcodebuild -exportArchive -archivePath "$archive" -exportPath "$destination" -exportOptionsPlist "$temp/ExportOptions.plist"
    packages=("$destination"/*.ipa)
    test "${#packages[@]}" -eq 1 && test -s "${packages[0]}"
    ditto -x -k "${packages[0]}" "$temp/ipa"
    exported="$temp/ipa/Payload/$scheme.app"
    inspect_app "$exported"
    check_distribution_identity "$exported"
    codesign -dv --verbose=4 "$exported" 2>&1 | grep -Eq '^Authority=(Apple Distribution|iPhone Distribution):'
    entitlements=$(codesign -d --entitlements - "$exported" 2>/dev/null)
    debug_flag=$(printf '%s' "$entitlements" | plutil -extract get-task-allow raw - 2>/dev/null || true)
    test "$debug_flag" != true && test "$debug_flag" != 1
    printf 'Verified team-signed IPA for %s: %s\n' "$bundle" "${packages[0]}"
    ;;
  *) echo 'Use check, archive, or export.' >&2; exit 2;;
esac
