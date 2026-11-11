# Apple device archive and TestFlight

The native app uses bundle ID `eu.onesa.smartfarmer` for iPhone and iPad. Run these commands on macOS from `smart-farmer-frontend/mobile` after installing locked dependencies and pods. The generic device check compiles against the iPhoneOS SDK and verifies the ARM64 executable, bundle identity and embedded JavaScript.

```bash
bash ../../scripts/ios-device-distribution.sh check "$PWD/SmartFarmer-unsigned.xcarchive"
```

For distribution, use an enrolled Apple team that owns the explicit App ID and App Store Connect record. Install the matching Apple signing identities and App Store provisioning profiles on the owner's Mac, or let Xcode configure that team's signing before archiving. The team ID is public. Signing private keys and profiles belong in the owner's protected signing environment.

```bash
export APPLE_TEAM_ID=YOUR_APPLE_TEAM_ID
bash ../../scripts/ios-device-distribution.sh archive "$PWD/SmartFarmer-signed.xcarchive"
bash ../../scripts/ios-device-distribution.sh export "$PWD/SmartFarmer-signed.xcarchive" "$PWD/apple-export"
```

The export checks the Apple Distribution signature, selected team, signed app identifier, device platform, ARM64 executable, embedded JavaScript and debugging entitlement. Upload the verified IPA through Transporter or Xcode, select the processed build for an external TestFlight group and complete Apple's review as required. Enable and test the public invitation before placing its URL behind the website's iOS icon with the label **TestFlight beta**.

[Apple's beta and release distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)
