import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AvailabilityService, type AvailabilityDiagnostics, type PairSecretSource, type ControlListenerSource } from '../src/availability/AvailabilityService';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import { HmacDiscoveryAuthenticator, type HmacSha256 } from '../src/domain/discovery/TrustedDiscoveryAuthenticator';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { DiscoveryAdvertisementPreparation, DiscoveryRegistration, ChirpDiscovery, ChirpDiscoveryEvent } from '../src/platform/discovery/ChirpDiscovery';

class NodeHmacSha256 implements HmacSha256 {
  async macHex(keyHex: string, message: string): Promise<string> { return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex'); }
}
class FakeDiagnostics implements AvailabilityDiagnostics { readonly events: DiagnosticEventKind[] = []; async append(kind: DiagnosticEventKind): Promise<void> { this.events.push(kind); } }
class FakeSecrets implements PairSecretSource { constructor(readonly secret: string) {} async loadPairSecret(): Promise<string> { return this.secret; } }
class FakeControlListener implements ControlListenerSource {
  endpoint = { host: '192.168.18.10', port: 44001 };
  ensureCalls = 0;
  private readonly changeListeners = new Set<() => void>();
  async ensureListening(expectedHost?: string): Promise<{ host: string; port: number }> { this.ensureCalls += 1; return this.endpoint; }
  subscribeListenerChanges(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  emitChange(): void { for (const listener of this.changeListeners) listener(); }
}
class FakeDiscovery implements ChirpDiscovery {
  readonly listeners = new Set<(event: ChirpDiscoveryEvent) => void>();
  readonly preparation: DiscoveryAdvertisementPreparation = { advertisementId: 'advertisement-local', host: '192.168.18.10', port: 41001, nonce: '10'.repeat(16) };
  readonly registration: DiscoveryRegistration = { serviceName: 'Chirp-local' };
  startArgs: { advertisementId: string; peerHint: string; proof: string } | null = null;
  probeCalls: Array<{ host: string; port: number }> = [];
  stopCount = 0;
  failStart = false;
  failProbe = false;
  deferProbe = false;
  private readonly deferredProbes: Array<{ host: string; port: number; resolve: () => void; reject: (error: Error) => void }> = [];
  async prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation> { return this.preparation; }
  async start(advertisementId: string, peerHint: string, proof: string): Promise<DiscoveryRegistration> {
    if (this.failStart) throw new Error('NSD unavailable: raw native detail');
    this.startArgs = { advertisementId, peerHint, proof }; return this.registration;
  }
  async probe(host: string, port: number): Promise<void> {
    this.probeCalls.push({ host, port });
    if (this.failProbe) throw new Error('unreachable');
    if (this.deferProbe) {
      await new Promise<void>((resolve, reject) => { this.deferredProbes.push({ host, port, resolve, reject }); });
    }
  }
  resolveDeferredProbes(predicate?: (call: { host: string; port: number }) => boolean): void {
    const remaining: typeof this.deferredProbes = [];
    for (const pending of this.deferredProbes.splice(0)) {
      if (!predicate || predicate(pending)) pending.resolve();
      else remaining.push(pending);
    }
    this.deferredProbes.push(...remaining);
  }
  rejectDeferredProbes(): void {
    for (const pending of this.deferredProbes.splice(0)) pending.reject(new Error('unreachable'));
  }
  async stop(): Promise<void> { this.stopCount += 1; }
  subscribe(listener: (event: ChirpDiscoveryEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: ChirpDiscoveryEvent): void { for (const listener of this.listeners) listener(event); }
}

const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '11111111-1111-4111-8111-111111111111', partnerDeviceId: '22222222-2222-4222-8222-222222222222', partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };
const secret = 'ab'.repeat(32);
async function settle(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); }
function makeHarness() {
  const discovery = new FakeDiscovery(); const diagnostics = new FakeDiagnostics(); const authenticator = new HmacDiscoveryAuthenticator(new NodeHmacSha256()); const control = new FakeControlListener();
  const service = new AvailabilityService(new FakeSecrets(secret), diagnostics, discovery, authenticator, control);
  return { discovery, diagnostics, authenticator, control, service };
}
async function trustedRemote(authenticator: HmacDiscoveryAuthenticator, overrides?: Partial<{ nonce: string; host: string; port: number; controlPort: number; serviceName: string }>) {
  const remote = {
    nonce: overrides?.nonce ?? '20'.repeat(16),
    host: overrides?.host ?? '192.168.18.11',
    port: overrides?.port ?? 42002,
    controlPort: overrides?.controlPort ?? 45002,
  };
  return {
    serviceName: overrides?.serviceName ?? 'Chirp-remote',
    host: remote.host,
    port: remote.port,
    peerHint: await authenticator.derivePeerHint(secret, remote.nonce),
    nonce: remote.nonce,
    proof: await authenticator.createProof(secret, remote),
    controlPort: remote.controlPort,
  };
}

test('availability binds the dynamic control port into authenticated proof and exposes it only after probe', async () => {
  const { discovery, diagnostics, authenticator, control, service } = makeHarness();
  await service.activate(pair);
  assert.deepEqual(service.getSnapshot(), { kind: 'offline', pair, localAdvertised: true });
  assert.ok(discovery.startArgs);
  assert.equal(authenticator.extractControlPort(discovery.startArgs!.proof), control.endpoint.port);
  discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) });
  await settle();
  const state = service.getSnapshot();
  assert.equal(state.kind, 'available');
  if (state.kind === 'available') assert.deepEqual(state.endpoint, { host: '192.168.18.11', port: 45002 });
  assert.deepEqual(discovery.probeCalls, [{ host: '192.168.18.11', port: 45002 }]);
  assert.ok(diagnostics.events.includes('availability_partner_found'));
});

