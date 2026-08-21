import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { IdentityRepository } from '../src/domain/identity/IdentityRepository';
import type { LocalDeviceIdentity } from '../src/domain/identity/LocalDeviceIdentity';
import type { DiagnosticsRepository } from '../src/domain/diagnostics/DiagnosticsRepository';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import type { SecretStore } from '../src/domain/security/SecretStore';
import { PairTrustRepository } from '../src/domain/pairing/PairTrustRepository';
import type { PairingCrypto } from '../src/domain/pairing/PairingCrypto';
import {
  PAIRING_AES_IV_BYTES,
  PAIRING_AES_TAG_BYTES,
  decodePairingSealedWire,
  encodePairingSealedWire,
} from '../src/domain/pairing/PairingCryptoWire';
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
  async getSecret(key: string) { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string) { this.values.set(key, value); }
  async deleteSecret(key: string) { this.values.delete(key); }
}

class NodePairingCrypto implements PairingCrypto {
  randomId() { return randomUUID(); }
  async generateKeyHex() { return randomBytes(32).toString('hex'); }

  async seal(keyHex: string, additionalData: string, plaintext: string) {
    const iv = randomBytes(PAIRING_AES_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    cipher.setAAD(Buffer.from(additionalData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return encodePairingSealedWire(new Uint8Array(Buffer.concat([iv, ciphertext, tag])));
  }

  async open(keyHex: string, additionalData: string, sealedWire: string) {
    const combined = Buffer.from(decodePairingSealedWire(sealedWire));
    const iv = combined.subarray(0, PAIRING_AES_IV_BYTES);
    const tag = combined.subarray(combined.length - PAIRING_AES_TAG_BYTES);
    const ciphertext = combined.subarray(PAIRING_AES_IV_BYTES, combined.length - PAIRING_AES_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    decipher.setAAD(Buffer.from(additionalData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

interface ConnectionPair {
  left: FakeTransport;
  leftId: string;
  right: FakeTransport;
  rightId: string;
}

class FakeTransportNetwork {
  private port = 45000;
  private connection = 1;
  private readonly endpoints = new Map<string, { transport: FakeTransport; listenerId: string }>();
  private readonly connections = new Map<string, ConnectionPair>();

  register(transport: FakeTransport, host: string, listenerId: string): PairingListenerEndpoint {
    const port = this.port++;
    this.endpoints.set(`${host}:${port}`, { transport, listenerId });
    return { host, port, listenerId };
  }

  unregister(host: string, port: number) {
    this.endpoints.delete(`${host}:${port}`);
  }

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
    queueMicrotask(() => target.emit({ type: 'message', connectionId: targetId, frame }));
  }

  close(_source: FakeTransport, id: string) {
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

  constructor(
    readonly network: FakeTransportNetwork,
    readonly host: string,
  ) {}

  async startListener() {
    this.endpoint = this.network.register(this, this.host, `l-${this.host}`);
    return this.endpoint;
  }

  async stopListener(_listenerId: string) {
    if (this.endpoint) this.network.unregister(this.endpoint.host, this.endpoint.port);
    this.endpoint = null;
  }

  async connect(host: string, port: number) { return this.network.connect(this, host, port); }
  async send(connectionId: string, frame: string) { this.network.send(this, connectionId, frame); }
  async close(connectionId: string) { this.network.close(this, connectionId); }
  subscribe(listener: (event: PairingTransportEvent) => void) { this.handlers.add(listener); return () => this.handlers.delete(listener); }
  emit(event: PairingTransportEvent) { this.handlers.forEach((handler) => handler(event)); }
}

function identity(deviceId: string, deviceName: string): LocalDeviceIdentity {
  return {
    schemaVersion: 1,
    deviceId,
    deviceName,
    createdAt: '2026-08-18T12:00:00.000Z',
    updatedAt: '2026-08-18T12:00:00.000Z',
  };
}

function identityRepository(value: LocalDeviceIdentity): IdentityRepository {
  return { bootstrap: async () => ({ identity: value, created: false }) } as unknown as IdentityRepository;
}

function diagnostics(): DiagnosticsRepository {
  return { append: async () => undefined } as unknown as DiagnosticsRepository;
}

function makeService(local: LocalDeviceIdentity, transport: FakeTransport) {
  const trust = new PairTrustRepository(new MemoryStore(), new MemorySecrets());
  const service = new PairingService(
    identityRepository(local),
    trust,
    diagnostics(),
    transport,
    new NodePairingCrypto(),
    () => new Date('2026-08-18T12:30:00.000Z'),
  );
  return { service, trust };
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('full two-phone pairing converges with independent real AES-256-GCM implementations', async () => {
  const creatorIdentity = identity('11111111-1111-4111-8111-111111111111', 'Creator Phone');
  const scannerIdentity = identity('22222222-2222-4222-8222-222222222222', 'Scanner Phone');
  const network = new FakeTransportNetwork();
  const creator = makeService(creatorIdentity, new FakeTransport(network, '192.168.1.10'));
  const scanner = makeService(scannerIdentity, new FakeTransport(network, '192.168.1.11'));

  await Promise.all([creator.service.initialize(), scanner.service.initialize()]);
  await creator.service.startCreator();
  const creatorQr = creator.service.getSnapshot();
  assert.equal(creatorQr.kind, 'creator_qr');
  if (creatorQr.kind !== 'creator_qr') throw new Error('creator QR missing');

  await scanner.service.startScanner(creatorQr.qrPayload);
  await waitFor(() => scanner.service.getSnapshot().kind === 'confirm_partner', 'scanner did not authenticate creator');
  await waitFor(() => creator.service.getSnapshot().kind === 'waiting_partner', 'creator did not authenticate scanner');

  await scanner.service.confirmPartner();
  await waitFor(() => creator.service.getSnapshot().kind === 'confirm_partner', 'creator confirmation did not unlock');
  await creator.service.confirmPartner();
  await waitFor(
    () => creator.service.getSnapshot().kind === 'paired' && scanner.service.getSnapshot().kind === 'paired',
    'real-AES pair did not converge',
  );

  const [creatorTrust, scannerTrust] = await Promise.all([
    creator.trust.loadConfirmed(),
    scanner.trust.loadConfirmed(),
  ]);
  assert.equal(creatorTrust?.partnerDeviceId, scannerIdentity.deviceId);
  assert.equal(scannerTrust?.partnerDeviceId, creatorIdentity.deviceId);
  assert.equal(creatorTrust?.pairId, scannerTrust?.pairId);
});
