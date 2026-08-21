import {
  AESEncryptionKey,
  AESSealedData,
  AESKeySize,
  aesDecryptAsync,
  aesEncryptAsync,
  getRandomBytesAsync,
  randomUUID,
} from 'expo-crypto';
import {
  PairingCryptoError,
  type PairingCrypto,
} from '../../domain/pairing/PairingCrypto';
import {
  PAIRING_AES_IV_BYTES,
  PAIRING_AES_TAG_BYTES,
  bytesToLowerHex,
  decodePairingSealedWire,
  encodePairingSealedWire,
  lowerHexToBytes,
} from '../../domain/pairing/PairingCryptoWire';

export type { PairingCrypto } from '../../domain/pairing/PairingCrypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Fixed AES-256-GCM vector independently reproduced with Node/OpenSSL-compatible crypto.
// It contains no product/user secret and exists only to prove the native Expo AES bridge.
const SELF_TEST_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SELF_TEST_IV_HEX = '101112131415161718191a1b';
const SELF_TEST_AAD = 'PartnerScreen|AES-GCM|v1';
const SELF_TEST_PLAINTEXT = 'PartnerScreen runtime crypto self-test';
const SELF_TEST_COMBINED_HEX = '101112131415161718191a1b2d9fea6227ac48e0a9076d7861591b26b92427637ee234c39e8996087e2731b736c4236686d21053acab1591771a482c53aba36c1712';

function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new PairingCryptoError('wire', 'Pairing crypto returned an unsupported binary value.');
}

async function importAes256Key(keyHex: string): Promise<AESEncryptionKey> {
  const key = await AESEncryptionKey.import(keyHex, 'hex');
  if (key.size !== AESKeySize.AES256) throw new Error('Pairing key must be AES-256.');
  return key;
}

export class ExpoPairingCrypto implements PairingCrypto {
  private runtimeSelfTestPromise: Promise<void> | null = null;

  randomId(): string {
    return randomUUID();
  }

  async generateKeyHex(): Promise<string> {
    await this.assertRuntimeCompatible();
    try {
      return bytesToLowerHex(await getRandomBytesAsync(32));
    } catch {
      throw new PairingCryptoError('key_generation', 'Secure pairing key generation is unavailable.');
    }
  }

  assertRuntimeCompatible(): Promise<void> {
    if (!this.runtimeSelfTestPromise) this.runtimeSelfTestPromise = this.runRuntimeSelfTest();
    return this.runtimeSelfTestPromise;
  }

  async seal(keyHex: string, additionalData: string, plaintext: string): Promise<string> {
    await this.assertRuntimeCompatible();
    try {
      const key = await importAes256Key(keyHex);
      const sealed = await aesEncryptAsync(encoder.encode(plaintext), key, {
        additionalData: encoder.encode(additionalData),
        nonce: { length: PAIRING_AES_IV_BYTES },
        tagLength: PAIRING_AES_TAG_BYTES,
      });
      return encodePairingSealedWire(asUint8Array(await sealed.combined()));
    } catch (error) {
      if (error instanceof PairingCryptoError) throw error;
      throw new PairingCryptoError('seal', 'Secure pairing encryption failed.');
    }
  }

  async open(keyHex: string, additionalData: string, sealedWire: string): Promise<string> {
    await this.assertRuntimeCompatible();
    let combined: Uint8Array;
    try {
      combined = decodePairingSealedWire(sealedWire);
    } catch (error) {
      if (error instanceof PairingCryptoError) throw error;
      throw new PairingCryptoError('wire', 'Secure pairing data is malformed.');
    }

    try {
      const key = await importAes256Key(keyHex);
      const sealed = AESSealedData.fromCombined(combined, {
        ivLength: PAIRING_AES_IV_BYTES,
        tagLength: PAIRING_AES_TAG_BYTES,
      });
      const opened = await aesDecryptAsync(sealed, key, {
        additionalData: encoder.encode(additionalData),
        output: 'bytes',
      });
      return decoder.decode(asUint8Array(opened));
    } catch (error) {
      if (error instanceof PairingCryptoError) throw error;
      throw new PairingCryptoError('open', 'Secure pairing authentication failed.');
    }
  }

  private async runRuntimeSelfTest(): Promise<void> {
    try {
      const key = await importAes256Key(SELF_TEST_KEY_HEX);
      const expectedCombined = lowerHexToBytes(SELF_TEST_COMBINED_HEX);
      const expectedIv = lowerHexToBytes(SELF_TEST_IV_HEX);
      const sealed = AESSealedData.fromCombined(expectedCombined, {
        ivLength: PAIRING_AES_IV_BYTES,
        tagLength: PAIRING_AES_TAG_BYTES,
      });
      const opened = await aesDecryptAsync(sealed, key, {
        additionalData: encoder.encode(SELF_TEST_AAD),
        output: 'bytes',
      });
      if (decoder.decode(asUint8Array(opened)) !== SELF_TEST_PLAINTEXT) {
        throw new Error('AES-GCM decrypt self-test mismatch.');
      }

      const resealed = await aesEncryptAsync(encoder.encode(SELF_TEST_PLAINTEXT), key, {
        additionalData: encoder.encode(SELF_TEST_AAD),
        nonce: { bytes: expectedIv },
        tagLength: PAIRING_AES_TAG_BYTES,
      });
      const actualCombinedHex = bytesToLowerHex(asUint8Array(await resealed.combined()));
      if (actualCombinedHex !== SELF_TEST_COMBINED_HEX) {
        throw new Error('AES-GCM encrypt self-test mismatch.');
      }
    } catch {
      this.runtimeSelfTestPromise = null;
      throw new PairingCryptoError(
        'runtime_self_test',
        'Secure pairing crypto is unavailable on this Android runtime.',
      );
    }
  }
}
