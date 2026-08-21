import { PairingCryptoError } from './PairingCrypto';

export const PAIRING_AES_IV_BYTES = 12;
export const PAIRING_AES_TAG_BYTES = 16;
export const PAIRING_SEALED_WIRE_PREFIX = 'h1:';
// Hex encoding doubles byte size. Keep ample room under the native 64 KiB framed-JSON cap.
const MAX_SEALED_BYTES = 24 * 1024;
const HEX_RE = /^[0-9a-f]+$/;

export function bytesToLowerHex(bytes: Uint8Array): string {
  let output = '';
  for (const value of bytes) output += value.toString(16).padStart(2, '0');
  return output;
}

export function lowerHexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new PairingCryptoError('wire', 'Pairing sealed data is not canonical hexadecimal.');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function encodePairingSealedWire(bytes: Uint8Array): string {
  if (bytes.length < PAIRING_AES_IV_BYTES + PAIRING_AES_TAG_BYTES || bytes.length > MAX_SEALED_BYTES) {
    throw new PairingCryptoError('wire', 'Pairing sealed data has an invalid size.');
  }
  return `${PAIRING_SEALED_WIRE_PREFIX}${bytesToLowerHex(bytes)}`;
}

export function decodePairingSealedWire(value: string): Uint8Array {
  if (!value.startsWith(PAIRING_SEALED_WIRE_PREFIX)) {
    throw new PairingCryptoError('wire', 'Pairing sealed data uses an unsupported wire format.');
  }
  const bytes = lowerHexToBytes(value.slice(PAIRING_SEALED_WIRE_PREFIX.length));
  if (bytes.length < PAIRING_AES_IV_BYTES + PAIRING_AES_TAG_BYTES || bytes.length > MAX_SEALED_BYTES) {
    throw new PairingCryptoError('wire', 'Pairing sealed data has an invalid size.');
  }
  return bytes;
}

export function isCanonicalPairingSealedWire(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(PAIRING_SEALED_WIRE_PREFIX)) return false;
  const hex = value.slice(PAIRING_SEALED_WIRE_PREFIX.length);
  if (hex.length < (PAIRING_AES_IV_BYTES + PAIRING_AES_TAG_BYTES) * 2 || hex.length > MAX_SEALED_BYTES * 2) return false;
  return hex.length % 2 === 0 && HEX_RE.test(hex);
}
