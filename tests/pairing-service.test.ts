import test from 'node:test';
import assert from 'node:assert/strict';
import type { IdentityRepository } from '../src/domain/identity/IdentityRepository';
import type { LocalDeviceIdentity } from '../src/domain/identity/LocalDeviceIdentity';
import type { DiagnosticsRepository } from '../src/domain/diagnostics/DiagnosticsRepository';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import type { SecretStore } from '../src/domain/security/SecretStore';
import { PairTrustRepository, PAIR_METADATA_STORAGE_KEY } from '../src/domain/pairing/PairTrustRepository';
import type { PairingCrypto } from '../src/domain/pairing/PairingCrypto';
import { decodePairingSealedWire, encodePairingSealedWire } from '../src/domain/pairing/PairingCryptoWire';
import { buildPairingQrPayload } from '../src/domain/pairing/PairingQr';
import { PairingService } from '../src/application/PairingService';
import type { PairingTransport } from '../src/platform/pairing/ExpoPairingTransport';
import type { PairingListenerEndpoint, PairingTransportEvent } from '../modules/partner-pairing-transport';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  failWrites = false;
  async getSecret(key: string) { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string) {
    if (this.failWrites) throw new Error('injected secure-store failure');
    this.values.set(key, value);
  }
  async deleteSecret(key: string) { this.values.delete(key); }
}

