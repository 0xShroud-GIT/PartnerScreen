import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAckPayload,
  parseCancelPayload,
  parseCommitPayload,
  parseConfirmPayload,
  parseHelloPayload,
  parseIdentityPayload,
  parsePairingEnvelope,
  parseSealedPairingFrame,
} from '../src/domain/pairing/PairingProtocol';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-08-18T00:00:00.000Z');

test('pairing envelope rejects unsupported top-level fields', () => {
  assert.throws(() => parsePairingEnvelope(JSON.stringify({
    protocolVersion: 1,
    messageId: MESSAGE,
    type: 'PAIR_HELLO',
    senderDeviceId: ID,
    timestamp: new Date(NOW).toISOString(),
    payload: { pairAttemptId: PAIR },
    surprise: true,
  }), NOW), /unsupported pairing message fields/i);
});

test('sealed frame requires canonical h1 hexadecimal wire data', () => {
  const base = {
    protocolVersion: 1,
    pairAttemptId: PAIR,
    senderDeviceId: ID,
    sequence: 1,
  };
  const canonical = JSON.stringify({ ...base, sealed: `h1:${'ab'.repeat(28)}` });
  assert.equal(parseSealedPairingFrame(canonical).sealed.startsWith('h1:'), true);
  assert.throws(() => parseSealedPairingFrame(JSON.stringify({ ...base, sealed: 'YWJjZA==' })), /sealed pairing data/i);
  assert.throws(() => parseSealedPairingFrame(JSON.stringify({ ...base, sealed: `h1:${'AB'.repeat(28)}` })), /sealed pairing data/i);
});

test('remote identity must use the exact M1 normalized-name contract', () => {
  assert.throws(() => parseIdentityPayload({ deviceId: ID, deviceName: 'Bad  Name' }), /device name/i);
  assert.equal(parseIdentityPayload({ deviceId: ID, deviceName: 'Good Name' }).deviceName, 'Good Name');
});

test('pairing payload parsers reject unknown fields', () => {
  assert.throws(() => parseHelloPayload({ pairAttemptId: PAIR, extra: true }), /unsupported/i);
  assert.throws(() => parseConfirmPayload({ deviceId: ID, extra: true }), /unsupported/i);
  assert.throws(() => parseAckPayload({ phase: 'scanner_staged', extra: true }), /unsupported/i);
  assert.throws(() => parseCancelPayload({ reason: 'user_cancelled', extra: true }), /unsupported/i);
});

test('pair commit parser rejects unknown fields and preserves canonical fields', () => {
  const payload = {
    pairId: PAIR,
    pairKeyHex: 'ab'.repeat(32),
    creatorDeviceId: ID,
    scannerDeviceId: OTHER,
    pairedAt: new Date(NOW).toISOString(),
  };
  assert.equal(parseCommitPayload(payload).pairId, PAIR);
  assert.throws(() => parseCommitPayload({ ...payload, extra: true }), /unsupported/i);
});
