const { withAndroidManifest, withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withPrivateStorage(config) {
  config = withAndroidManifest(config, result => {
    const application = result.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:allowBackup'] = 'false';
      application.$['android:usesCleartextTraffic'] = 'false';
    }
    return result;
  });
  return withAppBuildGradle(config, result => {
    result.modResults.contents = result.modResults.contents
      .replace("storeFile file('debug.keystore')", "storeFile file(System.getProperty('user.home') + '/.android/debug.keystore')")
      .replace(/(release \{[\s\S]*?)\s+signingConfig signingConfigs\.debug/, '$1');
    return result;
  });
};
