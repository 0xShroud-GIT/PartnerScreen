import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  PAIRING_AES_IV_BYTES,
  PAIRING_AES_TAG_BYTES,
  decodePairingSealedWire,
  encodePairingSealedWire,
  lowerHexToBytes,
  bytesToLowerHex,
} from '../src/domain/pairing/PairingCryptoWire';

const VECTOR_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const VECTOR_IV_HEX = '101112131415161718191a1b';
const VECTOR_AAD = 'PartnerScreen|AES-GCM|v1';
const VECTOR_PLAINTEXT = 'PartnerScreen runtime crypto self-test';
const VECTOR_COMBINED_HEX = '101112131415161718191a1b2d9fea6227ac48e0a9076d7861591b26b92427637ee234c39e8996087e2731b736c4236686d21053acab1591771a482c53aba36c1712';

function nodeSeal(keyHex: string, aad: string, plaintext: string, iv = randomBytes(PAIRING_AES_IV_BYTES)): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return encodePairingSealedWire(new Uint8Array(Buffer.concat([iv, ciphertext, tag])));
}

function nodeOpen(keyHex: string, aad: string, wire: string): string {
  const combined = Buffer.from(decodePairingSealedWire(wire));
  const iv = combined.subarray(0, PAIRING_AES_IV_BYTES);
  const tag = combined.subarray(combined.length - PAIRING_AES_TAG_BYTES);
  const ciphertext = combined.subarray(PAIRING_AES_IV_BYTES, combined.length - PAIRING_AES_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

test('canonical sealed wire round-trips bytes exactly', () => {
  const bytes = new Uint8Array([0x10, 0x20, 0x30, ...new Array(25).fill(0x44)]);
  const wire = encodePairingSealedWire(bytes);
  assert.equal(wire.startsWith('h1:'), true);
  assert.deepEqual(Array.from(decodePairingSealedWire(wire)), Array.from(bytes));
  assert.throws(() => decodePairingSealedWire(wire.toUpperCase()));
  assert.throws(() => decodePairingSealedWire('h1:xyz'));
});

test('independent Node AES-256-GCM reproduces the production runtime self-test vector', () => {
  const wire = nodeSeal(VECTOR_KEY_HEX, VECTOR_AAD, VECTOR_PLAINTEXT, Buffer.from(VECTOR_IV_HEX, 'hex'));
  assert.equal(wire, `h1:${VECTOR_COMBINED_HEX}`);
  assert.equal(nodeOpen(VECTOR_KEY_HEX, VECTOR_AAD, wire), VECTOR_PLAINTEXT);
  assert.equal(bytesToLowerHex(lowerHexToBytes(VECTOR_COMBINED_HEX)), VECTOR_COMBINED_HEX);
});

test('two independent crypto instances interoperate and authenticate AAD', () => {
  const key = randomBytes(32).toString('hex');
  const aad = '1|33333333-3333-4333-8333-333333333333|22222222-2222-4222-8222-222222222222|1';
  const plaintext = JSON.stringify({ type: 'PAIR_HELLO', payload: { pairAttemptId: '33333333-3333-4333-8333-333333333333' } });
  const wire = nodeSeal(key, aad, plaintext);

  assert.equal(nodeOpen(key, aad, wire), plaintext);
  assert.throws(() => nodeOpen(key, `${aad}|tampered`, wire));

  const tampered = `${wire.slice(0, -1)}${wire.endsWith('0') ? '1' : '0'}`;
  assert.throws(() => nodeOpen(key, aad, tampered));
});
