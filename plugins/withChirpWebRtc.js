const { withMainActivity } = require('@expo/config-plugins');

module.exports = function withChirpWebRtc(config) {
  return withMainActivity(config, (config) => {
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
};
