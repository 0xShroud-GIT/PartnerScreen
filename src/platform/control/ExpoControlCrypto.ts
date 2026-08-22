import {
  AESEncryptionKey,
  AESKeySize,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  getRandomBytesAsync,
  randomUUID,
} from 'expo-crypto';
import { SignalingCryptoError, type AesGcmPrimitive } from '../../security/SignalingCipher';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_RE = /^[0-9a-f]{64}$/i;
const WIRE_RE = /^c1:([0-9a-f]+)$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SELF_TEST_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SELF_TEST_IV = '101112131415161718191a1b';
const SELF_TEST_AAD = 'Chirp|AES-GCM|v1';
const SELF_TEST_TEXT = 'Chirp runtime crypto self-test';
const SELF_TEST_COMBINED = '101112131415161718191a1b3e96f16439e948c6a40161706a590a21ae203a613bb132dd81d496022d2024a2340e85433924c7dbf7f7cfeaeb99';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new SignalingCryptoError('invalid_input', 'Control crypto wire is invalid.');
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new SignalingCryptoError('runtime', 'Control crypto returned unsupported binary output.');
}

async function importKey(keyHex: string): Promise<AESEncryptionKey> {
  if (!KEY_RE.test(keyHex)) throw new SignalingCryptoError('invalid_input', 'Control session key is invalid.');
  const key = await AESEncryptionKey.import(keyHex.toLowerCase(), 'hex');
  if (key.size !== AESKeySize.AES256) throw new SignalingCryptoError('runtime', 'Control session key must be AES-256.');
  return key;
}

export class ExpoControlCrypto implements AesGcmPrimitive {
  private selfTest: Promise<void> | null = null;

  randomId(): string { return randomUUID(); }

  async randomNonceHex(bytes = 16): Promise<string> {
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 32) throw new SignalingCryptoError('invalid_input', 'Control nonce size is invalid.');
    try { return bytesToHex(asBytes(await getRandomBytesAsync(bytes))); }
    catch { throw new SignalingCryptoError('runtime', 'Secure control randomness is unavailable.'); }
  }

  assertRuntimeCompatible(): Promise<void> {
    if (!this.selfTest) this.selfTest = this.runSelfTest();
    return this.selfTest;
  }

  async seal(keyHex: string, additionalData: string, plaintext: string): Promise<string> {
    await this.assertRuntimeCompatible();
    try {
      const key = await importKey(keyHex);
      const sealed = await aesEncryptAsync(encoder.encode(plaintext), key, {
        additionalData: encoder.encode(additionalData),
        nonce: { length: IV_BYTES },
        tagLength: TAG_BYTES,
      });
      return `c1:${bytesToHex(asBytes(await sealed.combined()))}`;
    } catch (error) {
      if (error instanceof SignalingCryptoError) throw error;
      throw new SignalingCryptoError('seal', 'Authenticated control encryption failed.');
    }
  }

  async open(keyHex: string, additionalData: string, sealedWire: string): Promise<string> {
    await this.assertRuntimeCompatible();
    const match = WIRE_RE.exec(sealedWire);
    if (!match || match[1]!.length < (IV_BYTES + TAG_BYTES) * 2) throw new SignalingCryptoError('invalid_input', 'Control crypto wire is malformed.');
    try {
      const key = await importKey(keyHex);
      const combined = hexToBytes(match[1]!);
      const sealed = AESSealedData.fromCombined(combined, { ivLength: IV_BYTES, tagLength: TAG_BYTES });
      const opened = await aesDecryptAsync(sealed, key, { additionalData: encoder.encode(additionalData), output: 'bytes' });
      return decoder.decode(asBytes(opened));
    } catch (error) {
      if (error instanceof SignalingCryptoError && error.code === 'invalid_input') throw error;
      throw new SignalingCryptoError('authentication', 'Authenticated control message was rejected.');
    }
  }

  private async runSelfTest(): Promise<void> {
    try {
      const key = await importKey(SELF_TEST_KEY);
      const expected = hexToBytes(SELF_TEST_COMBINED);
      const opened = await aesDecryptAsync(
        AESSealedData.fromCombined(expected, { ivLength: IV_BYTES, tagLength: TAG_BYTES }),
        key,
        { additionalData: encoder.encode(SELF_TEST_AAD), output: 'bytes' },
      );
      if (decoder.decode(asBytes(opened)) !== SELF_TEST_TEXT) throw new Error('decrypt mismatch');
      const resealed = await aesEncryptAsync(encoder.encode(SELF_TEST_TEXT), key, {
        additionalData: encoder.encode(SELF_TEST_AAD),
        nonce: { bytes: hexToBytes(SELF_TEST_IV) },
        tagLength: TAG_BYTES,
      });
      if (bytesToHex(asBytes(await resealed.combined())) !== SELF_TEST_COMBINED) throw new Error('encrypt mismatch');
    } catch {
      this.selfTest = null;
      throw new SignalingCryptoError('runtime', 'Secure control crypto is unavailable on this Android runtime.');
    }
  }
}
