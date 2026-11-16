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

Before signing for either store, set `EXPO_PUBLIC_PRIVACY_POLICY_URL` and `EXPO_PUBLIC_COMMUNITY_RULES_URL` to the public HTTPS pages approved for Smart Farmer. The upload-bundle and iPhoneOS archive commands require both values. Verify the content of each page and open both links in the installed release. Store Console metadata and the in-app link must point to the approved privacy policy. The Android CI job uses `--qualification` with a disposable key for its private build check.

## Privacy disclosures and reviewer access

Use the following inventory when completing App Privacy and Play Data safety for the deployed service. Both stores require the publisher to account for its own processing and its included SDKs. Select the categories, purposes and sharing answers after checking the production configuration, processors and retention policy.

| Data used in the app | What the reviewed client and service do |
| --- | --- |
| Account identifiers | The system browser opens Onesa Portal for authentication. Farmer associates the approved Portal subject and issuer with a Farmer user ID and farm memberships. Local accounts use a Farmer username. The OS protects stored credentials. |
| User content and business records | Farm members can upload images, foreground voice notes, PDFs, supplier invoices and expenses. The server can extract invoice text for user review. Customer or supplier contact details and transaction amounts can appear in financial documents. |
| Marketplace, hire and forum activity | Publishing a listing or forum post exposes the chosen content to other users. Enquiries, orders, bookings, payment acknowledgements, block lists and reports have different audiences. A payment acknowledgement records what the parties report. |
| Location and cameras | Farm locations, animal tracker observations, camera media and event timestamps can identify a property. The Android app blocks coarse and fine handset-location permissions. Camera and microphone access support the farmer's chosen capture actions. |
| Device features and notifications | Local biometric authentication returns an operating-system authentication result. SQLCipher and SecureStore protect the local workspace. The standard archive omits `EXPO_PUBLIC_EXPO_PROJECT_ID`. Before enabling remote push, add linked Device ID for app functionality to the iOS manifest and review the provider's handling of the delivery token in both stores. |
| Operational data | Confirm the hosting, access logs, object storage, backups, notification providers, monitoring and their retention periods against the live service. Review the Xcode archive's aggregated privacy report and the final Android manifest alongside these answers. |

The iOS manifest in `app.json` describes data retained by the Farmer service. Account and farm membership link each category to the user. Names, email addresses, phone numbers and postal addresses appear in identity, notification or billing records. Payment Info covers the payment method a farmer records. Other Financial Info and Purchase History cover amounts, balances, orders and bookings. Precise farm or tracker coordinates and approximate collection or operating areas support location features. Farmer uploads include photos, documents and voice notes. Private buyer–seller enquiries, community reports, posts and farm records supply messaging, customer support and other user content.

Saved marketplace queries, favourites and seller follows persist under the account and determine which listing alerts appear. Search History and Product Interaction therefore include product personalization alongside app functionality. The current manifest declares no tracking. The release owner should reconcile it with the production SDKs, providers, retention and actual uses before submitting App Store Connect answers. Expo writes the checked-in app resource during prebuild. CocoaPods adds required-reason API entries and the archive check verifies both declarations. [Apple manifest data categories](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests)

Keep review credentials outside git. Give the reviewers a dedicated approved ordinary Portal account in a demonstration farm with synthetic records and no live equipment. Supply a second demonstration account if the reviewer will exercise listings or hire. Verify that both accounts can sign in from a new device without an employee's phone. In review notes, describe the exact sign-in path, where to find the farm, how to complete a recording or booking, how the simulator acknowledges a command, and where to request Farmer account deletion. Document the shared Portal identity and local Farmer account option. Use images from the submitted version and device family. Capture sign-in before entering any personal details, and use synthetic data for any private workspace shown.

[Apple privacy disclosures](https://developer.apple.com/app-store/app-privacy-details/) · [Google Play Data safety](https://support.google.com/googleplay/android-developer/answer/10787469) · [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) · [Google Play review access](https://support.google.com/googleplay/android-developer/answer/15748846)
