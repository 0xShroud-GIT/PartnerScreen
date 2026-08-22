import assert from 'node:assert/strict';
import test from 'node:test';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import type { AnyControlMessage, ControlMessageType, ControlPayloadMap } from '../src/protocol/ControlMessage';
import type { ControlSessionEvent, ControlTrustContext } from '../src/control/ControlSession';
import { SessionController, type PendingRequestPersistence, type SessionControlChannel } from '../src/session/SessionController';

const nowMs = Date.parse('2026-08-19T00:00:00.000Z');
const localId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '44444444-4444-4444-8444-444444444444', partnerDeviceId: partnerId, partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };

class FakeControl implements SessionControlChannel {
  readonly listeners = new Set<(event: ControlSessionEvent) => void>(); readonly sent: Array<{ type: ControlMessageType; payload: unknown }> = []; closed = 0; context: ControlTrustContext | null = null;
  subscribe(listener: (event: ControlSessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async activate(context: ControlTrustContext): Promise<void> { this.context = context; }
  async deactivate(): Promise<void> { this.context = null; }
  async connect(): Promise<string> { return sessionId; }
  async send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> { this.sent.push({ type, payload }); return { version: 1, messageId: '55555555-5555-4555-8555-555555555555', type, sessionId, senderDeviceId: localId, sequence: this.sent.length, timestamp: new Date(nowMs).toISOString(), payload } as AnyControlMessage; }
  async close(): Promise<void> { this.closed += 1; }
  emit(event: ControlSessionEvent): void { for (const listener of this.listeners) listener(event); }
}
class FakePending implements PendingRequestPersistence { saved: unknown = null; clearCount = 0; async clearOnStartup(): Promise<void> { this.clearCount += 1; this.saved = null; } async clear(): Promise<void> { this.clearCount += 1; this.saved = null; } async save(record: unknown): Promise<void> { this.saved = record; } }
class FakeDiagnostics { readonly events: DiagnosticEventKind[] = []; async append(kind: DiagnosticEventKind): Promise<void> { this.events.push(kind); } }
async function settle(): Promise<void> { for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }
function harness() {
  const control = new FakeControl(), pending = new FakePending(), diagnostics = new FakeDiagnostics();
  const controller = new SessionController({ bootstrap: async () => ({ identity: { deviceId: localId } }) }, { loadPairSecret: async () => 'ab'.repeat(32) }, pending, control, diagnostics, () => nowMs);
  return { control, pending, diagnostics, controller };
}
function remote<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T], sequence = 1): AnyControlMessage { return { version: 1, messageId: sequence === 1 ? '66666666-6666-4666-8666-666666666666' : '77777777-7777-4777-8777-777777777777', type, sessionId, senderDeviceId: partnerId, sequence, timestamp: new Date(nowMs).toISOString(), payload } as AnyControlMessage; }

test('request accept and stop lifecycle never implies capture or LIVE', async () => {
  const { control, controller, diagnostics } = harness(); await controller.activatePair(pair);
  controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'Chirp-peer' });
  assert.equal(controller.getSnapshot().type, 'PairedAvailable'); await controller.requestScreen(); assert.equal(controller.getSnapshot().type, 'OutgoingRequest'); assert.equal(control.sent[0]?.type, 'REQUEST_SCREEN');
  control.emit({ type: 'message', message: remote('ACCEPT_SCREEN', {}) }); await settle(); const connected = controller.getSnapshot(); assert.equal(connected.type, 'Connected'); if (connected.type === 'Connected') assert.equal(connected.role, 'requester');
  await controller.endSession(); assert.equal(controller.getSnapshot().type, 'PairedAvailable'); assert.equal(control.sent.at(-1)?.type, 'SESSION_END'); assert.ok(diagnostics.events.includes('session_connected')); controller.dispose();
});

test('incoming request persists only metadata and decline returns to paired state', async () => {
  const { control, pending, controller } = harness(); await controller.activatePair(pair); controller.updateAvailability({ kind: 'offline', pair, localAdvertised: true });
  control.emit({ type: 'message', message: remote('REQUEST_SCREEN', { expiresAt: new Date(nowMs + 30_000).toISOString() }) }); await settle(); assert.equal(controller.getSnapshot().type, 'IncomingRequest'); assert.ok(pending.saved);
  await controller.declineRequest(); assert.equal(controller.getSnapshot().type, 'PairedOffline'); assert.equal(control.sent.at(-1)?.type, 'DECLINE_SCREEN'); assert.equal(pending.saved, null); controller.dispose();
});

test('cancel and remote disconnect clean request state deterministically', async () => {
  const { control, controller } = harness(); await controller.activatePair(pair); controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'peer' });
  await controller.requestScreen(); await controller.cancelRequest(); assert.equal(controller.getSnapshot().type, 'PairedAvailable'); assert.equal(control.sent.at(-1)?.type, 'REQUEST_CANCEL');
  await controller.requestScreen(); control.emit({ type: 'closed', sessionId }); await settle(); assert.equal(controller.getSnapshot().type, 'PairedAvailable'); controller.dispose();
});

test('busy receiver rejects a second request without creating a shadow pending state', async () => {
  const { control, controller } = harness(); await controller.activatePair(pair); controller.updateAvailability({ kind: 'offline', pair, localAdvertised: true });
  control.emit({ type: 'message', message: remote('REQUEST_SCREEN', { expiresAt: new Date(nowMs + 30_000).toISOString() }) }); await settle(); assert.equal(controller.getSnapshot().type, 'IncomingRequest');
  control.emit({ type: 'message', message: remote('REQUEST_SCREEN', { expiresAt: new Date(nowMs + 30_000).toISOString() }, 2) }); await settle(); assert.equal(control.sent.at(-1)?.type, 'DECLINE_SCREEN'); controller.dispose();
});

