import assert from 'node:assert/strict';
import test from 'node:test';
import type { ControlSessionEvent, ControlTrustContext } from '../src/control/ControlSession';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { AnyControlMessage, ControlMessageType, ControlPayloadMap } from '../src/protocol/ControlMessage';
import { SessionController, type PendingRequestPersistence, type SessionControlChannel } from '../src/session/SessionController';

const nowMs = Date.parse('2026-08-19T00:00:00.000Z');
const localId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const pair: PairTrustMetadata = {
  schemaVersion: 1,
  protocolVersion: 1,
  status: 'confirmed',
  pairId: '44444444-4444-4444-8444-444444444444',
  partnerDeviceId: partnerId,
  partnerDeviceName: 'Claire',
  pairedAt: '2026-08-18T12:00:00.000Z',
};

class FakeControl implements SessionControlChannel {
  readonly listeners = new Set<(event: ControlSessionEvent) => void>();
  rejectAccept = false;

  subscribe(listener: (event: ControlSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async activate(_context: ControlTrustContext): Promise<void> {}
  async deactivate(): Promise<void> {}
  async connect(): Promise<string> { return sessionId; }
  async close(): Promise<void> {}
  async send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> {
    if (type === 'ACCEPT_SCREEN' && this.rejectAccept) throw new Error('accept send failed');
    return {
      version: 1,
      messageId: '55555555-5555-4555-8555-555555555555',
      type,
      sessionId,
      senderDeviceId: localId,
      sequence: 1,
      timestamp: new Date(nowMs).toISOString(),
      payload,
    } as AnyControlMessage;
  }
  emit(event: ControlSessionEvent): void { for (const listener of this.listeners) listener(event); }
}

class FakePending implements PendingRequestPersistence {
  saved: unknown = null;
  clearCount = 0;
  async clearOnStartup(): Promise<void> { this.clearCount += 1; this.saved = null; }
  async clear(): Promise<void> { this.clearCount += 1; this.saved = null; }
  async save(record: unknown): Promise<void> { this.saved = record; }
}

class FakeDiagnostics {
  readonly events: DiagnosticEventKind[] = [];
  async append(kind: DiagnosticEventKind): Promise<void> { this.events.push(kind); }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function remoteRequest(): AnyControlMessage {
  return {
    version: 1,
    messageId: '66666666-6666-4666-8666-666666666666',
    type: 'REQUEST_SCREEN',
    sessionId,
    senderDeviceId: partnerId,
    sequence: 1,
    timestamp: new Date(nowMs).toISOString(),
    payload: { expiresAt: new Date(nowMs + 30_000).toISOString() },
  };
}

test('failed ACCEPT_SCREEN keeps the bounded incoming request owned for retry', async () => {
  const control = new FakeControl();
  const pending = new FakePending();
  const controller = new SessionController(
    { bootstrap: async () => ({ identity: { deviceId: localId } }) },
    { loadPairSecret: async () => 'ab'.repeat(32) },
    pending,
    control,
    new FakeDiagnostics(),
    () => nowMs,
  );

  await controller.activatePair(pair);
  controller.updateAvailability({ kind: 'offline', pair, localAdvertised: true });
  control.emit({ type: 'message', message: remoteRequest() });
  await settle();
  assert.equal(controller.getSnapshot().type, 'IncomingRequest');
  const saved = pending.saved;
  const clearsBeforeAccept = pending.clearCount;

  control.rejectAccept = true;
  await assert.rejects(controller.acceptRequest(), /accept send failed/);
  assert.equal(controller.getSnapshot().type, 'IncomingRequest');
  assert.equal(pending.saved, saved);
  assert.equal(pending.clearCount, clearsBeforeAccept);

  control.rejectAccept = false;
  await controller.acceptRequest();
  const connected = controller.getSnapshot();
  assert.equal(connected.type, 'Connected');
  if (connected.type === 'Connected') assert.equal(connected.role, 'sharer');
  assert.equal(pending.saved, null);
  controller.dispose();
});