test('PairedAvailable requires the exact authenticated control endpoint, never the NSD probe port', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair);
  const remote = await trustedRemote(authenticator);
  discovery.emit({ type: 'service_resolved', service: remote });
  await settle();
  const state = service.getSnapshot();
  assert.equal(state.kind, 'available');
  if (state.kind === 'available') {
    assert.notEqual(state.endpoint.port, remote.port);
    assert.equal(state.endpoint.port, remote.controlPort);
    assert.equal(state.endpoint.host, remote.host);
  }
  assert.equal(discovery.probeCalls.some((call) => call.port === remote.port), false);
  assert.deepEqual(discovery.probeCalls, [{ host: remote.host, port: remote.controlPort }]);
});

test('tampered control port proof, wrong hint, invalid proof, and local advertisement stay offline', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair);
  const remote = await trustedRemote(authenticator);
  discovery.emit({ type: 'service_resolved', service: { ...remote, peerHint: await authenticator.derivePeerHint(secret, '33'.repeat(16)) } });
  discovery.emit({ type: 'service_resolved', service: { ...remote, proof: `ffff${remote.proof.slice(4)}` } });
  discovery.emit({ type: 'service_resolved', service: { ...remote, proof: '00'.repeat(32) } });
  discovery.emit({ type: 'service_resolved', service: { ...remote, serviceName: discovery.registration.serviceName, host: discovery.preparation.host, port: discovery.preparation.port, nonce: discovery.preparation.nonce } });
  await settle();
  assert.equal(service.getSnapshot().kind, 'offline');
  assert.equal(discovery.probeCalls.length, 0);
});

test('only loss of the matched trusted service changes available to offline', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair); discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) }); await settle();
  assert.equal(service.getSnapshot().kind, 'available');
  discovery.emit({ type: 'service_lost', serviceName: 'unrelated-service' }); await settle(); assert.equal(service.getSnapshot().kind, 'available');
  discovery.emit({ type: 'service_lost', serviceName: 'Chirp-remote' }); await settle(); assert.equal(service.getSnapshot().kind, 'offline');
});

