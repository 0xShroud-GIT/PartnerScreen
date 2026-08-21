import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControlSession, type ControlSessionEvent } from '../src/control/ControlSession';
import { AuthenticatedSignalingCipher } from '../src/security/AuthenticatedSignalingCipher';
import type { AesGcmPrimitive, HmacSha256Primitive } from '../src/security/SignalingCipher';
import type { ControlListenerEndpoint, ControlTransport, ControlTransportEvent } from '../src/platform/control/ControlTransport';

class NodeHmac implements HmacSha256Primitive { async macHex(keyHex: string, message: string): Promise<string> { return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex'); } }
class NodeAes implements AesGcmPrimitive {
  async assertRuntimeCompatible(): Promise<void> {} randomId(): string { return randomUUID(); } async randomNonceHex(bytes = 16): Promise<string> { return randomBytes(bytes).toString('hex'); }
  async seal(keyHex: string, aad: string, plaintext: string): Promise<string> { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv); c.setAAD(Buffer.from(aad)); const body = Buffer.concat([c.update(plaintext), c.final()]); return `c1:${Buffer.concat([iv, body, c.getAuthTag()]).toString('hex')}`; }
  async open(keyHex: string, aad: string, wire: string): Promise<string> { const all = Buffer.from(wire.slice(3), 'hex'); const iv = all.subarray(0, 12), tag = all.subarray(all.length - 16), body = all.subarray(12, all.length - 16); const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv); d.setAAD(Buffer.from(aad)); d.setAuthTag(tag); return Buffer.concat([d.update(body), d.final()]).toString(); }
}

type Link = { peer: FakeTransport; peerConnectionId: string };
class FakeNetwork {
  private nextPort = 41000; private readonly listeners = new Map<string, FakeTransport>();
  allocate(transport: FakeTransport): ControlListenerEndpoint { const port = this.nextPort++; const endpoint = { listenerId: randomUUID(), host: transport.host, port }; this.listeners.set(`${endpoint.host}:${port}`, transport); return endpoint; }
  release(endpoint: ControlListenerEndpoint): void { this.listeners.delete(`${endpoint.host}:${endpoint.port}`); }
  connect(source: FakeTransport, host: string, port: number): string {
    const peer = this.listeners.get(`${host}:${port}`); if (!peer) throw new Error('unreachable');
    const localId = randomUUID(), remoteId = randomUUID(); source.links.set(localId, { peer, peerConnectionId: remoteId }); peer.links.set(remoteId, { peer: source, peerConnectionId: localId });
    queueMicrotask(() => {
      source.emit({ type: 'connected', connectionId: localId, direction: 'outbound' });
      const listenerId = peer.endpoint?.listenerId;
      peer.emit(listenerId
        ? { type: 'connected', connectionId: remoteId, direction: 'inbound', listenerId }
        : { type: 'connected', connectionId: remoteId, direction: 'inbound' });
    });
    return localId;
  }
}
class FakeTransport implements ControlTransport {
  readonly links = new Map<string, Link>(); readonly callbacks = new Set<(event: ControlTransportEvent) => void>(); endpoint: ControlListenerEndpoint | null = null;
  host: string;
  startCount = 0;
  stopCount = 0;
  presenceStarts = 0;
  presenceStops = 0;
  constructor(host: string, private readonly network: FakeNetwork) { this.host = host; }
  async startTrustedPresence(): Promise<void> { this.presenceStarts += 1; }
  async stopTrustedPresence(): Promise<void> { this.presenceStops += 1; }
  async startListener(): Promise<ControlListenerEndpoint> { this.startCount += 1; const endpoint = this.network.allocate(this); this.endpoint = endpoint; return endpoint; }
  async stopListener(listenerId: string): Promise<void> { this.stopCount += 1; if (this.endpoint?.listenerId === listenerId) { this.network.release(this.endpoint); this.endpoint = null; } }
  async connect(host: string, port: number): Promise<string> { return this.network.connect(this, host, port); }
  async send(connectionId: string, frame: string): Promise<void> { const link = this.links.get(connectionId); if (!link) throw new Error('closed'); queueMicrotask(() => link.peer.emit({ type: 'message', connectionId: link.peerConnectionId, frame })); }
  async close(connectionId: string): Promise<void> { const link = this.links.get(connectionId); if (!link) return; this.links.delete(connectionId); link.peer.links.delete(link.peerConnectionId); queueMicrotask(() => { this.emit({ type: 'closed', connectionId }); link.peer.emit({ type: 'closed', connectionId: link.peerConnectionId }); }); }
  subscribe(listener: (event: ControlTransportEvent) => void): () => void { this.callbacks.add(listener); return () => this.callbacks.delete(listener); }
  emit(event: ControlTransportEvent): void { for (const callback of this.callbacks) callback(event); }
}
function cipher(): AuthenticatedSignalingCipher { return new AuthenticatedSignalingCipher(new NodeAes(), new NodeHmac()); }
async function settle(): Promise<void> { for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }
const deviceA = '11111111-1111-4111-8111-111111111111', deviceB = '22222222-2222-4222-8222-222222222222', pairId = '33333333-3333-4333-8333-333333333333', secret = 'ab'.repeat(32);

