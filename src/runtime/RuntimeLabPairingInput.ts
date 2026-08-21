import PartnerRuntimeLabModule from '../../modules/partner-runtime-lab';
import { PAIRING_QR_MAX_CHARS, PAIRING_QR_PREFIX } from '../domain/pairing/PairingQr';
import { runtimeLabPairingCameraSubstituteEnabled } from './RuntimeLabFlags';

/**
 * Debug/emulator-only substitute for CameraView barcode delivery. It returns the
 * exact creator-generated QR payload and still routes it through PairingService,
 * parsePairingQr(), authenticated transport, and two-sided confirmation.
 */
export async function consumeRuntimeLabPairingQr(): Promise<string | null> {
  if (!runtimeLabPairingCameraSubstituteEnabled()) return null;
  try {
    const value = await PartnerRuntimeLabModule.consumePairingQr();
    if (typeof value !== 'string' || !value.startsWith(PAIRING_QR_PREFIX) || value.length > PAIRING_QR_MAX_CHARS) return null;
    return value;
  } catch {
    return null;
  }
}
