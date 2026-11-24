#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_PLATFORM="${1:?Native platform is required}"
case "$NATIVE_PLATFORM" in android|ios) ;; *) exit 2 ;; esac
NATIVE_DEVICE_ARGS=()
if [[ -n "${2:-}" ]]; then NATIVE_DEVICE_ARGS=(--device "$2"); fi
read -r NATIVE_PROJECT NATIVE_PLAN NATIVE_ASSET NATIVE_CAMERA NATIVE_EVENT NATIVE_LISTING NATIVE_SERVICE NATIVE_PURCHASE < <(node "$NATIVE_DIR/acceptance/fixture.mjs" ids)
run_product_flow() {
  local flow="$1" output="$EVIDENCE/$NATIVE_PLATFORM-$1"
  maestro "${NATIVE_DEVICE_ARGS[@]}" test \
    -e PROJECT_ID="$NATIVE_PROJECT" -e PLAN_ID="$NATIVE_PLAN" \
    -e ASSET_ID="$NATIVE_ASSET" -e CAMERA_ID="$NATIVE_CAMERA" \
    -e CAMERA_EVENT_ID="$NATIVE_EVENT" -e LISTING_ID="$NATIVE_LISTING" -e SERVICE_ID="$NATIVE_SERVICE" -e PURCHASE_INVOICE_ID="$NATIVE_PURCHASE" \
    --format junit --output "$output.xml" \
    --debug-output "$output" --test-output-dir "$output" "$NATIVE_DIR/acceptance/$flow.yaml"
}

if [[ "$NATIVE_PLATFORM" == ios ]]; then
  # XCTest can lose the remote accessibility window during a long sequence.
  # Start a fresh driver at each completed group while retaining the app and
  # fixture state. A failed group still stops the run without replaying writes.
  run_product_flow products-planning
  run_product_flow products-accounting
  run_product_flow products-operations
  run_product_flow products-workspace
else
  run_product_flow products
fi
node "$NATIVE_DIR/acceptance/fixture.mjs" verify-products > "$EVIDENCE/$NATIVE_PLATFORM-product-records.txt"
