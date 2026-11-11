#!/usr/bin/env bash
# Only the temporary public CA enters this test-only APK. Settings owns any trust decision.
set -euo pipefail
umask 077
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
cert=${1:?Provide the temporary public CA in DER format}
[[ -f "$cert" ]]
if [[ $# -ne 1 && ( $# -ne 3 || $2 != --build-only ) ]]; then
  echo "Usage: install.sh CERT.der [--build-only OUTPUT.apk]" >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  [[ -n "${CI:-}" && $(adb shell getprop ro.kernel.qemu | tr -d '\r') == 1 ]]
fi
sdk=${ANDROID_HOME:?Android SDK required}
jar="$sdk/platforms/android-36/android.jar"
tools="$sdk/build-tools/36.0.0"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work"/{assets,classes,dex}
# Re-encode just the public X.509 certificate. Inputs containing other bytes are refused.
openssl x509 -inform DER -in "$cert" -outform DER -out "$work/assets/farmer-device-ca.crt"
cmp -s "$cert" "$work/assets/farmer-device-ca.crt"
openssl x509 -inform DER -in "$cert" -noout -ext basicConstraints | grep -Fq 'CA:TRUE'
"$tools/aapt2" link -o "$work/base.apk" -I "$jar" --manifest "$source_dir/AndroidManifest.xml" -A "$work/assets"
javac --release 11 -classpath "$jar" -d "$work/classes" "$source_dir"/*.java
bash "$tools/d8" --lib "$jar" --min-api 35 --output "$work/dex" "$work"/classes/eu/onesa/qualification/documents/*.class
(cd "$work/dex" && zip -q "$work/base.apk" classes.dex)
"$tools/zipalign" -f 4 "$work/base.apk" "$work/aligned.apk"
keytool -genkeypair -storetype PKCS12 -keystore "$work/test.p12" -storepass emulator-fixture -keypass emulator-fixture \
  -alias fixture -dname 'CN=Disposable AVD issuer document' -keyalg RSA -validity 1 >/dev/null 2>&1
"$tools/apksigner" sign --ks "$work/test.p12" --ks-pass pass:emulator-fixture --out "$work/provider.apk" "$work/aligned.apk"
"$tools/apksigner" verify "$work/provider.apk"
if [[ $# -eq 3 ]]; then
  cp -- "$work/provider.apk" "$3"
  exit 0
fi
package=eu.onesa.qualification.documents
if adb shell pm path "$package" | grep -q '^package:'; then adb uninstall "$package"; fi
adb install -t "$work/provider.apk"
result=$(adb shell am instrument -w "$package/.ProviderCheck")
printf '%s\n' "$result"
grep -Fq 'providerProof=one-read-only-issuer-certificate' <<< "$result"
