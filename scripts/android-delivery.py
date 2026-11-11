#!/usr/bin/env python3
"""Sign an Android release APK and independently verify its install identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def fingerprint(value):
    value = value.replace(":", "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Expected a SHA-256 certificate fingerprint")
    return value

def verify(apk, tools, package, expected):
    signature = run([tools / "apksigner", "verify", "--verbose", "--print-certs", apk])
    signers = re.findall(r"^Signer #\d+ certificate SHA-256 digest: (\S+)$", signature, re.M)
    if [fingerprint(item) for item in signers] != [expected]:
        raise ValueError("APK signer does not match the expected certificate")
    if not re.search(r"Verified using v[23](?:\.\d+)? scheme .*: true", signature):
        raise ValueError("APK must have an Android v2 or newer binary signature")
    if re.search(r"certificate DN: .*CN=Android Debug(?:,|$)", signature, re.I | re.M):
        raise ValueError("Android debug certificates cannot be distributed")
    badging = run([tools / "aapt", "dump", "badging", apk])
    identity = re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging, re.M)
    if not identity or identity[1] != package or re.search(r"^application-debuggable", badging, re.M):
        raise ValueError("Wrong application ID or debuggable APK")
    with zipfile.ZipFile(apk) as contents:
        if "assets/index.android.bundle" not in contents.namelist():
            raise ValueError("Missing embedded React Native bundle")
    run([tools / "zipalign", "-c", "-P", "16", "4", apk])
    with open(apk, "rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"package": package, "versionCode": int(identity[2]), "versionName": identity[3],
            "certificateSha256": expected, "apkSha256": digest}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["sign", "verify"])
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--tools", type=Path, required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--certificate", required=True, type=fingerprint)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.action == "sign":
        if not args.output or args.output.resolve() == args.apk.resolve():
            parser.error("sign requires a distinct output path")
        for key in ("ANDROID_RELEASE_KEYSTORE", "ANDROID_RELEASE_ALIAS", "ANDROID_RELEASE_STORE_PASSWORD", "ANDROID_RELEASE_KEY_PASSWORD"):
            if not os.environ.get(key):
                parser.error("Missing " + key)
        with tempfile.TemporaryDirectory(dir=args.output.parent) as scratch:
            aligned = Path(scratch) / "aligned.apk"
            signed = Path(scratch) / "signed.apk"
            run([args.tools / "zipalign", "-P", "16", "-f", "4", args.apk, aligned])
            run([args.tools / "apksigner", "sign", "--ks", os.environ["ANDROID_RELEASE_KEYSTORE"],
                 "--ks-key-alias", os.environ["ANDROID_RELEASE_ALIAS"], "--ks-pass", "env:ANDROID_RELEASE_STORE_PASSWORD",
                 "--key-pass", "env:ANDROID_RELEASE_KEY_PASSWORD", "--out", signed, aligned])
            receipt = verify(signed, args.tools, args.package, args.certificate)
            signed.replace(args.output)
    else:
        receipt = verify(args.apk, args.tools, args.package, args.certificate)
    print(json.dumps(receipt, indent=2))

if __name__ == "__main__":
    main()
