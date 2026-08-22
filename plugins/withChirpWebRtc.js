const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withMainActivity } = require('@expo/config-plugins');

const FORBIDDEN_DEBUG_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
];
const DEBUG_MANIFEST_VARIANTS = ['debug', 'debugOptimized'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripForbiddenDebugPermissions(source) {
  let next = source;
  for (const permission of FORBIDDEN_DEBUG_PERMISSIONS) {
    const pattern = new RegExp(
      `\\s*<uses-permission\\b(?=[^>]*android:name=["']${escapeRegExp(permission)}["'])[^>]*/>`,
      'g',
    );
    next = next.replace(pattern, '');
  }
  return next.replace(/\n{3,}/g, '\n\n');
}

module.exports = function withChirpWebRtc(config) {
  config = withMainActivity(config, (config) => {
    const mod = config.modResults;
    if (mod.language !== 'kt') {
      throw new Error('Chirp expects a Kotlin MainActivity.');
    }

    let source = mod.contents;
    if (!source.includes('com.oney.WebRTCModule.WebRTCModuleOptions')) {
      source = source.replace(
        /^(package\s+[^\n]+)$/m,
        '$1\n\nimport com.oney.WebRTCModule.WebRTCModuleOptions',
      );
    }

    if (!source.includes('enableMediaProjectionService = true')) {
      source = source.replace(
        /(override fun onCreate\(savedInstanceState: Bundle\?\) \{\s*)/,
        '$1\n    WebRTCModuleOptions.getInstance().enableMediaProjectionService = true\n',
      );
    }

    if (!source.includes('enableMediaProjectionService = true')) {
      throw new Error('Unable to enable react-native-webrtc MediaProjection service.');
    }

    mod.contents = source;
    return config;
  });

  return withDangerousMod(config, ['android', async (config) => {
    for (const variant of DEBUG_MANIFEST_VARIANTS) {
      const manifestPath = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        variant,
        'AndroidManifest.xml',
      );
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`Expected Expo Android ${variant} manifest was not generated.`);
      }

      const source = fs.readFileSync(manifestPath, 'utf8');
      const next = stripForbiddenDebugPermissions(source);
      for (const permission of FORBIDDEN_DEBUG_PERMISSIONS) {
        if (next.includes(permission)) {
          throw new Error(
            `Forbidden debug permission remains after prebuild in ${variant}: ${permission}`,
          );
        }
      }
      fs.writeFileSync(manifestPath, next.endsWith('\n') ? next : `${next}\n`);
    }
    return config;
  }]);
};
