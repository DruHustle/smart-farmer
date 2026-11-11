#!/usr/bin/env bash
set -euo pipefail
# Run only on the disposable CI AVD. Android Enterprise registers the CA in
# the user trust store; Chrome still validates the chain, hostname and dates.
[[ -n "${CI:-}" && "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
source_dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sdk=${ANDROID_HOME:?Android SDK required}
tools="$(find "$sdk/build-tools" -maxdepth 1 -type d | sort -V | tail -1)"
jar="$sdk/platforms/android-36/android.jar"
cd "$work"
mkdir -p classes dex assets res/xml
openssl x509 -in "${1:?Public fixture CA required}" -outform DER -out assets/fixture-ca.der
cat > AndroidManifest.xml <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="eu.onesa.qualification">
  <uses-sdk android:minSdkVersion="35" android:targetSdkVersion="36"/>
  <application android:label="Disposable emulator trust" android:testOnly="true" android:debuggable="true">
    <receiver android:name=".Owner" android:exported="true" android:permission="android.permission.BIND_DEVICE_ADMIN">
      <meta-data android:name="android.app.device_admin" android:resource="@xml/admin"/>
      <intent-filter><action android:name="android.app.action.DEVICE_ADMIN_ENABLED"/></intent-filter>
    </receiver>
    <activity android:name=".Trust" android:exported="true"/>
  </application>
</manifest>
XML
echo '<device-admin xmlns:android="http://schemas.android.com/apk/res/android"><uses-policies/></device-admin>' > res/xml/admin.xml
"$tools/aapt2" compile --dir res -o resources.zip
"$tools/aapt2" link -o unsigned.apk -I "$jar" --manifest AndroidManifest.xml -A assets resources.zip
javac --release 11 -classpath "$jar" -d classes "$source_dir"/{Owner,Trust}.java
"$tools/d8" --lib "$jar" --min-api 35 --output dex classes/eu/onesa/qualification/*.class
(cd dex && zip -q ../unsigned.apk classes.dex)
"$tools/zipalign" -f 4 unsigned.apk aligned.apk
keytool -genkeypair -keystore ephemeral.p12 -storepass emulator-only -keypass emulator-only -alias fixture -dname 'CN=Disposable Emulator' -keyalg RSA -validity 1 >/dev/null 2>&1
"$tools/apksigner" sign --ks ephemeral.p12 --ks-pass pass:emulator-only --out fixture.apk aligned.apk
adb install -t fixture.apk
adb shell dpm set-device-owner eu.onesa.qualification/.Owner
adb shell am start -W -n eu.onesa.qualification/.Trust >/dev/null
for attempt in {1..20}; do
  if adb shell run-as eu.onesa.qualification test -s files/installed; then exit 0; fi
  sleep 1
done
echo 'Installed CA receipt missing on emulator' >&2
exit 1
