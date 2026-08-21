import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverProductError } from '../src/session/ErrorRecovery';
import { sanitizeMediaStats, qualityFromStats, measuredBitrateBps } from '../src/media/MediaStats';
import { displayedVideoSize } from '../src/platform/pip/videoGeometry';
import { shouldOpenIncomingRequest } from '../src/request/incomingRequestRoute';
import { IncomingRequestNotifier } from '../src/request/IncomingRequestNotifier';
import type { SessionState } from '../src/session/SessionState';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import { deriveProductPresentation } from '../src/presentation/ProductPresentation';

const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '44444444-4444-4444-8444-444444444444', partnerDeviceId: '22222222-2222-4222-8222-222222222222', partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };
const sessionIdA = '33333333-3333-4333-8333-333333333333';
const sessionIdB = '88888888-8888-4888-8888-888888888888';

async function settle(): Promise<void> { for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }

test('coordinated error recovery tears down session, media, capture, notifications, pip and keep-awake without touching pairing', async () => {
  const calls: string[] = [];
  await recoverProductError({
    session: { async clearError() { calls.push('session'); } },
    media: { async resetToIdle() { calls.push('media'); } },
    capture: { async resetToIdle() { calls.push('capture'); } },
    notifications: { async clearRequestNotification() { calls.push('notification'); return true; } },
    pip: { async exitPip() { calls.push('pip'); return true; } },
    keepAwake: { async disable() { calls.push('keepawake'); return true; } },
  });
  assert.deepEqual(calls, ['pip', 'keepawake', 'notification', 'media', 'capture', 'session']);
});

test('media stats sanitizer rejects secret-bearing keys and does not invent bitrate', () => {
  assert.equal(sanitizeMediaStats({ bytesSent: 12, sdp: 'v=0' }), null);
  assert.equal(sanitizeMediaStats({ bytesSent: 12, candidate: 'host' }), null);
  assert.equal(sanitizeMediaStats({ bytesSent: 12, remoteIp: '192.168.1.1' }), null);
  const clean = sanitizeMediaStats({ bytesSent: 12, bitrateParametersApplied: false, candidatePairState: 'succeeded' });
  assert.equal(clean?.bytesSent, 12);
  assert.equal(clean?.bitrateParametersApplied, false);
  assert.equal(clean?.measuredBitrateBps, undefined);
  assert.equal(qualityFromStats({ roundTripTime: 0.45 }, 0), 'degraded');
  assert.equal(qualityFromStats({ roundTripTime: 0.05, packetsLost: 1 }, 1), 'good');
  assert.equal(measuredBitrateBps({ bytesSent: 1000, atMs: 0 }, 3000, 1000), 16_000);
});

test('PiP geometry uses actual remote dimensions and rotation', () => {
  assert.deepEqual(displayedVideoSize({ width: 1280, height: 720, rotation: 0 }), { width: 1280, height: 720 });
  assert.deepEqual(displayedVideoSize({ width: 1280, height: 720, rotation: 90 }), { width: 720, height: 1280 });
  assert.deepEqual(displayedVideoSize({ width: 1280, height: 720, rotation: 270 }), { width: 720, height: 1280 });
  assert.equal(displayedVideoSize({ width: 0, height: 720, rotation: 0 }), null);
});

test('incoming-request deep route only matches the exact live incoming session', () => {
  assert.equal(shouldOpenIncomingRequest({ type: 'IncomingRequest', pair, sessionId: sessionIdA, expiresAt: '2026-08-19T00:01:00.000Z' }, sessionIdA), true);
  assert.equal(shouldOpenIncomingRequest({ type: 'IncomingRequest', pair, sessionId: sessionIdA, expiresAt: '2026-08-19T00:01:00.000Z' }, sessionIdB), false);
  assert.equal(shouldOpenIncomingRequest({ type: 'PairedOffline', pair }, sessionIdA), false);
  assert.equal(shouldOpenIncomingRequest({ type: 'Connected', pair, sessionId: sessionIdA, role: 'sharer' }, sessionIdA), false);
});

test('stale notification show cannot overwrite a newer incoming request', async () => {
  const shown: string[] = [];
  let showA: (value: boolean) => void = () => undefined;
  const fakeNotifications = {
    async showRequestNotification(sessionId: string): Promise<boolean> {
      if (sessionId === sessionIdA) return new Promise<boolean>((resolve) => { showA = resolve; });
      shown.push(sessionId);
      return true;
    },
    async clearRequestNotification(): Promise<boolean> { return true; },
    async ensurePermission(): Promise<boolean> { return true; },
  };
  const fakeSessionState: { value: SessionState } = { value: { type: 'PairedOffline', pair } };
  const listeners = new Set<() => void>();
  const fakeSession = {
    getSnapshot: () => fakeSessionState.value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    setState: (next: SessionState) => { fakeSessionState.value = next; for (const listener of listeners) listener(); },
  };
  const diagnostics = { events: [] as DiagnosticEventKind[], async append(kind: DiagnosticEventKind) { this.events.push(kind); } };
  const notifier = new IncomingRequestNotifier(fakeSession, fakeNotifications, diagnostics);
  await settle();
  fakeSession.setState({ type: 'IncomingRequest', pair, sessionId: sessionIdA, expiresAt: '2026-08-19T00:01:00.000Z' });
  await settle();
  fakeSession.setState({ type: 'IncomingRequest', pair, sessionId: sessionIdB, expiresAt: '2026-08-19T00:01:00.000Z' });
  await settle();
  showA(true);
  await settle();
  assert.deepEqual(shown, [sessionIdB]);
  notifier.dispose();
});

test('keep-awake success is not claimed unless the port returns true', async () => {
  const kinds: DiagnosticEventKind[] = [];
  const enable = async (ok: boolean): Promise<void> => { if (ok) kinds.push('keep_awake_enabled'); };
  await enable(false);
  assert.equal(kinds.includes('keep_awake_enabled'), false);
  await enable(true);
  assert.equal(kinds.includes('keep_awake_enabled'), true);
});

test('live plus measured degraded health is presented as degraded, not false LIVE quality', () => {
  const liveDegraded = deriveProductPresentation({
    session: { type: 'Connected', pair, sessionId: sessionIdA, role: 'requester' },
    capture: { type: 'idle' },
    media: { type: 'live', sessionId: sessionIdA, quality: 'good', trackEpoch: 1 },
    mediaHealth: 'degraded',
    mediaStats: { measuredBitrateBps: 400_000, bitrateParametersApplied: false },
  });
  assert.equal(liveDegraded.phase, 'degraded');
  assert.match(liveDegraded.label, /remote frame still visible/i);
  const liveGood = deriveProductPresentation({
    session: { type: 'Connected', pair, sessionId: sessionIdA, role: 'requester' },
    capture: { type: 'idle' },
    media: { type: 'live', sessionId: sessionIdA, quality: 'good', trackEpoch: 1 },
    mediaHealth: 'good',
    mediaStats: { measuredBitrateBps: 400_000 },
  });
  assert.equal(liveGood.phase, 'live');
  assert.match(liveGood.detail, /measured 400 kbps/i);
});
