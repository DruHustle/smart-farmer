#!/usr/bin/env bash
# Build, sign and verify a Google Play upload bundle. Nothing is uploaded.
set -euo pipefail
umask 077
mobile=$(cd "$(dirname "$0")/../smart-farmer-frontend/mobile" && pwd)
mode=${2:-store}
case "$mode" in store|--qualification) ;; *) echo 'Use --qualification only for disposable local/CI signing.' >&2; exit 2 ;; esac
output=${1:?Pass a new absolute .aab output path}
case "$output" in /*.aab) ;; *) echo 'Use an absolute .aab output path.' >&2; exit 2 ;; esac
test ! -e "$output" || { echo 'Choose an unused output path.' >&2; exit 2; }
: "${BUNDLETOOL_JAR:?Set the path to the official bundletool JAR}"
: "${ANDROID_RELEASE_KEYSTORE:?Set the path to the Play upload keystore}"
: "${ANDROID_RELEASE_ALIAS:?Set the Play upload key alias}"
: "${ANDROID_RELEASE_STORE_PASSWORD:?Set the keystore password in the environment}"
: "${ANDROID_RELEASE_KEY_PASSWORD:?Set the upload key password in the environment}"
: "${ANDROID_RELEASE_CERT_SHA256:?Set the upload certificate SHA-256 fingerprint from Play Console}"
export EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL:-https://farmer.onesa.eu}
cd "$mobile"
if [[ "$mode" == store ]]; then bash ../../scripts/check-store-policies.sh; fi
node --import tsx --input-type=commonjs -e "require('./src/api.ts').apiOrigin(process.env.EXPO_PUBLIC_API_URL, false)"
work=$(mktemp -d "$(dirname "$output")/.farmer-upload.XXXXXX")
trap 'rm -rf "$work"' EXIT
./android/gradlew -p android :app:bundleRelease --no-daemon --console=plain
unsigned=android/app/build/outputs/bundle/release/app-release.aab
test -s "$unsigned"
jarsigner -keystore "$ANDROID_RELEASE_KEYSTORE" -storepass:env ANDROID_RELEASE_STORE_PASSWORD \
  -keypass:env ANDROID_RELEASE_KEY_PASSWORD -signedjar "$work/upload.aab" "$unsigned" "$ANDROID_RELEASE_ALIAS"
jarsigner -verify "$work/upload.aab" > "$work/signature"
LC_ALL=C keytool -J-Duser.language=en -printcert -jarfile "$work/upload.aab" > "$work/certificate"
java -jar "$BUNDLETOOL_JAR" validate --bundle="$work/upload.aab"
java -jar "$BUNDLETOOL_JAR" dump manifest --bundle="$work/upload.aab" --module=base > "$work/manifest.xml"
java -jar "$BUNDLETOOL_JAR" dump config --bundle="$work/upload.aab" > "$work/config"
python3 - "$work" <<'PY'
import hashlib, json, os, re, struct, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree
work = Path(sys.argv[1])
expected = os.environ['ANDROID_RELEASE_CERT_SHA256'].replace(':', '').lower()
certificates = re.findall(r'^\s*SHA256:\s*([0-9A-F:]+)\s*$', (work/'certificate').read_text(), re.M)
if not re.fullmatch(r'[0-9a-f]{64}', expected) or not certificates or certificates[0].replace(':','').lower() != expected:
    sys.exit('The bundle upload certificate differs from the pinned Play upload certificate.')
manifest = ElementTree.parse(work/'manifest.xml').getroot()
key = '{http://schemas.android.com/apk/res/android}'
version = json.loads(Path('app.json').read_text())['expo']
sdk = manifest.find('uses-sdk'); app = manifest.find('application')
if manifest.get('package') != version['android']['package'] or manifest.get(key+'versionName') != version['version'] or manifest.get(key+'versionCode') != str(version['android']['versionCode']):
    sys.exit('Bundle identity or version differs from the app configuration.')
if sdk is None or int(sdk.get(key+'targetSdkVersion','0')) < 36 or app is None or app.get(key+'debuggable') == 'true':
    sys.exit('Incorrect Play target SDK or debuggable application.')
permissions = {node.get(key+'name') for node in manifest.findall('uses-permission')}
if not set(version['android']['permissions']).issubset(permissions) or set(version['android']['blockedPermissions']) & permissions:
    sys.exit('Packaged permissions differ from the mobile configuration.')
if app.get(key+'allowBackup') != 'false' or app.get(key+'usesCleartextTraffic') == 'true':
    sys.exit('Release must disable backup and cleartext traffic.')
if not any(node.get(key+'scheme') == version['scheme'] for node in app.findall('.//intent-filter/data')):
    sys.exit('The bundle is missing the Onesa return URL scheme.')
with zipfile.ZipFile(work/'upload.aab') as archive:
    if 'base/assets/index.android.bundle' not in archive.namelist():
        sys.exit('The standalone bundle is missing its JavaScript.')
    libraries = [name for name in archive.namelist() if re.match(r'.+/lib/(arm64-v8a|x86_64)/.+\.so$', name)]
    if not libraries or 'PAGE_ALIGNMENT_16K' not in (work/'config').read_text():
        sys.exit('Missing 64-bit native libraries or 16 KB page alignment in the bundle configuration.')
    for name in libraries:
        data = archive.read(name)
        if data[:6] != b'\x7fELF\x02\x01':
            sys.exit('Unexpected 64-bit ELF header: ' + name)
        offset = struct.unpack_from('<Q',data,32)[0]
        stride, count = struct.unpack_from('<HH',data,54)
        for i in range(count):
            header = offset + i * stride
            if struct.unpack_from('<I',data,header)[0] == 1 and struct.unpack_from('<Q',data,header+48)[0] < 16384:
                sys.exit('Native library lacks 16 KB LOAD alignment: ' + name)
print('Validated', manifest.get('package'), version['version'], 'build', version['android']['versionCode'], 'target API', sdk.get(key+'targetSdkVersion'))
with (work/'upload.aab').open('rb') as binary:
    print('Bundle SHA-256', hashlib.file_digest(binary,'sha256').hexdigest())
PY
# Install without overwriting any concurrently generated package.
ln "$work/upload.aab" "$output"
printf 'Verified upload bundle: %s\n' "$output"