test('an expired incoming request is rejected at the boundary and can never be accepted later (atomic adoption fails closed)', async () => {
  const { control, pending, controller } = harness(); await controller.activatePair(pair); controller.updateAvailability({ kind: 'offline', pair, localAdvertised: true });
  control.emit({ type: 'message', message: remote('REQUEST_SCREEN', { expiresAt: new Date(nowMs - 1_000).toISOString() }) }); await settle();
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  assert.equal(control.sent.at(-1)?.type, 'SESSION_ERROR');
  assert.equal(pending.saved, null);
  await controller.acceptRequest(); await settle();
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  assert.equal(control.sent.some((message) => message.type === 'ACCEPT_SCREEN'), false);
  controller.dispose();
});

test('a cancelled/declined request can never be accepted later and a stale terminal for the ended session cannot mutate current state', async () => {
  const { control, pending, controller } = harness(); await controller.activatePair(pair); controller.updateAvailability({ kind: 'offline', pair, localAdvertised: true });
  control.emit({ type: 'message', message: remote('REQUEST_SCREEN', { expiresAt: new Date(nowMs + 30_000).toISOString() }) }); await settle();
  assert.equal(controller.getSnapshot().type, 'IncomingRequest');
  await controller.declineRequest(); assert.equal(controller.getSnapshot().type, 'PairedOffline'); assert.equal(pending.saved, null);
  // Delayed accept for the already-declined request must not resurrect or adopt anything.
  await controller.acceptRequest(); await settle();
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  assert.equal(control.sent.some((message) => message.type === 'ACCEPT_SCREEN'), false);
  // A stale duplicate terminal (SESSION_END for the same sessionId) after the session ended must not
  // mutate the current paired state; it is handled fail-closed and the state stays put.
  control.emit({ type: 'message', message: remote('SESSION_END', { reason: 'disconnect' }, 2) }); await settle();
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  assert.equal(control.sent.at(-1)?.type, 'SESSION_ERROR');
  assert.equal(pending.saved, null);
  controller.dispose();
});

test('a fatal control error terminates the session and closes the underlying ControlSession so a fresh session can connect', async () => {
  const { control, controller } = harness(); await controller.activatePair(pair);
  controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'peer' });
  await controller.requestScreen(); assert.equal(controller.getSnapshot().type, 'OutgoingRequest');
  control.emit({ type: 'error', code: 'transport_failed' }); await settle();
  assert.equal(controller.getSnapshot().type, 'PairedAvailable'); // product session terminated
  assert.ok(control.closed >= 1); // underlying ControlSession closed: no hidden active connection wedges the next request
  await controller.requestScreen(); await settle();
  assert.equal(controller.getSnapshot().type, 'OutgoingRequest'); // fresh subsequent session can connect
  assert.equal(control.sent.at(-1)?.type, 'REQUEST_SCREEN');
  controller.dispose();
});

test('availability updates must not leave Error; clearError uses the latest cached availability', async () => {
  const { control, controller } = harness();
  await controller.activatePair(pair);
  controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'peer' });
  await controller.requestScreen();
  control.emit({ type: 'message', message: remote('ACCEPT_SCREEN', {}) });
  await settle();
  const sid = (controller.getSnapshot() as { sessionId: string }).sessionId;
  await controller.mediaFailed(sid);
  await settle();
  assert.equal(controller.getSnapshot().type, 'Error');
  controller.updateAvailability({ kind: 'offline', pair, localAdvertised: true });
  await settle();
  assert.equal(controller.getSnapshot().type, 'Error');
  assert.equal((controller.getSnapshot() as { pair: PairTrustMetadata }).pair.pairId, pair.pairId);
  await controller.clearError();
  await settle();
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  controller.dispose();
});

test('a transient control reconnect never terminates the active product session', async () => {
  const { control, controller } = harness(); await controller.activatePair(pair);
  controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'peer' });
  await controller.requestScreen(); control.emit({ type: 'message', message: remote('ACCEPT_SCREEN', {}) }); await settle();
  assert.equal(controller.getSnapshot().type, 'Connected');
  // Control transport interruption while media stays viable must surface as reconnect, not session death.
  control.emit({ type: 'reconnecting', sessionId, role: 'initiator', attempt: 1 }); await settle();
  assert.equal(controller.getSnapshot().type, 'Connected');
  control.emit({ type: 'reconnected', sessionId, role: 'initiator' }); await settle();
  assert.equal(controller.getSnapshot().type, 'Connected');
  assert.equal(control.closed, 0); // no teardown happened on a transient reconnect
  // A genuine authenticated transport failure (reconnect exhausted) is the only thing that ends it.
  control.emit({ type: 'error', code: 'transport_failed' }); await settle();
  assert.notEqual(controller.getSnapshot().type, 'Connected');
  controller.dispose();
});

test('endSession(expectedSessionId) only terminates the exact matching Connected session', async () => {
  const { control, controller } = harness(); await controller.activatePair(pair);
  controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'peer' });
  await controller.requestScreen(); control.emit({ type: 'message', message: remote('ACCEPT_SCREEN', {}) }); await settle();
  assert.equal(controller.getSnapshot().type, 'Connected');
  const staleSessionId = '99999999-9999-4999-8999-999999999999';
  await controller.endSession(staleSessionId); await settle();
  assert.equal(controller.getSnapshot().type, 'Connected'); // stale id must not end the current session
  const current = controller.getSnapshot();
  if (current.type === 'Connected') await controller.endSession(current.sessionId);
  await settle();
  assert.equal(controller.getSnapshot().type, 'PairedAvailable'); // exact id ends it
  controller.dispose();
});
