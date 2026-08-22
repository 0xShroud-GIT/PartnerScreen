export const RUNTIME_LAB_ENABLED = process.env.EXPO_PUBLIC_PARTNERSCREEN_RUNTIME_LAB === '1';
export const RUNTIME_LAB_SYNTHETIC_CAPTURE =
  RUNTIME_LAB_ENABLED && process.env.EXPO_PUBLIC_PARTNERSCREEN_TEST_CAPTURE === 'synthetic';

/**
 * Runtime Lab flags are compile-time Expo public environment switches used only by
 * debuggable/manual test builds. Native entry points independently require the
 * Android application to be debuggable, so these flags are never sufficient to
 * activate a test hook in a release app.
 */
export function runtimeLabPairingCameraSubstituteEnabled(): boolean {
  return RUNTIME_LAB_ENABLED;
}
