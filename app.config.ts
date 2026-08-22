import type { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Chirp',
  slug: 'chirp',
  scheme: 'chirp',
  version: '0.1.0',
  platforms: ['android'],
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  android: {
    package: 'com.chirp.app',
    versionCode: 1,
    allowBackup: false,
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.CHANGE_NETWORK_STATE',
      'android.permission.CHANGE_WIFI_MULTICAST_STATE',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.CAMERA'
    ],
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.VIBRATE',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT'
    ]
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-camera', { recordAudioAndroid: false, barcodeScannerEnabled: true }],
    '@config-plugins/react-native-webrtc',
    ['expo-build-properties', { android: { buildArchs: ['arm64-v8a', 'x86_64'] } }],
    './plugins/withChirpWebRtc'
  ],
  extra: {
    ...config.extra,
    buildCommit: process.env.CHIRP_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? null
  },
  experiments: { typedRoutes: true }
});
