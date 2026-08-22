import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AvailabilityService } from '../src/availability/AvailabilityService';
import type { ControlSessionEvent, ControlTrustContext } from '../src/control/ControlSession';
import { HmacDiscoveryAuthenticator, type HmacSha256 } from '../src/domain/discovery/TrustedDiscoveryAuthenticator';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { AnyControlMessage, ControlMessageType, ControlPayloadMap } from '../src/protocol/ControlMessage';
import type { ChirpDiscovery, ChirpDiscoveryEvent, DiscoveryAdvertisementPreparation, DiscoveryRegistration } from '../src/platform/discovery/ChirpDiscovery';
import { SessionController, type SessionControlChannel } from '../src/session/SessionController';

const localId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const secret = 'ab'.repeat(32);
const pair: PairTrustMetadata = {
  schemaVersion: 1,
  protocolVersion: 1,
  status: 'confirmed',
  pairId: '33333333-3333-4333-8333-333333333333',
  partnerDeviceId: partnerId,
  partnerDeviceName: 'Claire',
  pairedAt: '2026-08-18T12:00:00.000Z',
};

class NodeHmac implements HmacSha256 {
  async macHex(keyHex: string, message: string): Promise<string> {
    return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex');
  }
}

class RecoverableControl implements SessionControlChannel {
  private readonly sessionListeners = new Set<(event: ControlSessionEvent) => void>();
  private readonly listenerChangeListeners = new Set<() => void>();
  wifiAvailable = false;
  activationCount = 0;
  ensureCalls = 0;

  subscribe(listener: (event: ControlSessionEvent) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }
  subscribeListenerChanges(listener: () => void): () => void {
    this.listenerChangeListeners.add(listener);
    return () => this.listenerChangeListeners.delete(listener);
  }
  async activate(_context: ControlTrustContext): Promise<void> { this.activationCount += 1; }
  async deactivate(): Promise<void> {}
  async ensureListening(expectedHost?: string): Promise<{ host: string; port: number }> {
    this.ensureCalls += 1;
    if (!this.wifiAvailable) throw new Error('Trusted availability needs an active private IPv4 Wi-Fi network.');
    return { host: expectedHost ?? '192.168.18.10', port: 44001 };
  }
  async connect(): Promise<string> { throw new Error('unused'); }
  async send<T extends ControlMessageType>(_type: T, _payload: ControlPayloadMap[T]): Promise<AnyControlMessage> { throw new Error('unused'); }
  async close(): Promise<void> {}
}

class FakeDiscovery implements ChirpDiscovery {
  private readonly listeners = new Set<(event: ChirpDiscoveryEvent) => void>();
  readonly preparation: DiscoveryAdvertisementPreparation = {
    advertisementId: 'advertisement-local',
    host: '192.168.18.10',
    port: 41001,
    nonce: '10'.repeat(16),
  };
  async prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation> { return this.preparation; }
  async start(): Promise<DiscoveryRegistration> { return { serviceName: 'Chirp-local' }; }
  async probe(): Promise<void> {}
  async stop(): Promise<void> {}
  subscribe(listener: (event: ChirpDiscoveryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: ChirpDiscoveryEvent): void { for (const listener of this.listeners) listener(event); }
}

class PendingStore {
  async clearOnStartup(): Promise<void> {}
  async clear(): Promise<void> {}
  async save(): Promise<void> {}
}

class Diagnostics {
  async append(): Promise<void> {}
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('persisted pair boots PairedOffline without Wi-Fi and recovers through availability retry only', async () => {
  const control = new RecoverableControl();
  const discovery = new FakeDiscovery();
  const authenticator = new HmacDiscoveryAuthenticator(new NodeHmac());
  const diagnostics = new Diagnostics();
  const pairSecrets = { loadPairSecret: async () => secret };
  const controller = new SessionController(
    { bootstrap: async () => ({ identity: { deviceId: localId } }) },
    pairSecrets,
    new PendingStore(),
    control,
    diagnostics,
  );
  const availability = new AvailabilityService(pairSecrets, diagnostics, discovery, authenticator, control);
  const unsubscribe = availability.subscribe(() => controller.updateAvailability(availability.getSnapshot()));

  await controller.activatePair(pair);
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  assert.equal(control.activationCount, 1);

  await availability.activate(pair);
  assert.equal(availability.getSnapshot().kind, 'offline');
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  assert.equal(control.activationCount, 1, 'listener failure must not invalidate loaded trust');

  control.wifiAvailable = true;
  await availability.retry();
  const local = availability.getSnapshot();
  assert.equal(local.kind, 'offline');
  if (local.kind === 'offline') assert.equal(local.localAdvertised, true);
  assert.equal(controller.getSnapshot().type, 'PairedOffline');
  assert.equal(control.activationCount, 1, 'retry must not reactivate or re-pair trust');
  assert.equal(control.ensureCalls, 2);

  const remote = { nonce: '20'.repeat(16), host: '192.168.18.11', port: 42002, controlPort: 45002 };
  discovery.emit({
    type: 'service_resolved',
    service: {
      serviceName: 'Chirp-remote',
      host: remote.host,
      port: remote.port,
      peerHint: await authenticator.derivePeerHint(secret, remote.nonce),
      nonce: remote.nonce,
      proof: await authenticator.createProof(secret, remote),
    },
  });
  await settle();

  const recovered = controller.getSnapshot();
  assert.equal(recovered.type, 'PairedAvailable');
  if (recovered.type === 'PairedAvailable') assert.deepEqual(recovered.endpoint, { host: remote.host, port: remote.controlPort });
  assert.equal(control.activationCount, 1);

  unsubscribe();
  availability.dispose();
  controller.dispose();
});