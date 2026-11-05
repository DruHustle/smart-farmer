#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_PLATFORM="${1:?Native platform is required}"
case "$NATIVE_PLATFORM" in android|ios) ;; *) exit 2 ;; esac
NATIVE_DEVICE_ARGS=()
if [[ -n "${2:-}" ]]; then NATIVE_DEVICE_ARGS=(--device "$2"); fi
read -r NATIVE_PROJECT NATIVE_PLAN NATIVE_ASSET NATIVE_CAMERA NATIVE_EVENT NATIVE_LISTING NATIVE_SERVICE < <(node "$NATIVE_DIR/acceptance/fixture.mjs" ids)
maestro "${NATIVE_DEVICE_ARGS[@]}" test \
  -e PROJECT_ID="$NATIVE_PROJECT" -e PLAN_ID="$NATIVE_PLAN" \
  -e ASSET_ID="$NATIVE_ASSET" -e CAMERA_ID="$NATIVE_CAMERA" \
  -e CAMERA_EVENT_ID="$NATIVE_EVENT" -e LISTING_ID="$NATIVE_LISTING" -e SERVICE_ID="$NATIVE_SERVICE" \
  --format junit --output "$EVIDENCE/$NATIVE_PLATFORM-products.xml" \
  --debug-output "$EVIDENCE/$NATIVE_PLATFORM-products" --test-output-dir "$EVIDENCE/$NATIVE_PLATFORM-products" "$NATIVE_DIR/acceptance/products.yaml"
node "$NATIVE_DIR/acceptance/fixture.mjs" verify-products > "$EVIDENCE/$NATIVE_PLATFORM-product-records.txt"
