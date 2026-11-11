# Native app downloads

The website displays two platform entries in `smart-farmer-frontend/web/src/components/app-store-listings.ts`. An unpublished entry has no URL. After verification, set its visible channel label and its HTTPS destination together. An Android APK entry uses **Download preview · 64-bit APK**. An Apple public beta uses **TestFlight beta**. Google Play and App Store listings may be used after the product listing is published.

## Android preview

The **Android preview APK** workflow compiles the release variant of `eu.onesa.smartfarmer` with its JavaScript inside the package. The APK supports ARM64 Android phones and 64-bit x86 Android devices. The build uses `EXPO_PUBLIC_API_URL=https://farmer.onesa.eu`. Service availability is separate from installing the app.

On changes to the packager or workflow, CI signs this real release build with a disposable test certificate, verifies the application ID, version, embedded bundle, release manifest, APK signature, signer fingerprint and ZIP alignment, and rejects a mismatched fingerprint. A stock 64-bit Android emulator installs and cold-launches that same release package without Metro. The package and disposable key are discarded.

For owner distribution, configure the `android-distribution` GitHub environment on this repository using the existing product signing identity. Use the owner's secure secret manager and GitHub Settings. Keep private materials out of Git and release assets.

| Setting | Value |
| --- | --- |
| Secret `ANDROID_RELEASE_KEYSTORE_BASE64` | Base64 of the product's distribution keystore |
| Secret `ANDROID_RELEASE_STORE_PASSWORD` | Keystore password |
| Secret `ANDROID_RELEASE_KEY_PASSWORD` | Signing key password |
| Variable `ANDROID_RELEASE_ALIAS` | The product's key alias |
| Variable `ANDROID_RELEASE_CERT_SHA256` | SHA-256 of the trusted distribution certificate, verified independently from the keystore |

Run **Android preview APK** from `main` with **publish** selected. The workflow verifies the signed package against the pinned certificate, creates a versioned GitHub prerelease with `SmartFarmerPreview-64bit.apk` and a public receipt, downloads the APK from its public link, and verifies that the bytes and signer match. A retry keeps the existing release intact. Increase the app's Android version code for later releases.

Copy the verified asset URL from the workflow summary to the website configuration and publish the web change through its ordinary release. Android may ask the user to allow installation from the current browser. The package manager requires the same signing identity for later updates. The receipt contains the package version, APK SHA-256 and certificate SHA-256.

## Apple distribution

Both iPhone and iPad use bundle ID `eu.onesa.smartfarmer` and scheme `SmartFarmer`. An Apple Developer Program team must own the App ID and App Store Connect record. On an enrolled Mac with the matching Apple Distribution identity and App Store provisioning profile, install the locked dependencies and pods, open the workspace, select the product team, and archive the Release scheme for a generic iOS device.

In Xcode Organizer, validate and upload the device archive to App Store Connect. For an external beta, complete TestFlight review as required, enable the public invitation and confirm the link offers this app to an eligible iPhone or iPad. Enter that verified TestFlight URL in the iOS website record. A published App Store product URL may replace it. The simulator compile is independent of device signing and distribution.

[Android signing verification](https://developer.android.com/tools/apksigner) · [Apple beta and release distribution](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)

## Google Play App Bundle

From the repository root, install the locked mobile dependencies. On a build machine with the SDK/NDK versions used in the Android preview workflow, set `BUNDLETOOL_JAR` to the official bundletool JAR. Set `ANDROID_RELEASE_KEYSTORE`, `ANDROID_RELEASE_ALIAS`, `ANDROID_RELEASE_STORE_PASSWORD`, `ANDROID_RELEASE_KEY_PASSWORD`, and `ANDROID_RELEASE_CERT_SHA256` in the protected signing environment. For this bundle, the expected certificate is the **upload certificate** registered in Play Console. The Android app-signing certificate can be different.

```sh
bash scripts/android-store-bundle.sh "$PWD/SmartFarmer-upload.aab"
```

The script compiles the release variant, signs with the upload key, and validates the AAB structure, signing certificate, app identity, version, target API, embedded JavaScript, 16 KB bundle alignment and 64-bit native library alignment. Set the Expo version code and native version code to an unused higher value when replacing a previous submission. Before public submission, install Play-generated splits through internal testing, or generate and install a device-specific APK set with bundletool. On the installed release, sign in through the Portal, complete and reopen a farm record, sign out, and relaunch. Capture store screenshots from the verified build.

The owner-approved production origin for both release scripts is `https://farmer.onesa.eu`. The deployment must route `/v1/onesa/config` to the API and `/auth/onesa/callback` to the web callback. Validate this against the deployed revision before packaging a submission. Store privacy declarations and reviewer access must cover the deployed services and third-party SDKs. Google Play requires the web deletion entry as well as the account control inside the app. Test both entry points with a synthetic account before completing the console declaration.

[Google Play target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878) · [16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) · [Google Play account deletion](https://support.google.com/googleplay/android-developer/answer/13327111) · [Apple submission requirements](https://developer.apple.com/news/upcoming-requirements/) · [Apple account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