class FakeCrypto implements PairingCrypto {
  private nextId = 1;
  randomId(): string {
    const n = this.nextId++;
    return `${n.toString(16).padStart(8, '0')}-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;
  }
  async generateKeyHex() { return this.nextId++ % 2 ? 'ab'.repeat(32) : 'cd'.repeat(32); }
  async seal(keyHex: string, additionalData: string, plaintext: string) {
    const bytes = Buffer.from(JSON.stringify({ keyHex, additionalData, plaintext }), 'utf8');
    return encodePairingSealedWire(new Uint8Array(bytes));
  }
  async open(keyHex: string, additionalData: string, sealedWire: string) {
    const value = JSON.parse(Buffer.from(decodePairingSealedWire(sealedWire)).toString('utf8')) as Record<string, unknown>;
    if (value.keyHex !== keyHex || value.additionalData !== additionalData || typeof value.plaintext !== 'string') {
      throw new Error('authentication failed');
    }
    return value.plaintext;
  }
}

interface ConnectionPair { left: FakeTransport; leftId: string; right: FakeTransport; rightId: string }

class FakeTransportNetwork {
  private port = 41000;
  private connection = 1;
  private readonly endpoints = new Map<string, { transport: FakeTransport; listenerId: string }>();
  private readonly connections = new Map<string, ConnectionPair>();
  tamperNext = false;

  register(transport: FakeTransport, host: string, listenerId: string): PairingListenerEndpoint {
    const port = this.port++;
    this.endpoints.set(`${host}:${port}`, { transport, listenerId });
    return { host, port, listenerId };
  }

  unregister(host: string, port: number) { this.endpoints.delete(`${host}:${port}`); }

  connect(source: FakeTransport, host: string, port: number): string {
    const target = this.endpoints.get(`${host}:${port}`);
    if (!target) throw new Error('connect failure');
    const sourceId = `c${this.connection++}`;
    const targetId = `c${this.connection++}`;
    const pair: ConnectionPair = { left: source, leftId: sourceId, right: target.transport, rightId: targetId };
    this.connections.set(sourceId, pair);
    this.connections.set(targetId, pair);
    queueMicrotask(() => {
      source.emit({ type: 'connected', connectionId: sourceId });
      target.transport.emit({ type: 'connected', connectionId: targetId, listenerId: target.listenerId });
    });
    return sourceId;
  }

  send(source: FakeTransport, id: string, frame: string) {
    const pair = this.connections.get(id);
    if (!pair) throw new Error('closed');
    const sourceIsLeft = pair.left === source && pair.leftId === id;
    const target = sourceIsLeft ? pair.right : pair.left;
    const targetId = sourceIsLeft ? pair.rightId : pair.leftId;
    let delivered = frame;
    if (this.tamperNext) {
      this.tamperNext = false;
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      parsed.sealed = `${String(parsed.sealed).slice(0, -2)}xx`;
      delivered = JSON.stringify(parsed);
    }
    queueMicrotask(() => target.emit({ type: 'message', connectionId: targetId, frame: delivered }));
  }

  close(source: FakeTransport, id: string) {
    const pair = this.connections.get(id);
    if (!pair) return;
    this.connections.delete(pair.leftId);
    this.connections.delete(pair.rightId);
    queueMicrotask(() => {
      pair.left.emit({ type: 'closed', connectionId: pair.leftId });
      pair.right.emit({ type: 'closed', connectionId: pair.rightId });
    });
  }
}

class FakeTransport implements PairingTransport {
  private readonly handlers = new Set<(event: PairingTransportEvent) => void>();
  private endpoint: PairingListenerEndpoint | null = null;
  constructor(readonly network: FakeTransportNetwork, readonly host: string) {}
  async startListener() { this.endpoint = this.network.register(this, this.host, `l-${this.host}`); return this.endpoint; }
  async stopListener(_listenerId: string) { if (this.endpoint) this.network.unregister(this.endpoint.host, this.endpoint.port); this.endpoint = null; }
  async connect(host: string, port: number) { return this.network.connect(this, host, port); }
  async send(connectionId: string, frame: string) { this.network.send(this, connectionId, frame); }
  async close(connectionId: string) { this.network.close(this, connectionId); }
  subscribe(listener: (event: PairingTransportEvent) => void) { this.handlers.add(listener); return () => this.handlers.delete(listener); }
  emit(event: PairingTransportEvent) { this.handlers.forEach((handler) => handler(event)); }
}

function identity(deviceId: string, deviceName: string): LocalDeviceIdentity {
  return { schemaVersion: 1, deviceId, deviceName, createdAt: '2026-08-17T20:00:00.000Z', updatedAt: '2026-08-17T20:00:00.000Z' };
}

function identityRepo(value: LocalDeviceIdentity): IdentityRepository {
  return { bootstrap: async () => ({ identity: value, created: false }) } as unknown as IdentityRepository;
}

function diagnostics(): DiagnosticsRepository {
  return { append: async () => undefined } as unknown as DiagnosticsRepository;
}

function makeService(
  local: LocalDeviceIdentity,
  transport: FakeTransport,
  ordinary = new MemoryStore(),
  secrets = new MemorySecrets(),
  crypto = new FakeCrypto(),
) {
  const trust = new PairTrustRepository(ordinary, secrets);
  const service = new PairingService(identityRepo(local), trust, diagnostics(), transport, crypto, () => new Date('2026-08-17T22:00:00.000Z'));
  return { service, trust, ordinary, secrets, crypto };
}

async function waitFor(predicate: () => boolean, message = 'state did not arrive') {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const A = identity('11111111-1111-4111-8111-111111111111', 'Creator Phone');
const B = identity('22222222-2222-4222-8222-222222222222', 'Scanner Phone');

test('two headless phones pair only after scanner then creator confirmation and convergence', async () => {
  const network = new FakeTransportNetwork();
  const crypto = new FakeCrypto();
  const a = makeService(A, new FakeTransport(network, '192.168.1.10'), new MemoryStore(), new MemorySecrets(), crypto);
  const b = makeService(B, new FakeTransport(network, '192.168.1.11'), new MemoryStore(), new MemorySecrets(), crypto);
  await Promise.all([a.service.initialize(), b.service.initialize()]);

  await a.service.startCreator();
  const creatorState = a.service.getSnapshot();
  assert.equal(creatorState.kind, 'creator_qr');
  if (creatorState.kind !== 'creator_qr') throw new Error('missing qr');
  await b.service.startScanner(creatorState.qrPayload);

  await waitFor(() => b.service.getSnapshot().kind === 'confirm_partner');
  await waitFor(() => a.service.getSnapshot().kind === 'waiting_partner');
  assert.equal(a.service.getSnapshot().kind, 'waiting_partner', 'creator must not be confirmable before scanner confirms');

  await b.service.confirmPartner();
  await waitFor(() => a.service.getSnapshot().kind === 'confirm_partner');
  await a.service.confirmPartner();
  await waitFor(() => a.service.getSnapshot().kind === 'paired' && b.service.getSnapshot().kind === 'paired', 'pair did not converge');

  const [pairA, pairB] = await Promise.all([a.trust.loadConfirmed(), b.trust.loadConfirmed()]);
  assert.equal(pairA?.partnerDeviceId, B.deviceId);
  assert.equal(pairB?.partnerDeviceId, A.deviceId);
  assert.equal(pairA?.pairId, pairB?.pairId);
  assert.equal(a.ordinary.values.get(PAIR_METADATA_STORAGE_KEY)?.includes('ab'.repeat(32)), false);
  assert.equal(b.ordinary.values.get(PAIR_METADATA_STORAGE_KEY)?.includes('ab'.repeat(32)), false);
});

test('connect failure leaves no confirmed trust', async () => {
  const network = new FakeTransportNetwork();
  const b = makeService(B, new FakeTransport(network, '192.168.1.11'));
  await b.service.initialize();
  const raw = buildPairingQrPayload({
    pairAttemptId: '33333333-3333-4333-8333-333333333333',
    creatorDeviceId: A.deviceId,
    creatorDeviceName: A.deviceName!,
    host: '192.168.1.99',
    port: 49999,
    bootstrapKeyHex: 'ab'.repeat(32),
    createdAt: '2026-08-17T22:00:00.000Z',
    expiresAt: '2026-08-17T22:02:00.000Z',
  });
  await assert.rejects(b.service.startScanner(raw), /connect failure/);
  assert.equal(await b.trust.loadConfirmed(), null);
});

test('authenticated creator identity mismatch is rejected and does not persist trust', async () => {
  const network = new FakeTransportNetwork();
  const crypto = new FakeCrypto();
  const a = makeService(A, new FakeTransport(network, '192.168.1.10'), new MemoryStore(), new MemorySecrets(), crypto);
  const b = makeService(B, new FakeTransport(network, '192.168.1.11'), new MemoryStore(), new MemorySecrets(), crypto);
  await Promise.all([a.service.initialize(), b.service.initialize()]);
  await a.service.startCreator();
  const state = a.service.getSnapshot();
  if (state.kind !== 'creator_qr') throw new Error('missing qr');
  const object = JSON.parse(state.qrPayload.slice(4)) as Record<string, unknown>;
  object.creatorDeviceName = 'Imposter Name';
  await b.service.startScanner(`PS1:${JSON.stringify(object)}`);
  await waitFor(() => b.service.getSnapshot().kind === 'error');
  assert.equal(await b.trust.loadConfirmed(), null);
});

test('tampered authenticated frame fails closed', async () => {
  const network = new FakeTransportNetwork();
  const crypto = new FakeCrypto();
  const a = makeService(A, new FakeTransport(network, '192.168.1.10'), new MemoryStore(), new MemorySecrets(), crypto);
  const b = makeService(B, new FakeTransport(network, '192.168.1.11'), new MemoryStore(), new MemorySecrets(), crypto);
  await Promise.all([a.service.initialize(), b.service.initialize()]);
  await a.service.startCreator();
  const state = a.service.getSnapshot();
  if (state.kind !== 'creator_qr') throw new Error('missing qr');
  network.tamperNext = true;
  await b.service.startScanner(state.qrPayload);
  await waitFor(() => a.service.getSnapshot().kind === 'error' || b.service.getSnapshot().kind === 'error');
  assert.equal(await a.trust.loadConfirmed(), null);
  assert.equal(await b.trust.loadConfirmed(), null);
});

test('cancel after authenticated identity clears provisional state on both phones', async () => {
  const network = new FakeTransportNetwork();
  const crypto = new FakeCrypto();
  const a = makeService(A, new FakeTransport(network, '192.168.1.10'), new MemoryStore(), new MemorySecrets(), crypto);
  const b = makeService(B, new FakeTransport(network, '192.168.1.11'), new MemoryStore(), new MemorySecrets(), crypto);
  await Promise.all([a.service.initialize(), b.service.initialize()]);
  await a.service.startCreator();
  const state = a.service.getSnapshot();
  if (state.kind !== 'creator_qr') throw new Error('missing qr');
  await b.service.startScanner(state.qrPayload);
  await waitFor(() => b.service.getSnapshot().kind === 'confirm_partner');
  await b.service.cancel();
  await waitFor(() => a.service.getSnapshot().kind === 'unpaired');
  assert.equal(b.service.getSnapshot().kind, 'unpaired');
  assert.equal(await a.trust.loadConfirmed(), null);
  assert.equal(await b.trust.loadConfirmed(), null);
});

test('secure-store commit failure aborts the finalization instead of exposing paired Home', async () => {
  const network = new FakeTransportNetwork();
  const crypto = new FakeCrypto();
  const a = makeService(A, new FakeTransport(network, '192.168.1.10'), new MemoryStore(), new MemorySecrets(), crypto);
  const scannerSecrets = new MemorySecrets();
  const b = makeService(B, new FakeTransport(network, '192.168.1.11'), new MemoryStore(), scannerSecrets, crypto);
  await Promise.all([a.service.initialize(), b.service.initialize()]);
  await a.service.startCreator();
  const state = a.service.getSnapshot();
  if (state.kind !== 'creator_qr') throw new Error('missing qr');
  await b.service.startScanner(state.qrPayload);
  await waitFor(() => b.service.getSnapshot().kind === 'confirm_partner');
  await b.service.confirmPartner();
  await waitFor(() => a.service.getSnapshot().kind === 'confirm_partner');
  scannerSecrets.failWrites = true;
  await a.service.confirmPartner();
  await waitFor(() => a.service.getSnapshot().kind === 'error' || b.service.getSnapshot().kind === 'error');
  assert.notEqual(a.service.getSnapshot().kind, 'paired');
  assert.notEqual(b.service.getSnapshot().kind, 'paired');
});
