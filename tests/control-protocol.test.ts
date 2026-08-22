import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { decodeControlMessage, decodeHandshakeFrame, decodeSealedControlFrame, encodeControlMessage, encodeHandshakeFrame, encodeSealedControlFrame } from '../src/protocol/ControlCodec';
import { CONTROL_PROTOCOL_VERSION, type AnyControlMessage, type Hello1Frame } from '../src/protocol/ControlMessage';
import { AuthenticatedSignalingCipher } from '../src/security/AuthenticatedSignalingCipher';
import type { AesGcmPrimitive, HmacSha256Primitive } from '../src/security/SignalingCipher';
import { MessageValidator } from '../src/control/MessageValidator';

class NodeHmac implements HmacSha256Primitive {
  async macHex(keyHex: string, message: string): Promise<string> { return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex'); }
}
class NodeAes implements AesGcmPrimitive {
  async assertRuntimeCompatible(): Promise<void> {}
  randomId(): string { return randomUUID(); }
  async randomNonceHex(bytes = 16): Promise<string> { return randomBytes(bytes).toString('hex'); }
  async seal(keyHex: string, aad: string, plaintext: string): Promise<string> {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `c1:${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('hex')}`;
  }
  async open(keyHex: string, aad: string, wire: string): Promise<string> {
    const bytes = Buffer.from(wire.slice(3), 'hex'); const iv = bytes.subarray(0, 12); const tag = bytes.subarray(bytes.length - 16); const ciphertext = bytes.subarray(12, bytes.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, 'utf8')); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

const localId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const secret = 'ab'.repeat(32);
const now = '2026-08-19T00:00:00.000Z';

function requestMessage(sequence = 1): AnyControlMessage {
  return { version: 1, messageId: '44444444-4444-4444-8444-444444444444', type: 'REQUEST_SCREEN', sessionId, senderDeviceId: localId, sequence, timestamp: now, payload: { expiresAt: '2026-08-19T00:00:30.000Z' } };
}

test('strict control codec round-trips messages and rejects unknown fields/payloads', () => {
  const message = requestMessage();
  assert.deepEqual(decodeControlMessage(encodeControlMessage(message)), message);
  assert.throws(() => decodeControlMessage(JSON.stringify({ ...message, surprise: true })), /unsupported fields/i);
  assert.throws(() => decodeControlMessage(JSON.stringify({ ...message, payload: { expiresAt: 'bad' } })), /timestamp/i);
  assert.throws(() => decodeControlMessage('x'.repeat(50 * 1024)), /size/i);
});

test('handshake codec is strict and bounded', () => {
  const hello: Hello1Frame = { kind: 'hello1', version: CONTROL_PROTOCOL_VERSION, helloId: '55555555-5555-4555-8555-555555555555', sessionId, senderDeviceId: localId, nonce: '11'.repeat(16), timestamp: now, mac: '22'.repeat(32) };
  assert.deepEqual(decodeHandshakeFrame(encodeHandshakeFrame(hello)), hello);
  assert.throws(() => decodeHandshakeFrame(JSON.stringify({ ...hello, extra: 1 })), /unsupported fields/i);
});

test('session key and hello authentication match independent Node HMAC', async () => {
  const cipher = new AuthenticatedSignalingCipher(new NodeAes(), new NodeHmac());
  const context = { sessionId, initiatorDeviceId: localId, responderDeviceId: partnerId, initiatorNonce: '10'.repeat(16), responderNonce: '20'.repeat(16) };
  const actual = await cipher.deriveSessionKey(secret, context);
  const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(`Chirp|control-session-key|v1|${sessionId}|${localId}|${partnerId}|${context.initiatorNonce}|${context.responderNonce}`, 'ascii').digest('hex');
  assert.equal(actual, expected);
});

test('sealed control message authenticates outer header and inner message together', async () => {
  const cipher = new AuthenticatedSignalingCipher(new NodeAes(), new NodeHmac());
  const key = '33'.repeat(32); const message = requestMessage();
  const sealed = await cipher.sealMessage(key, message);
  const encoded = encodeSealedControlFrame(sealed);
  assert.deepEqual(await cipher.openMessage(key, decodeSealedControlFrame(encoded)), message);
  await assert.rejects(() => cipher.openMessage(key, { ...sealed, sequence: 2 }), /rejected|mismatch/i);
  await assert.rejects(() => cipher.openMessage('44'.repeat(32), sealed), /rejected/i);
});

test('message validator rejects replay, sequence gaps, wrong peer/session and stale timestamps before mutation', () => {
  const validator = new MessageValidator(localId, sessionId, () => Date.parse(now));
  assert.deepEqual(validator.validate(requestMessage()), { ok: true });
  assert.equal(validator.validate(requestMessage()).ok, false);
  const next = { ...requestMessage(2), messageId: '66666666-6666-4666-8666-666666666666' } as AnyControlMessage;
  validator.reset();
  assert.equal(validator.validate({ ...next, senderDeviceId: partnerId }).ok, false);
  assert.equal(validator.validate({ ...next, sessionId: '77777777-7777-4777-8777-777777777777' }).ok, false);
  assert.equal(validator.validate({ ...next, timestamp: '2026-08-18T23:00:00.000Z' }).ok, false);
});
