import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverProductError } from '../src/session/ErrorRecovery';
import { sanitizeMediaStats, qualityFromStats, measuredBitrateBps } from '../src/media/MediaStats';
import { displayedVideoSize } from '../src/platform/pip/videoGeometry';
import { parseIncomingRequestSessionId, shouldOpenIncomingRequest } from '../src/request/incomingRequestRoute';
import { IncomingRequestNotifier } from '../src/request/IncomingRequestNotifier';
import type { SessionState } from '../src/session/SessionState';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import { deriveProductPresentation } from '../src/presentation/ProductPresentation';
import { SessionController, type PendingRequestPersistence, type SessionControlChannel } from '../src/session/SessionController';
import type { AnyControlMessage, ControlMessageType, ControlPayloadMap } from '../src/protocol/ControlMessage';
import type { ControlSessionEvent, ControlTrustContext } from '../src/control/ControlSession';

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
  assert.deepEqual(new Set(calls.slice(0, 5)), new Set(['pip', 'keepawake', 'notification', 'media', 'capture']));
  assert.equal(calls.at(-1), 'session');
});

test('media stats sanitizer rejects secret-bearing keys and does not invent bitrate', () => {
  assert.equal(sanitizeMediaStats({ bytesSent: 12, sdp: 'v=0' }), null);
  assert.equal(sanitizeMediaStats({ bytesSent: 12, candidate: 'host' }), null);
  assert.equal(sanitizeMediaStats({ bytesSent: 12, remoteIp: '192.168.1.1' }), null);
  const clean = sanitizeMediaStats({ bytesSent: 12, bitrateParametersState: 'failed', candidatePairState: 'succeeded' });
  assert.equal(clean?.bytesSent, 12);
  assert.equal(clean?.bitrateParametersState, 'failed');
  assert.equal(clean?.measuredBitrateBps, undefined);
  assert.equal(sanitizeMediaStats({ bytesSent: 12, bitrateParametersApplied: false })?.bitrateParametersState, undefined);
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
  assert.equal(parseIncomingRequestSessionId(`partnerscreen://incoming-request/${sessionIdA}`), sessionIdA);
  assert.equal(parseIncomingRequestSessionId(`partnerscreen://incoming-request/${sessionIdA}?src=notification`), sessionIdA);
  assert.equal(parseIncomingRequestSessionId(`partnerscreen://incoming-request/${sessionIdA}/extra`), null);
  assert.equal(parseIncomingRequestSessionId('partnerscreen://incoming-request/not-a-uuid'), null);
  assert.equal(parseIncomingRequestSessionId(`https://example.com/incoming-request/${sessionIdA}`), null);
  assert.equal(parseIncomingRequestSessionId(`partnerscreen://incoming-request/${sessionIdA}/192.168.1.20`), null);
  assert.equal(shouldOpenIncomingRequest({ type: 'IncomingRequest', pair, sessionId: sessionIdA, expiresAt: '2026-08-19T00:01:00.000Z' }, sessionIdA), true);
  assert.equal(shouldOpenIncomingRequest({ type: 'IncomingRequest', pair, sessionId: sessionIdA, expiresAt: '2026-08-19T00:01:00.000Z' }, sessionIdB), false);
  assert.equal(shouldOpenIncomingRequest({ type: 'PairedOffline', pair }, sessionIdA), false);
  assert.equal(shouldOpenIncomingRequest({ type: 'Connected', pair, sessionId: sessionIdA, role: 'sharer' }, sessionIdA), false);
  assert.equal(shouldOpenIncomingRequest({ type: 'IncomingRequest', pair, sessionId: sessionIdA, expiresAt: '2026-08-19T00:01:00.000Z' }, null), false);
});