test('pair activation starts trusted presence; JS recreation can reattach the same native listener', async (t) => {
  // P0-D trusted presence not yet implemented in P0-A phase — skip until P0-D lands.
  t.skip('P0-D presence will be validated after P0-D implementation');
});

test('two control sessions mutually authenticate before routing sealed messages', async () => {
  const network = new FakeNetwork(), transportA = new FakeTransport('192.168.1.10', network), transportB = new FakeTransport('192.168.1.11', network);
  const a = new ControlSession(transportA, cipher()), b = new ControlSession(transportB, cipher());
  await a.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret }); await b.activate({ pairId, localDeviceId: deviceB, partnerDeviceId: deviceA, pairSecretHex: secret });
  const bEvents: ControlSessionEvent[] = [], aEvents: ControlSessionEvent[] = []; b.subscribe((event) => bEvents.push(event)); a.subscribe((event) => aEvents.push(event));
  const sessionId = await a.connect(await b.ensureListening()); await a.send('REQUEST_SCREEN', { expiresAt: new Date(Date.now() + 30_000).toISOString() }); await settle();
  const request = bEvents.find((event) => event.type === 'message'); assert.equal(request?.type, 'message'); if (request?.type === 'message') { assert.equal(request.message.type, 'REQUEST_SCREEN'); assert.equal(request.message.sessionId, sessionId); }
  await b.send('ACCEPT_SCREEN', {}); await settle(); assert.ok(aEvents.find((event) => event.type === 'message' && event.message.type === 'ACCEPT_SCREEN'));
  await a.close(); await settle(); assert.equal(transportA.links.size, 0); assert.equal(transportB.links.size, 0);
});

test('wrong pair secret cannot authenticate an inbound control channel', async () => {
  const network = new FakeNetwork(), a = new ControlSession(new FakeTransport('192.168.2.10', network), cipher()), b = new ControlSession(new FakeTransport('192.168.2.11', network), cipher());
  await a.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret }); await b.activate({ pairId, localDeviceId: deviceB, partnerDeviceId: deviceA, pairSecretHex: 'cd'.repeat(32) });
  const endpoint = await b.ensureListening(); await assert.rejects(() => a.connect(endpoint), /closed|authentication|Control session/i);
});

test('an extra inbound connection rejected while a session is authenticated is not fatal to the current ControlSession', async () => {
  const network = new FakeNetwork(), transportA = new FakeTransport('192.168.3.10', network), transportB = new FakeTransport('192.168.3.11', network);
  const a = new ControlSession(transportA, cipher()), b = new ControlSession(transportB, cipher());
  await a.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret });
  await b.activate({ pairId, localDeviceId: deviceB, partnerDeviceId: deviceA, pairSecretHex: secret });
  const bEvents: ControlSessionEvent[] = [], aEvents: ControlSessionEvent[] = [];
  b.subscribe((event) => bEvents.push(event)); a.subscribe((event) => aEvents.push(event));
  const sessionId = await a.connect(await b.ensureListening());
  await settle();
  // An unrelated client attempts an inbound connection while B is already authenticated with A.
  transportB.emit({ type: 'connected', connectionId: '99999999-9999-4999-8999-999999999999', direction: 'inbound' });
  await settle();
  assert.equal(bEvents.some((event) => event.type === 'error'), false); // rejected extra inbound is NOT a fatal session error
  // The current authenticated session remains usable end to end.
  await a.send('REQUEST_SCREEN', { expiresAt: new Date(Date.now() + 30_000).toISOString() }); await settle();
  assert.ok(bEvents.some((event) => event.type === 'message' && event.message.type === 'REQUEST_SCREEN'));
  await b.send('ACCEPT_SCREEN', {}); await settle();
  assert.ok(aEvents.some((event) => event.type === 'message' && event.message.type === 'ACCEPT_SCREEN'));
  assert.equal(sessionId, aEvents.find((event) => event.type === 'authenticated') ? aEvents.find((event) => event.type === 'authenticated')?.type === 'authenticated' ? (aEvents.find((event) => event.type === 'authenticated') as { sessionId: string }).sessionId : '' : '');
  await a.close(); await settle();
});

test('listener failure invalidates only the exact owned listener; a fresh ensureListening creates a replacement', async () => {
  const network = new FakeNetwork(), transport = new FakeTransport('192.168.4.10', network);
  const session = new ControlSession(transport, cipher());
  await session.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret });
  const first = await session.ensureListening();
  const firstListenerId = transport.endpoint?.listenerId;
  assert.ok(firstListenerId);
  transport.emit({ type: 'error', code: 'listener_failed', listenerId: firstListenerId! }); await settle();
  const second = await session.ensureListening();
  assert.notEqual(transport.endpoint?.listenerId, firstListenerId); // fresh replacement listener
  assert.equal(transport.startCount, 2);
  // Invalidation does NOT call stopListener: the native listener already failed/removed itself.
  assert.equal(transport.stopCount, 0);
  session.dispose();
});

