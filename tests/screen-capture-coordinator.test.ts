import assert from 'node:assert/strict';
import test from 'node:test';
import { ScreenCaptureCoordinator, type CaptureSessionAuthority } from '../src/capture/ScreenCaptureCoordinator';
import type { ScreenCaptureNativeEvent, ScreenCapturePort } from '../src/capture/ScreenCapturePort';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { SessionState } from '../src/session/SessionState';

const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '44444444-4444-4444-8444-444444444444', partnerDeviceId: '22222222-2222-4222-8222-222222222222', partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };
const sessionId = '33333333-3333-4333-8333-333333333333';

class FakePort implements ScreenCapturePort {
  notificationAllowed = true; consentGranted = true; starts = 0; stops = 0; deferConsent = false;
  private readonly consentResolvers: Array<(value: boolean) => void> = [];
  private readonly listeners = new Set<(event: ScreenCaptureNativeEvent) => void>();
  subscribe(listener: (event: ScreenCaptureNativeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async ensureNotificationPermission(): Promise<boolean> { return this.notificationAllowed; }
  async requestConsent(): Promise<boolean> {
    if (this.deferConsent) return new Promise<boolean>((resolve) => this.consentResolvers.push(resolve));
    return this.consentGranted;
  }
  resolveConsent(value: boolean): void { const resolver = this.consentResolvers.shift(); if (resolver) resolver(value); }
  async start(sessionId: string): Promise<void> { this.starts += 1; }
  async stop(): Promise<void> { this.stops += 1; this.resolveConsent(false); } // mirrors native clearPendingConsent
  getNativeState(): 'idle' | 'starting' | 'capturing' { return 'idle'; }
  emit(event: ScreenCaptureNativeEvent): void { for (const listener of this.listeners) listener(event); }
}

class FakeSession implements CaptureSessionAuthority {
  state: SessionState = { type: 'Connected', pair, sessionId, role: 'sharer' };
  denied: Array<{ sessionId: string; reason: 'system_denied' | 'notifications_denied' }> = [];
  failed: Array<{ sessionId: string; reason: 'capture_failed' | 'capture_revoked' }> = [];
  ended = 0;
  endedSessionIds: string[] = [];
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): SessionState => this.state;
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async captureDenied(sessionId: string, reason: 'system_denied' | 'notifications_denied'): Promise<void> { this.denied.push({ sessionId, reason }); }
  async captureFailed(sessionId: string, reason: 'capture_failed' | 'capture_revoked'): Promise<void> { this.failed.push({ sessionId, reason }); }
  async endSession(expectedSessionId: string): Promise<void> { this.ended += 1; this.endedSessionIds.push(expectedSessionId); }
  setState(state: SessionState): void { this.state = state; for (const listener of this.listeners) listener(); }
}
class FakeDiagnostics { readonly events: DiagnosticEventKind[] = []; async append(kind: DiagnosticEventKind): Promise<void> { this.events.push(kind); } }
async function settle(): Promise<void> { for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }
function harness() { const port = new FakePort(), session = new FakeSession(), diagnostics = new FakeDiagnostics(); return { port, session, diagnostics, coordinator: new ScreenCaptureCoordinator(port, session, diagnostics) }; }

test('notification denial fails closed before Android capture consent', async () => {
  const { port, session, diagnostics, coordinator } = harness(); port.notificationAllowed = false;
  await coordinator.requestForConnectedSharer();
  assert.deepEqual(session.denied, [{ sessionId, reason: 'notifications_denied' }]); assert.equal(port.starts, 0); assert.equal(coordinator.getSnapshot().type, 'error'); assert.ok(diagnostics.events.includes('capture_consent_denied')); coordinator.dispose();
});

test('system consent denial notifies the authenticated peer and never starts capture', async () => {
  const { port, session, coordinator } = harness(); port.consentGranted = false;
  await coordinator.requestForConnectedSharer();
  assert.deepEqual(session.denied, [{ sessionId, reason: 'system_denied' }]); assert.equal(port.starts, 0); coordinator.dispose();
});

test('fresh consent starts native capture and only native started event becomes capturing truth', async () => {
  const { port, diagnostics, coordinator } = harness();
  await coordinator.requestForConnectedSharer(); assert.equal(port.starts, 1); assert.equal(coordinator.getSnapshot().type, 'starting');
  port.emit({ type: 'started', sessionId }); await settle(); assert.equal(coordinator.getSnapshot().type, 'capturing'); assert.ok(diagnostics.events.includes('capture_started')); coordinator.dispose();
});

test('notification Stop ends the connected sharer session and capture returns idle', async () => {
  const { port, session, coordinator } = harness(); await coordinator.requestForConnectedSharer(); port.emit({ type: 'started', sessionId }); await settle();
  port.emit({ type: 'stopped', reason: 'notification', sessionId }); await settle(); assert.equal(session.ended, 1); assert.equal(coordinator.getSnapshot().type, 'idle'); coordinator.dispose();
});

test('system projection revocation becomes a typed session failure', async () => {
  const { port, session, coordinator } = harness(); await coordinator.requestForConnectedSharer(); port.emit({ type: 'started', sessionId }); await settle();
  port.emit({ type: 'revoked', sessionId }); await settle(); assert.deepEqual(session.failed, [{ sessionId, reason: 'capture_revoked' }]); assert.equal(coordinator.getSnapshot().type, 'error'); coordinator.dispose();
});

test('leaving the connected sharer state tears down native capture', async () => {
  const { port, session, coordinator } = harness(); await coordinator.requestForConnectedSharer(); port.emit({ type: 'started', sessionId }); await settle();
  session.setState({ type: 'PairedAvailable', pair, endpoint: { host: '192.168.1.10', port: 45000 } }); await settle(); assert.equal(port.stops, 1); assert.equal(coordinator.getSnapshot().type, 'idle'); coordinator.dispose();
});

test('a grant delivered after the session ended cannot start capture for the dead session (stale permission result ignored)', async () => {
  const { port, session, coordinator } = harness(); port.deferConsent = true;
  const pending = coordinator.requestForConnectedSharer(); await settle();
  assert.equal(coordinator.getSnapshot().type, 'requesting_consent');
  session.setState({ type: 'PairedOffline', pair }); await settle(); // peer ends / revoke while dialog open
  port.resolveConsent(true); // user grants late (system dialog action arrives after session end)
  await pending; await settle();
  assert.equal(port.starts, 0); // stale grant never starts capture
  assert.equal(session.denied.length, 0); // re-check short-circuits: no denial sent for the ended session
  assert.equal(coordinator.getSnapshot().type, 'idle');
  coordinator.dispose();
});

test('duplicate start is refused, duplicate stop is safe, and a late started event for an ended session cannot mark capture capturing', async () => {
  const { port, session, coordinator } = harness();
  await coordinator.requestForConnectedSharer(); assert.equal(coordinator.getSnapshot().type, 'starting');
  await assert.rejects(() => coordinator.requestForConnectedSharer(), /already active/); // duplicate start refused
  await coordinator.stopSharing(); await coordinator.stopSharing(); // duplicate stop safe
  assert.ok(port.stops >= 2);
  session.setState({ type: 'PairedOffline', pair }); await settle(); assert.equal(coordinator.getSnapshot().type, 'idle');
  port.emit({ type: 'started', sessionId }); await settle(); // stale native started event for the ended session
  assert.equal(coordinator.getSnapshot().type, 'idle');
  assert.equal(port.starts, 1); // never double-started
  coordinator.dispose();
});

test('a MediaProjection denial arriving after the original session ended cannot terminate a replacement session', async () => {
  const { port, session, coordinator } = harness(); port.deferConsent = true;
  const pending = coordinator.requestForConnectedSharer(); await settle();
  assert.equal(coordinator.getSnapshot().type, 'requesting_consent');
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  session.setState({ type: 'PairedOffline', pair }); await settle(); // session A ends while dialog open
  session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'sharer' }); await settle(); // session B becomes Connected
  port.resolveConsent(false); // A's denial arrives late
  await pending; await settle();
  assert.equal(port.starts, 0); // A's denial never starts capture
  assert.deepEqual(session.denied, []); // B untouched: no denial was sent for B
  assert.equal(session.ended, 0); // B session not terminated
  assert.equal(coordinator.getSnapshot().type, 'idle'); // coordinator returns to idle for B to request fresh
  coordinator.dispose();
});