test('probe failure remains offline and start failure never leaks raw native text', async () => {
  const { discovery, diagnostics, authenticator, service } = makeHarness();
  discovery.failProbe = true; await service.activate(pair); discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) }); await settle();
  assert.equal(service.getSnapshot().kind, 'offline'); assert.ok(diagnostics.events.includes('availability_probe_failed'));
  await service.deactivate(); discovery.failProbe = false; discovery.failStart = true; await service.activate(pair);
  const failed = service.getSnapshot(); assert.equal(failed.kind, 'offline');
  if (failed.kind === 'offline') { assert.equal(failed.localAdvertised, false); assert.equal(failed.message?.includes('raw native detail'), false); }
});

test('deactivate stops discovery and stale events cannot restore availability', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair); await service.deactivate(); assert.equal(service.getSnapshot().kind, 'inactive');
  discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) }); await settle();
  assert.equal(service.getSnapshot().kind, 'inactive'); assert.ok(discovery.stopCount >= 2);
});

test('a stale resolution from an older advertisement cannot overwrite the current matched endpoint or demote it later', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair);
  const newer = await trustedRemote(authenticator);
  discovery.emit({ type: 'service_resolved', service: newer }); await settle();
  assert.equal(service.getSnapshot().kind, 'available');

  // A delayed resolution for a superseded partner advertisement: its HMAC material is authentic,
  // but its probe endpoint was closed when the partner re-advertised, so the probe gate rejects it.
  const staleRemote = { nonce: '30'.repeat(16), host: '192.168.18.12', port: 42003, controlPort: 45003 };
  const stale = {
    serviceName: 'Chirp-remote-old',
    host: staleRemote.host,
    port: staleRemote.port,
    peerHint: await authenticator.derivePeerHint(secret, staleRemote.nonce),
    nonce: staleRemote.nonce,
    proof: await authenticator.createProof(secret, staleRemote),
  };
  discovery.failProbe = true;
  discovery.emit({ type: 'service_resolved', service: stale }); await settle();
  const afterStaleResolve = service.getSnapshot();
  assert.equal(afterStaleResolve.kind, 'available');
  if (afterStaleResolve.kind === 'available') assert.deepEqual(afterStaleResolve.endpoint, { host: '192.168.18.11', port: 45002 });

  // A late 'service_lost' for the superseded advertisement must not demote the newer match either.
  discovery.emit({ type: 'service_lost', serviceName: stale.serviceName }); await settle();
  assert.equal(service.getSnapshot().kind, 'available');
});

test('a local control-listener replacement re-advertises availability with a fresh authenticated proof', async () => {
  const { discovery, diagnostics, authenticator, control, service } = makeHarness();
  await service.activate(pair);
  discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) }); await settle();
  assert.equal(service.getSnapshot().kind, 'available');
  const stopsBefore = discovery.stopCount;
  const startsBefore = discovery.startArgs;
  control.emitChange(); // native listener failed/invalidated
  await settle();
  const rearming = service.getSnapshot();
  assert.equal(rearming.kind, 'offline'); // old advertisement stopped, re-advertising (fail-closed)
  assert.ok(discovery.stopCount > stopsBefore); // old advertisement stopped
  assert.notEqual(discovery.startArgs, startsBefore); // fresh advertisement registered with fresh proof
  assert.ok(diagnostics.events.includes('availability_started'));
  // The trusted partner is re-discovered and becomes available again.
  discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) }); await settle();
  assert.equal(service.getSnapshot().kind, 'available');
  service.dispose();
});