test('a stale listener-failed event from an older listener cannot invalidate its replacement', async () => {
  const network = new FakeNetwork(), transport = new FakeTransport('192.168.4.11', network);
  const session = new ControlSession(transport, cipher());
  await session.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret });
  const first = await session.ensureListening();
  const firstListenerId = transport.endpoint?.listenerId;
  assert.ok(firstListenerId);
  transport.emit({ type: 'error', code: 'listener_failed', listenerId: firstListenerId! }); await settle();
  const second = await session.ensureListening();
  const secondListenerId = transport.endpoint?.listenerId;
  assert.notEqual(secondListenerId, firstListenerId);
  const startsBeforeStale = transport.startCount;
  transport.emit({ type: 'error', code: 'listener_failed', listenerId: firstListenerId! }); await settle(); // stale A failure
  const after = await session.ensureListening();
  assert.equal(transport.endpoint?.listenerId, secondListenerId); // B remains valid
  assert.equal(transport.startCount, startsBeforeStale); // no extra listener created
  session.dispose();
});

test('an authenticated active ControlSession survives loss/replacement of the listening socket', async () => {
  const network = new FakeNetwork(), transportA = new FakeTransport('192.168.5.10', network), transportB = new FakeTransport('192.168.5.11', network);
  const a = new ControlSession(transportA, cipher()), b = new ControlSession(transportB, cipher());
  await a.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret });
  await b.activate({ pairId, localDeviceId: deviceB, partnerDeviceId: deviceA, pairSecretHex: secret });
  const bEvents: ControlSessionEvent[] = [], aEvents: ControlSessionEvent[] = [];
  b.subscribe((event) => bEvents.push(event)); a.subscribe((event) => aEvents.push(event));
  const sessionId = await a.connect(await b.ensureListening()); await settle();
  // B's local listening socket fails while the authenticated connection is alive.
  const bListenerId = transportB.endpoint?.listenerId;
  if (bListenerId) transportB.emit({ type: 'error', code: 'listener_failed', listenerId: bListenerId });
  await settle();
  assert.equal(bEvents.some((event) => event.type === 'error' || event.type === 'closed'), false); // not fatal
  assert.equal(transportB.links.size, 1); // active connection intact
  await a.send('REQUEST_SCREEN', { expiresAt: new Date(Date.now() + 30_000).toISOString() }); await settle();
  assert.ok(bEvents.some((event) => event.type === 'message' && event.message.type === 'REQUEST_SCREEN'));
  const replacement = await b.ensureListening();
  assert.notEqual(transportB.endpoint?.listenerId, bListenerId); // replacement listener established
  await a.close(); await settle();
});

test('a listener UUID stuffed into connectionId cannot invalidate the owned listener or an authenticated session', async () => {
  const network = new FakeNetwork(), transportA = new FakeTransport('192.168.7.10', network), transportB = new FakeTransport('192.168.7.11', network);
  const a = new ControlSession(transportA, cipher()), b = new ControlSession(transportB, cipher());
  await a.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret });
  await b.activate({ pairId, localDeviceId: deviceB, partnerDeviceId: deviceA, pairSecretHex: secret });
  const bEvents: ControlSessionEvent[] = [];
  b.subscribe((event) => bEvents.push(event));
  await a.connect(await b.ensureListening()); await settle();
  const owned = transportB.endpoint?.listenerId;
  assert.ok(owned);
  transportB.emit({ type: 'error', code: 'listener_failed', connectionId: owned }); await settle();
  assert.equal(transportB.endpoint?.listenerId, owned); // connectionId is not listener ownership
  assert.equal(bEvents.some((event) => event.type === 'error' || event.type === 'closed'), false);
  assert.equal(transportB.links.size, 1);
  await b.ensureListening();
  assert.equal(transportB.endpoint?.listenerId, owned);
  await a.close(); await settle();
});

test('Wi-Fi host change stops the old listener and binds a fresh one to the new host without re-pairing', async () => {
  const network = new FakeNetwork(), transport = new FakeTransport('192.168.6.10', network);
  const session = new ControlSession(transport, cipher());
  await session.activate({ pairId, localDeviceId: deviceA, partnerDeviceId: deviceB, pairSecretHex: secret });
  const oldEndpoint = await session.ensureListening('192.168.6.10');
  const oldListenerId = transport.endpoint?.listenerId;
  assert.equal(oldEndpoint.host, '192.168.6.10');
  assert.equal(transport.startCount, 1); // cached listener reused
  // Wi-Fi host changes to a new private IPv4.
  transport.host = '192.168.6.20';
  const newEndpoint = await session.ensureListening('192.168.6.20');
  assert.equal(newEndpoint.host, '192.168.6.20'); // bound to new host
  assert.notEqual(transport.endpoint?.listenerId, oldListenerId); // old listener not reused
  assert.equal(transport.stopCount, 1); // only the old listener stopped
  // The durable trust context is unchanged (no re-pair involved).
  await session.ensureListening('192.168.6.20');
  assert.equal(transport.startCount, 2); // cached again after rebind
  session.dispose();
});
