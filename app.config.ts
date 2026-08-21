import type { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'PartnerScreen',
  slug: 'partnerscreen',
  scheme: 'partnerscreen',
  version: '0.0.1',
  platforms: ['android'],
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  android: {
    package: 'com.partnerscreen.app',
    versionCode: 1,
    allowBackup: false,
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.CHANGE_WIFI_MULTICAST_STATE',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
      'android.permission.POST_NOTIFICATIONS',
    ],
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.ACCESS_LOCAL_NETWORK',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.VIBRATE',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-camera',
      { recordAudioAndroid: false, barcodeScannerEnabled: true },
    ],
    './plugins/withPip',
    './plugins/withTrustedPresence',
  ],
  extra: {
    ...config.extra,
    buildCommit: process.env.PARTNERSCREEN_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? null,
  },
  experiments: { typedRoutes: true },
});
