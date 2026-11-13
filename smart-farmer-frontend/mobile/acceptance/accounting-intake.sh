#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$PWD/smart-farmer-frontend/mobile"
EVIDENCE="$RUNNER_TEMP/native-evidence"
NATIVE_PLATFORM="${1:?Pass android or ios}"
case "$NATIVE_PLATFORM" in android|ios) ;; *) exit 2 ;; esac
NATIVE_DEVICE_ARGS=()
if [[ -n "${2:-}" ]]; then NATIVE_DEVICE_ARGS=(--device "$2"); fi
export MEDIA_ROOT="$RUNNER_TEMP/native-private-media"
export NATIVE_INTAKE_STATE="$RUNNER_TEMP/native-intake-state.json"
NATIVE_INTAKE_PRIVATE="$RUNNER_TEMP/native-intake-private"
NATIVE_WORKER_PID=''
cleanup_intake() {
  if [ -n "$NATIVE_WORKER_PID" ]; then
    kill "$NATIVE_WORKER_PID" 2>/dev/null || true
    wait "$NATIVE_WORKER_PID" 2>/dev/null || true
  fi
  # Never retain raw native databases or the internal fixture checkpoint as artifacts.
  rm -rf "$NATIVE_INTAKE_PRIVATE"
  rm -f "$NATIVE_INTAKE_STATE"
}
trap 'NATIVE_INTAKE_STATUS=$?; cleanup_intake; exit "$NATIVE_INTAKE_STATUS"' EXIT

intake_flow() {
  local phase="$1"
  shift
  maestro "${NATIVE_DEVICE_ARGS[@]}" test "$@" --format junit \
    --output "$EVIDENCE/$NATIVE_PLATFORM-intake-$phase.xml" \
    --debug-output "$EVIDENCE/$NATIVE_PLATFORM-intake-$phase" \
    --test-output-dir "$EVIDENCE/$NATIVE_PLATFORM-intake-$phase" \
    "$NATIVE_DIR/acceptance/accounting-intake-$phase.yaml"
}

# iOS Photos is seeded before sign-in so fixture setup cannot background and
# lock an authenticated workspace. Android generates its image for Maestro here.
if [[ "$NATIVE_PLATFORM" == android ]]; then
  node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" image "$NATIVE_DIR/acceptance/assets/native-supplier-invoice.png" > "$EVIDENCE/android-intake-source.txt"
fi
node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" baseline > "$EVIDENCE/$NATIVE_PLATFORM-intake-checks.txt"
intake_flow capture
node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" local >> "$EVIDENCE/$NATIVE_PLATFORM-intake-checks.txt"

# Verify the actual restarted app's encrypted store while the image is still local.
if [ "$NATIVE_PLATFORM" = android ]; then
  mkdir -p "$NATIVE_INTAKE_PRIVATE"
  adb exec-out run-as eu.onesa.smartfarmer tar -cf - files > "$NATIVE_INTAKE_PRIVATE/cache.tar"
  tar -xf "$NATIVE_INTAKE_PRIVATE/cache.tar" -C "$NATIVE_INTAKE_PRIVATE"
  python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$NATIVE_INTAKE_PRIVATE" > "$EVIDENCE/$NATIVE_PLATFORM-intake-encryption.txt"
else
  NATIVE_CONTAINER=$(xcrun simctl get_app_container "${2:?Pass the iOS simulator}" eu.onesa.smartfarmer data)
  python3 "$NATIVE_DIR/acceptance/assert-encrypted.py" "$NATIVE_CONTAINER" > "$EVIDENCE/$NATIVE_PLATFORM-intake-encryption.txt"
fi

# Ordinary worker, ordinary queue. Start only for this separate journey, after the
# existing product verifier, so its maintenance does not alter earlier assertions.
(cd smart-farmer-backend && exec node dist/worker.js) > "$EVIDENCE/$NATIVE_PLATFORM-intake-worker.log" 2>&1 &
NATIVE_WORKER_PID=$!
intake_flow upload
node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" ready >> "$EVIDENCE/$NATIVE_PLATFORM-intake-checks.txt"
NATIVE_DOCUMENT=$(node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" document-id)
intake_flow review -e DOCUMENT_ID="$NATIVE_DOCUMENT"
node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" draft >> "$EVIDENCE/$NATIVE_PLATFORM-intake-checks.txt"
intake_flow post
node "$NATIVE_DIR/acceptance/accounting-intake-fixture.mjs" posted >> "$EVIDENCE/$NATIVE_PLATFORM-intake-checks.txt"
