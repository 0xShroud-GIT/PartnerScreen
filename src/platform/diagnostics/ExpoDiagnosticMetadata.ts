import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { DiagnosticBuildMetadata } from '../../application/DiagnosticsReport';

export function getDiagnosticBuildMetadata(): DiagnosticBuildMetadata {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  // Expo/Metro statically inlines direct EXPO_PUBLIC_* references into the production JS bundle.
  // This makes the exact release source commit independently verifiable from the packaged APK.
  const publicBuildCommit = process.env.EXPO_PUBLIC_PARTNERSCREEN_BUILD_COMMIT;
  const configBuildCommit = typeof extra?.buildCommit === 'string' && extra.buildCommit.length > 0
    ? extra.buildCommit
    : null;
  const buildCommit = typeof publicBuildCommit === 'string' && publicBuildCommit.length > 0
    ? publicBuildCommit
    : configBuildCommit;

  return {
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    buildCommit,
    platform: Platform.OS,
    platformVersion: String(Platform.Version),
  };
}
