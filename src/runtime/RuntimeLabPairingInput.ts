import { PAIRING_QR_MAX_CHARS, PAIRING_QR_PREFIX } from '../domain/pairing/PairingQr';
import { runtimeLabPairingCameraSubstituteEnabled } from './RuntimeLabFlags';

type RuntimeLabNativeModule = {
  consumePairingQr(): Promise<string | null>;
};

declare const require: (modulePath: string) => { default: RuntimeLabNativeModule };

/**
 * Debug/emulator-only substitute for CameraView barcode delivery. It returns the
 * exact creator-generated QR payload and still routes it through PairingService,
 * parsePairingQr(), authenticated transport, and two-sided confirmation.
 *
 * The native bridge is required lazily only after the Runtime Lab flag is true so
 * ordinary production scanner imports do not depend on test plumbing.
 */
export async function consumeRuntimeLabPairingQr(): Promise<string | null> {
  if (!runtimeLabPairingCameraSubstituteEnabled()) return null;
  try {
    const module = require('../../modules/partner-runtime-lab').default;
    const value = await module.consumePairingQr();
    if (typeof value !== 'string' || !value.startsWith(PAIRING_QR_PREFIX) || value.length > PAIRING_QR_MAX_CHARS) return null;
    return value;
  } catch {
    return null;
  }
}
