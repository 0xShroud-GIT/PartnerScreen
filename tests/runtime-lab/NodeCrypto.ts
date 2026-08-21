import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from 'node:crypto';
import type { PairingCrypto } from '../../src/domain/pairing/PairingCrypto';
import {
  PAIRING_AES_IV_BYTES,
  PAIRING_AES_TAG_BYTES,
  decodePairingSealedWire,
  encodePairingSealedWire,
} from '../../src/domain/pairing/PairingCryptoWire';
import type { AesGcmPrimitive, HmacSha256Primitive } from '../../src/security/SignalingCipher';

function uuidFromCounter(counter: number): string {
  const tail = counter.toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${tail}`;
}

/** Deterministic identifiers/nonces make randomized Runtime Lab failures replayable by seed. */
export class LabIdSource {
  private counter = 1;

  constructor(private readonly seed = 'partnerscreen-runtime-lab') {}

  uuid(): string {
    return uuidFromCounter(this.counter++);
  }

  bytes(length: number): Buffer {
    const chunks: Buffer[] = [];
    while (Buffer.concat(chunks).length < length) {
      chunks.push(createHash('sha256').update(`${this.seed}:${this.counter++}`, 'utf8').digest());
    }
    return Buffer.concat(chunks).subarray(0, length);
  }

  hex(bytes: number): string {
    return this.bytes(bytes).toString('hex');
  }
}

export class NodeHmac implements HmacSha256Primitive {
  async macHex(keyHex: string, message: string): Promise<string> {
    return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex');
  }
}

export class NodeAes implements AesGcmPrimitive {
  constructor(private readonly ids = new LabIdSource()) {}

  async assertRuntimeCompatible(): Promise<void> {}
  randomId(): string { return this.ids.uuid(); }
  async randomNonceHex(bytes = 16): Promise<string> { return this.ids.hex(bytes); }

  async seal(keyHex: string, aad: string, plaintext: string): Promise<string> {
    const iv = this.ids.bytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `c1:${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('hex')}`;
  }

  async open(keyHex: string, aad: string, wire: string): Promise<string> {
    if (!wire.startsWith('c1:')) throw new Error('Unsupported lab control wire.');
    const all = Buffer.from(wire.slice(3), 'hex');
    const iv = all.subarray(0, 12);
    const tag = all.subarray(all.length - 16);
    const body = all.subarray(12, all.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

export class NodePairingCrypto implements PairingCrypto {
  constructor(private readonly ids = new LabIdSource('partnerscreen-pairing-lab')) {}

  randomId(): string { return this.ids.uuid(); }
  async generateKeyHex(): Promise<string> { return this.ids.hex(32); }
  async assertRuntimeCompatible(): Promise<void> {}

  async seal(keyHex: string, additionalData: string, plaintext: string): Promise<string> {
    const iv = this.ids.bytes(PAIRING_AES_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    cipher.setAAD(Buffer.from(additionalData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return encodePairingSealedWire(new Uint8Array(Buffer.concat([iv, ciphertext, tag])));
  }

  async open(keyHex: string, additionalData: string, sealedWire: string): Promise<string> {
    const combined = Buffer.from(decodePairingSealedWire(sealedWire));
    const iv = combined.subarray(0, PAIRING_AES_IV_BYTES);
    const tag = combined.subarray(combined.length - PAIRING_AES_TAG_BYTES);
    const ciphertext = combined.subarray(PAIRING_AES_IV_BYTES, combined.length - PAIRING_AES_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    decipher.setAAD(Buffer.from(additionalData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