test('a stale control-endpoint probe cannot become available after a newer generation is proven', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair);
  discovery.deferProbe = true;
  const stale = await trustedRemote(authenticator, { nonce: '30'.repeat(16), host: '192.168.18.12', port: 42003, controlPort: 45003, serviceName: 'Chirp-remote-old' });
  discovery.emit({ type: 'service_resolved', service: stale });
  await settle();
  assert.equal(service.getSnapshot().kind, 'offline');
  const fresh = await trustedRemote(authenticator);
  discovery.emit({ type: 'service_resolved', service: fresh });
  await settle();
  discovery.resolveDeferredProbes((call) => call.port === fresh.controlPort);
  await settle();
  const available = service.getSnapshot();
  assert.equal(available.kind, 'available');
  if (available.kind === 'available') assert.deepEqual(available.endpoint, { host: '192.168.18.11', port: 45002 });
  discovery.resolveDeferredProbes((call) => call.port === stale.controlPort);
  await settle();
  const afterStale = service.getSnapshot();
  assert.equal(afterStale.kind, 'available');
  if (afterStale.kind === 'available') assert.deepEqual(afterStale.endpoint, { host: '192.168.18.11', port: 45002 });
});

test('same service with a replaced control port immediately unpublishes the stale endpoint', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair);
  const first = await trustedRemote(authenticator);
  discovery.emit({ type: 'service_resolved', service: first });
  await settle();
  assert.equal(service.getSnapshot().kind, 'available');
  const replacement = await trustedRemote(authenticator, { nonce: '50'.repeat(16), port: 42005, controlPort: 45005, serviceName: first.serviceName });
  discovery.emit({ type: 'service_resolved', service: replacement });
  await settle();
  const after = service.getSnapshot();
  assert.equal(after.kind, 'available');
  if (after.kind === 'available') assert.deepEqual(after.endpoint, { host: replacement.host, port: replacement.controlPort });
  assert.ok(discovery.probeCalls.some((call) => call.port === replacement.controlPort));
});

test('failed current listener invalidates availability; a stale listener error does not invalidate the replacement', async () => {
  const { discovery, authenticator, control, service } = makeHarness();
  await service.activate(pair);
  discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) });
  await settle();
  assert.equal(service.getSnapshot().kind, 'available');
  const startsBefore = control.ensureCalls;
  control.emitChange();
  await settle();
  assert.equal(service.getSnapshot().kind, 'offline');
  assert.ok(control.ensureCalls > startsBefore);
  discovery.emit({ type: 'service_resolved', service: await trustedRemote(authenticator) });
  await settle();
  assert.equal(service.getSnapshot().kind, 'available');
  const ensureAfterReplacement = control.ensureCalls;
  assert.equal(control.ensureCalls, ensureAfterReplacement);
});

test('slow reachability of an older service does not block a newer valid control endpoint', async () => {
  const { discovery, authenticator, service } = makeHarness();
  await service.activate(pair);
  discovery.deferProbe = true;
  const older = await trustedRemote(authenticator, { nonce: '40'.repeat(16), host: '192.168.18.13', port: 42004, controlPort: 45004, serviceName: 'Chirp-remote-slow' });
  discovery.emit({ type: 'service_resolved', service: older });
  await settle();
  assert.equal(service.getSnapshot().kind, 'offline');
  const newer = await trustedRemote(authenticator);
  discovery.emit({ type: 'service_resolved', service: newer });
  await settle();
  assert.equal(discovery.probeCalls.length, 2);
  discovery.resolveDeferredProbes((call) => call.port === newer.controlPort);
  await settle();
  const state = service.getSnapshot();
  assert.equal(state.kind, 'available');
  if (state.kind === 'available') assert.deepEqual(state.endpoint, { host: '192.168.18.11', port: 45002 });
  discovery.resolveDeferredProbes((call) => call.port === older.controlPort);
  await settle();
  const afterSlow = service.getSnapshot();
  assert.equal(afterSlow.kind, 'available');
  if (afterSlow.kind === 'available') assert.deepEqual(afterSlow.endpoint, { host: '192.168.18.11', port: 45002 });
});
