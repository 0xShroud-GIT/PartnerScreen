import { AndroidConfig, ConfigPlugin, withAndroidManifest } from 'expo/config-plugins';

const withTrustedPresence: ConfigPlugin = (config) => {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults;
    if (!manifest.manifest['uses-permission']) manifest.manifest['uses-permission'] = [];
    const permissions = manifest.manifest['uses-permission'] as Array<{ $: { 'android:name': string } }>;
    const names = new Set(permissions.map((item) => item.$?.['android:name']));
    if (!names.has('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE')) {
      permissions.push({ $: { 'android:name': 'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE' } });
    }
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    if (!app.service) app.service = [];
    const exists = app.service.some((service) => service.$?.['android:name'] === 'com.partnerscreen.control.PartnerTrustedPresenceService');
    if (!exists) {
      app.service.push({
        $: {
          'android:name': 'com.partnerscreen.control.PartnerTrustedPresenceService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'connectedDevice',
          'android:stopWithTask': 'false',
        },
      });
    }
    return mod;
  });
};

export default withTrustedPresence;
