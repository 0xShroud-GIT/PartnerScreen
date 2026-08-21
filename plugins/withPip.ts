import { AndroidConfig, ConfigPlugin, withAndroidManifest } from 'expo/config-plugins';

const withPip: ConfigPlugin = (config) => {
  return withAndroidManifest(config, (mod) => {
    const mainApp = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    const activities = mainApp['activity'] ?? [];
    let applied = false;
    for (const activity of activities) {
      const name = activity.$?.['android:name'] ?? '';
      if (name.includes('MainActivity')) {
        activity.$['android:supportsPictureInPicture'] = 'true';
        const existing = activity.$['android:configChanges'] ?? '';
        const required = ['screenSize', 'smallestScreenSize', 'screenLayout', 'orientation'];
        const parts = existing.split('|').map((s) => s.trim()).filter(Boolean);
        for (const r of required) if (!parts.includes(r)) parts.push(r);
        activity.$['android:configChanges'] = parts.join('|');
        applied = true;
      }
    }
    // Fallback: if no MainActivity found (CNG variations), apply to first launcher activity
    if (!applied && activities.length > 0) {
      for (const activity of activities) {
        const intentFilters = activity['intent-filter'] ?? [];
        const isLauncher = intentFilters.some((filter: any) => {
          const actions = filter.action ?? [];
          const categories = filter.category ?? [];
          return actions.some((a: any) => a.$?.['android:name'] === 'android.intent.action.MAIN') &&
            categories.some((c: any) => c.$?.['android:name'] === 'android.intent.category.LAUNCHER');
        });
        if (isLauncher) {
          activity.$['android:supportsPictureInPicture'] = 'true';
          const existing = activity.$['android:configChanges'] ?? '';
          const required = ['screenSize', 'smallestScreenSize', 'screenLayout', 'orientation'];
          const parts = existing.split('|').map((s) => s.trim()).filter(Boolean);
          for (const r of required) if (!parts.includes(r)) parts.push(r);
          activity.$['android:configChanges'] = parts.join('|');
          break;
        }
      }
    }
    return mod;
  });
};

export default withPip;
