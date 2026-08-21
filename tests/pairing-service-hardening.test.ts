import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagnosticsRepository } from '../src/domain/diagnostics/DiagnosticsRepository';
import type { IdentityRepository } from '../src/domain/identity/IdentityRepository';
import type { LocalDeviceIdentity } from '../src/domain/identity/LocalDeviceIdentity';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import type { SecretStore } from '../src/domain/security/SecretStore';
import {
  PAIR_METADATA_STORAGE_KEY,
  PAIR_PENDING_SECRET_KEY,
  PAIR_SECRET_STORAGE_KEY,
  PairTrustRepository,
} from '../src/domain/pairing/PairTrustRepository';
import { PairingService } from '../src/application/PairingService';
import type { PairingCrypto } from '../src/platform/pairing/ExpoPairingCrypto';
import type { PairingTransport } from '../src/platform/pairing/ExpoPairingTransport';
import type { PairingTransportEvent } from '../modules/partner-pairing-transport';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  async getSecret(key: string) { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string) { this.values.set(key, value); }
  async deleteSecret(key: string) { this.values.delete(key); }
}

class FailingPendingDeleteSecrets extends MemorySecrets {
  failPendingDelete = true;

  override async deleteSecret(key: string) {
    if (key === PAIR_PENDING_SECRET_KEY && this.failPendingDelete) {
      throw new Error('injected pending secret deletion failure');
    }
    await super.deleteSecret(key);
  }
}

class HarnessTransport implements PairingTransport {
  readonly handlers = new Set<(event: PairingTransportEvent) => void>();
  readonly closedConnections: string[] = [];
  readonly stoppedListeners: string[] = [];
  sentFrames = 0;

  async startListener() { return { listenerId: 'listener-1', host: '192.168.1.10', port: 41000 }; }
  async stopListener(listenerId: string) { this.stoppedListeners.push(listenerId); }
  async connect() { return 'client-1'; }
  async send() { this.sentFrames += 1; }
  async close(connectionId: string) { this.closedConnections.push(connectionId); }
  subscribe(listener: (event: PairingTransportEvent) => void) { this.handlers.add(listener); return () => this.handlers.delete(listener); }
  emit(event: PairingTransportEvent) { this.handlers.forEach((handler) => handler(event)); }
}

class HarnessCrypto implements PairingCrypto {
  failKeyGeneration = false;
  private id = 1;
  randomId() {
    const n = this.id++;
    return `${n.toString(16).padStart(8, '0')}-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;
  }
  async generateKeyHex() {
    if (this.failKeyGeneration) throw new Error('injected key generation failure');
    return 'ab'.repeat(32);
  }
  async seal(): Promise<string> { return 'c2VhbGVkLXBhaXJpbmctZnJhbWU='; }
  async open(): Promise<string> { throw new Error('not used'); }
}

const LOCAL: LocalDeviceIdentity = {
  schemaVersion: 1,
  deviceId: '11111111-1111-4111-8111-111111111111',
  deviceName: 'Local Phone',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

function identityRepository(): IdentityRepository {
  return { bootstrap: async () => ({ identity: LOCAL, created: false }) } as unknown as IdentityRepository;
}

function diagnostics(): DiagnosticsRepository {
  return { append: async () => undefined } as unknown as DiagnosticsRepository;
}

function makeService(
  ordinary = new MemoryStore(),
  secrets = new MemorySecrets(),
  transport = new HarnessTransport(),
  crypto = new HarnessCrypto(),
) {
  const trust = new PairTrustRepository(ordinary, secrets);
  const service = new PairingService(
    identityRepository(),
    trust,
    diagnostics(),
    transport,
    crypto,
    () => new Date('2026-08-18T00:00:00.000Z'),
  );
  return { service, trust, ordinary, secrets, transport, crypto };
}

test('creator setup failure closes listener created before the attempt exists', async () => {
  const harness = makeService();
  harness.crypto.failKeyGeneration = true;
  await harness.service.initialize();

  await assert.rejects(harness.service.startCreator(), /key generation failure/);
  assert.deepEqual(harness.transport.stoppedListeners, ['listener-1']);
  assert.equal(harness.service.getSnapshot().kind, 'error');
});

test('cancel with no active attempt never hides an existing confirmed pair', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  ordinary.values.set(PAIR_METADATA_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    status: 'confirmed',
    pairId: '33333333-3333-4333-8333-333333333333',
    partnerDeviceId: '22222222-2222-4222-8222-222222222222',
    partnerDeviceName: 'Partner Phone',
    pairedAt: '2026-08-18T00:00:00.000Z',
  }));
  secrets.values.set(PAIR_SECRET_STORAGE_KEY, 'ab'.repeat(32));
  const harness = makeService(ordinary, secrets);
  await harness.service.initialize();
  assert.equal(harness.service.getSnapshot().kind, 'paired');

  await harness.service.cancel();
  assert.equal(harness.service.getSnapshot().kind, 'paired');
  assert.equal((await harness.trust.loadConfirmed())?.partnerDeviceName, 'Partner Phone');
});

test('creator closes an extra inbound connection instead of adopting it', async () => {
  const harness = makeService();
  await harness.service.initialize();
  await harness.service.startCreator();

  harness.transport.emit({ type: 'connected', listenerId: 'listener-1', connectionId: 'first' });
  harness.transport.emit({ type: 'connected', listenerId: 'listener-1', connectionId: 'second' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.transport.closedConnections, ['second']);
  await harness.service.cancel();
});

test('clear pairing error revalidates incomplete trust before returning unpaired', async () => {
  const ordinary = new MemoryStore();
  const secrets = new FailingPendingDeleteSecrets();
  secrets.values.set(PAIR_PENDING_SECRET_KEY, 'ab'.repeat(32));
  const harness = makeService(ordinary, secrets);

  await harness.service.initialize();
  assert.equal(harness.service.getSnapshot().kind, 'error');

  await harness.service.resetError();
  assert.equal(harness.service.getSnapshot().kind, 'error');
  assert.equal(secrets.values.has(PAIR_PENDING_SECRET_KEY), true);

  secrets.failPendingDelete = false;
  await harness.service.resetError();
  assert.equal(harness.service.getSnapshot().kind, 'unpaired');
  assert.equal(secrets.values.has(PAIR_PENDING_SECRET_KEY), false);
});
