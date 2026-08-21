import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeControlMessage, encodeControlMessage } from '../src/protocol/ControlCodec';
import type { AnyControlMessage } from '../src/protocol/ControlMessage';
import { SessionController, type PendingRequestPersistence, type SessionControlChannel } from '../src/session/SessionController';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { ControlSessionEvent, ControlTrustContext } from '../src/control/ControlSession';
import type { ControlMessageType, ControlPayloadMap } from '../src/protocol/ControlMessage';

const nowMs = Date.parse('2026-08-19T00:00:00.000Z');
const localId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '44444444-4444-4444-8444-444444444444', partnerDeviceId: partnerId, partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };

class FakeControl implements SessionControlChannel {
  listeners = new Set<(event: ControlSessionEvent) => void>(); sent: Array<{ type: ControlMessageType; payload: unknown }> = []; closed = 0;
  subscribe(listener: (event: ControlSessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async activate(_context: ControlTrustContext): Promise<void> {} async deactivate(): Promise<void> {} async connect(): Promise<string> { return sessionId; }
  async send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> { this.sent.push({ type, payload }); return { version: 1, messageId: '55555555-5555-4555-8555-555555555555', type, sessionId, senderDeviceId: localId, sequence: this.sent.length, timestamp: new Date(nowMs).toISOString(), payload } as AnyControlMessage; }
  async close(): Promise<void> { this.closed += 1; }
  emit(event: ControlSessionEvent): void { for (const listener of this.listeners) listener(event); }
}
class Pending implements PendingRequestPersistence { async clearOnStartup(): Promise<void> {} async clear(): Promise<void> {} async save(): Promise<void> {} }
async function settle(): Promise<void> { for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }
function remote<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): AnyControlMessage { return { version: 1, messageId: '66666666-6666-4666-8666-666666666666', type, sessionId, senderDeviceId: partnerId, sequence: 1, timestamp: new Date(nowMs).toISOString(), payload } as AnyControlMessage; }
function controllerHarness() { const control = new FakeControl(); const controller = new SessionController({ bootstrap: async () => ({ identity: { deviceId: localId } }) }, { loadPairSecret: async () => 'ab'.repeat(32) }, new Pending(), control, { append: async () => undefined }, () => nowMs); return { control, controller }; }

test('CAPTURE_DENIED is strict and bounded by the control codec', () => {
  const message = remote('CAPTURE_DENIED', { reason: 'system_denied' });
  assert.deepEqual(decodeControlMessage(encodeControlMessage(message)), message);
  assert.throws(() => decodeControlMessage(JSON.stringify({ ...message, payload: { reason: 'anything' } })), /CAPTURE_DENIED payload/i);
});

test('local sharer denial closes the session only after an authenticated CAPTURE_DENIED message', async () => {
  const { control, controller } = controllerHarness(); await controller.activatePair(pair); control.emit({ type: 'message', message: remote('REQUEST_SCREEN', { expiresAt: new Date(nowMs + 30_000).toISOString() }) }); await settle(); await controller.acceptRequest(); assert.equal(controller.getSnapshot().type, 'Connected');
  await controller.captureDenied(sessionId, 'system_denied'); assert.equal(control.sent.at(-1)?.type, 'CAPTURE_DENIED'); assert.equal(controller.getSnapshot().type, 'PairedOffline'); controller.dispose();
});

test('requester treats remote capture denial and revocation as safe terminal product states', async () => {
  const { control, controller } = controllerHarness(); await controller.activatePair(pair); controller.updateAvailability({ kind: 'available', pair, endpoint: { host: '192.168.1.11', port: 45001 }, serviceName: 'peer' }); await controller.requestScreen(); control.emit({ type: 'message', message: remote('ACCEPT_SCREEN', {}) }); await settle(); assert.equal(controller.getSnapshot().type, 'Connected');
  control.emit({ type: 'message', message: remote('CAPTURE_DENIED', { reason: 'notifications_denied' }) }); await settle(); assert.equal(controller.getSnapshot().type, 'Error'); controller.dispose();
});