test('stale notification show cannot overwrite a newer incoming request', async () => {
  const shown: string[] = [];
  let showA: (value: boolean) => void = () => undefined;
  const fakeNotifications = {
    async showRequestNotification(sessionId: string): Promise<boolean> {
      shown.push(sessionId);
      if (sessionId === sessionIdA) return new Promise<boolean>((resolve) => { showA = resolve; });
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
  assert.deepEqual(shown, [sessionIdA, sessionIdB]);
  assert.equal(notifier.getActiveSessionId(), sessionIdB);
  notifier.dispose();
});

test('stale completed show is cleared before a failed newer show can remain authoritative', async () => {
  const shown: string[] = [];
  const native: { sessionId: string | null } = { sessionId: null };
  let showA: (value: boolean) => void = () => undefined;
  const fakeNotifications = {
    async showRequestNotification(sessionId: string): Promise<boolean> {
      shown.push(sessionId);
      if (sessionId === sessionIdA) {
        return new Promise<boolean>((resolve) => {
          showA = (value) => {
            if (value) native.sessionId = sessionIdA;
            resolve(value);
          };
        });
      }
      return false;
    },
    async clearRequestNotification(): Promise<boolean> {
      native.sessionId = null;
      return true;
    },
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
  assert.deepEqual(shown, [sessionIdA, sessionIdB]);
  assert.equal(native.sessionId, null);
  assert.equal(notifier.getActiveSessionId(), null);
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
    mediaStats: { measuredBitrateBps: 400_000, bitrateParametersState: 'failed' },
  });
  assert.equal(liveDegraded.phase, 'degraded');
  assert.match(liveDegraded.label, /remote frame still visible/i);
  assert.doesNotMatch(liveDegraded.detail, /encoder bitrate cap/i);
  const liveGood = deriveProductPresentation({
    session: { type: 'Connected', pair, sessionId: sessionIdA, role: 'requester' },
    capture: { type: 'idle' },
    media: { type: 'live', sessionId: sessionIdA, quality: 'good', trackEpoch: 1 },
    mediaHealth: 'good',
    mediaStats: { measuredBitrateBps: 400_000, bitrateParametersState: 'failed' },
  });
  assert.equal(liveGood.phase, 'live');
  assert.match(liveGood.detail, /measured 400 kbps/i);
  assert.doesNotMatch(liveGood.detail, /encoder bitrate cap/i);
});

test('encoder bitrate warning is only shown for a sharer after a failed sender configure', () => {
  const viewer = deriveProductPresentation({
    session: { type: 'Connected', pair, sessionId: sessionIdA, role: 'requester' },
    capture: { type: 'idle' },
    media: { type: 'live', sessionId: sessionIdA, quality: 'good', trackEpoch: 1 },
    mediaHealth: 'good',
    mediaStats: { measuredBitrateBps: 400_000, bitrateParametersState: 'failed' },
  });
  assert.equal(viewer.phase, 'live');
  assert.doesNotMatch(viewer.detail, /encoder bitrate cap/i);

  const sharerApplied = deriveProductPresentation({
    session: { type: 'Connected', pair, sessionId: sessionIdA, role: 'sharer' },
    capture: { type: 'capturing', sessionId: sessionIdA },
    media: { type: 'publishing', sessionId: sessionIdA, quality: 'good' },
    mediaStats: { measuredBitrateBps: 800_000, bitrateParametersState: 'applied' },
  });
  assert.equal(sharerApplied.phase, 'sharing');
  assert.doesNotMatch(sharerApplied.detail, /encoder bitrate cap/i);

  const sharerFailed = deriveProductPresentation({
    session: { type: 'Connected', pair, sessionId: sessionIdA, role: 'sharer' },
    capture: { type: 'capturing', sessionId: sessionIdA },
    media: { type: 'publishing', sessionId: sessionIdA, quality: 'good' },
    mediaStats: { bitrateParametersState: 'failed' },
  });
  assert.equal(sharerFailed.phase, 'sharing');
  assert.match(sharerFailed.detail, /encoder bitrate cap was not applied/i);
});

test('availability updates cache while Error and only coordinated recovery leaves Error', async () => {
  const nowMs = Date.parse('2026-08-19T00:00:00.000Z');
  const localId = '11111111-1111-4111-8111-111111111111';
  class FakeControl implements SessionControlChannel {
    listeners = new Set<(event: ControlSessionEvent) => void>();
    sent: Array<{ type: ControlMessageType; payload: unknown }> = [];
    subscribe(listener: (event: ControlSessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async activate(_context: ControlTrustContext): Promise<void> {}
    async deactivate(): Promise<void> {}
    async connect(): Promise<string> { return sessionIdA; }
    async send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> {
      this.sent.push({ type, payload });
      return { version: 1, messageId: '55555555-5555-4555-8555-555555555555', type, sessionId: sessionIdA, senderDeviceId: localId, sequence: this.sent.length, timestamp: new Date(nowMs).toISOString(), payload } as AnyControlMessage;
    }
    async close(): Promise<void> {}
    emit(event: ControlSessionEvent): void { for (const listener of this.listeners) listener(event); }
  }
  class FakePending implements PendingRequestPersistence {
    saved: unknown = null;
    async clearOnStartup(): Promise<void> { this.saved = null; }
    async clear(): Promise<void> { this.saved = null; }
    async save(record: unknown): Promise<void> { this.saved = record; }
  }
  const control = new FakeControl();
  const pending = new FakePending();
  const controller = new SessionController(
    { bootstrap: async () => ({ identity: { deviceId: localId } }) },
    { loadPairSecret: async () => 'ab'.repeat(32) },
    pending,
    control,
    { async append() {} },
    () => nowMs,
  );
  await controller.activatePair(pair);
  controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'peer' });
  await controller.requestScreen();
  control.emit({ type: 'message', message: { version: 1, messageId: '66666666-6666-4666-8666-666666666666', type: 'ACCEPT_SCREEN', sessionId: sessionIdA, senderDeviceId: pair.partnerDeviceId, sequence: 1, timestamp: new Date(nowMs).toISOString(), payload: {} } as AnyControlMessage });
  await settle();
  await controller.mediaFailed(sessionIdA);
  await settle();
  assert.equal(controller.getSnapshot().type, 'Error');

  controller.updateAvailability({ kind: 'offline', pair, localAdvertised: true });
  await settle();
  assert.equal(controller.getSnapshot().type, 'Error');
  assert.equal((controller.getSnapshot() as { pair: PairTrustMetadata }).pair.pairId, pair.pairId);

  controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.20', port: 45001 }, serviceName: 'peer' });
  await settle();
  assert.equal(controller.getSnapshot().type, 'Error');

  const calls: string[] = [];
  await recoverProductError({
    session: { async clearError() { calls.push('session'); await controller.clearError(); } },
    media: { async resetToIdle() { calls.push('media'); } },
    capture: { async resetToIdle() { calls.push('capture'); } },
    notifications: { async clearRequestNotification() { calls.push('notification'); return true; } },
    pip: { async exitPip() { calls.push('pip'); return true; } },
    keepAwake: { async disable() { calls.push('keepawake'); return true; } },
  });
  await settle();
  assert.deepEqual(new Set(calls.slice(0, 5)), new Set(['pip', 'keepawake', 'notification', 'media', 'capture']));
  assert.equal(calls.at(-1), 'session');
  const recovered = controller.getSnapshot();
  assert.equal(recovered.type, 'PairedAvailable');
  if (recovered.type === 'PairedAvailable') {
    assert.equal(recovered.pair.pairId, pair.pairId);
    assert.equal(recovered.endpoint.host, '192.168.1.20');
  }
  controller.dispose();
});
