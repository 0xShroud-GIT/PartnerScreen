import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIRING_QR_MAX_CHARS,
  buildPairingQrPayload,
  isPrivateIpv4,
  parsePairingQr,
} from '../src/domain/pairing/PairingQr';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-08-18T00:00:00.000Z');

function validQr() {
  return buildPairingQrPayload({
    pairAttemptId: ATTEMPT,
    creatorDeviceId: ID_A,
    creatorDeviceName: 'Creator Phone',
    host: '192.168.1.20',
    port: 41000,
    bootstrapKeyHex: 'ab'.repeat(32),
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 120_000).toISOString(),
  });
}

test('private IPv4 QR endpoints must use canonical decimal notation', () => {
  assert.equal(isPrivateIpv4('192.168.1.20'), true);
  assert.equal(isPrivateIpv4('192.168.001.020'), false);
});

test('oversized QR input is rejected before JSON parsing', () => {
  assert.throws(
    () => parsePairingQr(`PS1:${'x'.repeat(PAIRING_QR_MAX_CHARS)}`, { nowMs: NOW, localDeviceId: ID_B, alreadyPaired: false }),
    /too large/i,
  );
});

test('normal bounded QR remains valid', () => {
  assert.equal(parsePairingQr(validQr(), { nowMs: NOW, localDeviceId: ID_B, alreadyPaired: false }).host, '192.168.1.20');
});
