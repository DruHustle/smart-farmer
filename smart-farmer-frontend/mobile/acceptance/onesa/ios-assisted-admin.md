# Witnessed Smart Farmer administrator sign-in on iPhone Simulator

Use a local Mac with Xcode, an installed iOS simulator runtime and an existing available iPhone simulator model, CocoaPods, Node 24.3 or newer on the Node 24 line, JDK 17, Maestro CLI 2.12.0, PostgreSQL 17 and OpenSSL. Use a fresh disposable checkout of the Farmer revision under review. The app and system browser open on the Mac so an observer can operate the real secure form. The hosted PR workflow runs unattended.

Run the following in Bash from the Farmer checkout. The npm, Xcode, pinned Portal checkout, fixture and Metro steps match the native acceptance workflow. Use free localhost ports 46501 through 46506 and 8081. The private Postgres cluster uses 55432. The name shown in Simulator identifies the disposable iPhone the helper will remove.

```bash
set -euo pipefail
umask 077
export RUNNER_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/farmer-witness.XXXXXX")"
export EXPO_PUBLIC_API_URL=http://127.0.0.1:46504
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
export DATABASE_URL=postgresql://native_ci@127.0.0.1:55432/smart_farmer_test
export MAESTRO_DRIVER_STARTUP_TIMEOUT=240000
initdb -D "$RUNNER_TEMP/native-pg" -U native_ci -A trust > "$RUNNER_TEMP/init.log"
pg_ctl -D "$RUNNER_TEMP/native-pg" -l "$RUNNER_TEMP/native-pg.log" -o "-p 55432 -h 127.0.0.1 -k $RUNNER_TEMP" start
createdb -p 55432 -h 127.0.0.1 -U native_ci smart_farmer_test
git clone https://github.com/DruHustle/onesa-company-portal.git qualification-portal
git -C qualification-portal checkout --detach 5732299004dccef89df144e0ff8362d2342b3a94
for directory in smart-farmer-frontend/mobile smart-farmer-frontend/web smart-farmer-backend qualification-portal/onesa-company-portal-backend qualification-portal/onesa-company-portal-frontend
do
  npm ci --prefix "$directory"
done
(
  cd smart-farmer-frontend/mobile
  npx --no-install expo prebuild --no-install --platform ios
  cd ios
  pod install > "$RUNNER_TEMP/pod-install.log" 2>&1
  xcodebuild -workspace SmartFarmer.xcworkspace -scheme SmartFarmer -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$RUNNER_TEMP/native-ios" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES build > "$RUNNER_TEMP/build.log" 2>&1
)
bash smart-farmer-frontend/mobile/acceptance/onesa/start.sh ios > "$RUNNER_TEMP/start.log" 2>&1
bash smart-farmer-frontend/mobile/acceptance/onesa/ios-assisted-admin.sh
```

Open the fixture file displayed by the helper in a private local editor. At the cold prompt, use its administrator test email and password in the native system authentication sheet, select the remember option and continue. Supply the fixture recovery factor on the second screen and tap Continue. Tap the Shona or Ndebele return link and wait for Farmer's invitation screen. Press Return in the observing terminal. Maestro uses the real adviser invitation, verifies the farm and displays the seeded forum discussion. The helper checks the issuer, administrator subject, adviser role and farm in the isolated SQL database.

At the warm prompt, use Farmer's sign-in control after local reauthentication. Confirm the remembered account if prompted, then tap the return link. Press Return in the terminal once the forum is restored. The helper verifies the selected Forum tab, the same farm, seeded discussion and the same mapped user. Each PKCE request uses the normal five-minute lifetime.

The cold HTTP record must show authorization 303, login 401 for MFA, login 200, callback page 200 and session 200. Warm requires authorization 303, an optional issuer continue 200, callback page 200 and session 200. Extra recorded requests or out-of-order responses fail the check. The operator's Return keystroke alone cannot pass either phase.

Only share the generated `ios-admin-assisted.txt`. It includes source revisions, simulator/runtime, observation time, ordered allowlisted response summaries and per-phase status. An absent phase has no result. Normal PR CI continues to exercise its own automatic flow. Keep raw Maestro, Metro, fixture and generated signing material private. When done, stop the fixture and Metro processes started by this checkout and stop the private cluster with `pg_ctl -D "$RUNNER_TEMP/native-pg" stop`. Retain the reviewed summary, then dispose of this checkout and its temporary directory. A new attempt needs a fresh fixture because the adviser invitation and recovery factor are single-use.
