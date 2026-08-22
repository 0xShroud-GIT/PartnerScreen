import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPairingQrPayload,
  PairingQrError,
  parsePairingQr,
} from '../src/domain/pairing/PairingQr';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-08-17T22:00:00.000Z');

function qr(overrides: Partial<Parameters<typeof buildPairingQrPayload>[0]> = {}) {
  return buildPairingQrPayload({
    pairAttemptId: ATTEMPT,
    creatorDeviceId: A,
    creatorDeviceName: 'Creator Phone',
    host: '192.168.1.15',
    port: 45678,
    bootstrapKeyHex: 'ab'.repeat(32),
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 120_000).toISOString(),
    ...overrides,
  });
}

test('valid Chirp QR parses with one-time bootstrap material', () => {
  const parsed = parsePairingQr(qr(), { nowMs: NOW + 1_000, localDeviceId: B, alreadyPaired: false });
  assert.equal(parsed.creatorDeviceId, A);
  assert.equal(parsed.host, '192.168.1.15');
  assert.equal(parsed.bootstrapKeyHex.length, 64);
});

test('expired QR is rejected', () => {
  assert.throws(
    () => parsePairingQr(qr({ expiresAt: new Date(NOW + 1_000).toISOString() }), { nowMs: NOW + 2_000, localDeviceId: B, alreadyPaired: false }),
    /expired/i,
  );
});

test('malformed QR is rejected', () => {
  assert.throws(() => parsePairingQr('PS1:not-json', { nowMs: NOW, localDeviceId: B, alreadyPaired: false }), PairingQrError);
});

test('self-pair is rejected', () => {
  assert.throws(() => parsePairingQr(qr(), { nowMs: NOW, localDeviceId: A, alreadyPaired: false }), /itself/i);
});

test('already paired phone rejects a second QR', () => {
  assert.throws(() => parsePairingQr(qr(), { nowMs: NOW, localDeviceId: B, alreadyPaired: true }), /already paired/i);
});

test('public or non-LAN endpoint is rejected', () => {
  assert.throws(() => qr({ host: '8.8.8.8' }), /private LAN/i);
});

test('overlong QR validity window is rejected when scanned', () => {
  const raw = qr({ expiresAt: new Date(NOW + 600_000).toISOString() });
  assert.throws(() => parsePairingQr(raw, { nowMs: NOW, localDeviceId: B, alreadyPaired: false }), /validity window/i);
});