test('a capture event from a replaced session cannot end or fail the replacement session', async () => {
  const { port, session, coordinator } = harness();
  await coordinator.requestForConnectedSharer(); port.emit({ type: 'started', sessionId }); await settle();
  assert.equal(coordinator.getSnapshot().type, 'capturing');
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  session.setState({ type: 'PairedOffline', pair }); await settle(); // A ends -> coordinator stops capture -> idle
  session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'sharer' }); await settle();
  assert.equal(coordinator.getSnapshot().type, 'idle');
  // Late capture events from A's attempt must be ignored entirely.
  port.emit({ type: 'stopped', reason: 'user', sessionId }); await settle();
  port.emit({ type: 'revoked', sessionId }); await settle();
  port.emit({ type: 'started', sessionId }); await settle();
  assert.equal(session.ended, 0); // B never ended by A's stale stopped
  assert.deepEqual(session.failed, []); // B never failed by A's stale revoked
  assert.equal(coordinator.getSnapshot().type, 'idle');
  coordinator.dispose();
});

test('Stop sharing with a Connected sharer and no active native capture still ends the exact current session', async () => {
  const { port, session, coordinator } = harness();
  assert.equal(coordinator.getSnapshot().type, 'idle'); // no capture active
  await coordinator.stopSharing(); await settle();
  assert.equal(session.ended, 1); // exact current sharer session ended locally
  assert.equal(session.endedSessionIds.at(-1), sessionId);
  assert.equal(port.stops, 0); // nothing native to stop
  coordinator.dispose();
});

test('a delayed stopped event from capture A cannot end replacement session B (endSession is session-scoped)', async () => {
  const { port, session, coordinator } = harness();
  await coordinator.requestForConnectedSharer(); port.emit({ type: 'started', sessionId }); await settle();
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  session.setState({ type: 'PairedOffline', pair }); await settle(); // A ends -> coordinator idle
  session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'sharer' }); await settle();
  assert.equal(coordinator.getSnapshot().type, 'idle');
  port.emit({ type: 'stopped', reason: 'user', sessionId }); await settle(); // stale A stopped
  assert.equal(session.ended, 0); // B never ended
  assert.equal(session.endedSessionIds.some((id) => id === replacementSessionId), false);
  coordinator.dispose();
});
