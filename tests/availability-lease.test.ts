import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AvailabilityService, AVAILABILITY_LEASE_REPROBE_MS } from '../src/availability/AvailabilityService';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import { HmacDiscoveryAuthenticator, type HmacSha256 } from '../src/domain/discovery/TrustedDiscoveryAuthenticator';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { ChirpDiscovery, ChirpDiscoveryEvent, DiscoveryAdvertisementPreparation, DiscoveryRegistration } from '../src/platform/discovery/ChirpDiscovery';
import type { RuntimeScheduler, RuntimeTimer } from '../src/runtime/RuntimeScheduler';

class Hmac implements HmacSha256 { async macHex(keyHex: string, message: string) { return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex'); } }
class Scheduler implements RuntimeScheduler {
  tasks: Array<{ delay: number; task: () => void; cancelled: boolean }> = [];
  schedule(delay: number, task: () => void): RuntimeTimer {
    const entry = { delay, task, cancelled: false }; this.tasks.push(entry); return { cancel: () => { entry.cancelled = true; } };
  }
  runNext() { const entry = this.tasks.find((task) => !task.cancelled); if (!entry) throw new Error('no scheduled task'); entry.cancelled = true; entry.task(); }
}
class Discovery implements ChirpDiscovery {
  listeners = new Set<(event: ChirpDiscoveryEvent) => void>(); failProbe = false; probes: Array<{host:string;port:number}> = [];
  async prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation> { return { advertisementId: 'local', host: '192.168.1.10', port: 41000, nonce: '10'.repeat(16) }; }
  async start(): Promise<DiscoveryRegistration> { return { serviceName: 'Chirp-local' }; }
  async stop() {}
  async probe(host: string, port: number) { this.probes.push({ host, port }); if (this.failProbe) throw new Error('offline'); }
  subscribe(listener: (event: ChirpDiscoveryEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: ChirpDiscoveryEvent) { for (const listener of this.listeners) listener(event); }
}
const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '11111111-1111-4111-8111-111111111111', partnerDeviceId: '22222222-2222-4222-8222-222222222222', partnerDeviceName: 'Claire', pairedAt: '2026-08-22T00:00:00.000Z' };
const secret = 'ab'.repeat(32);
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); }
async function harness() {
  const discovery = new Discovery(); const scheduler = new Scheduler(); const diagnostics: DiagnosticEventKind[] = [];
  const auth = new HmacDiscoveryAuthenticator(new Hmac());
  const service = new AvailabilityService(
    { loadPairSecret: async () => secret },
    { append: async (kind) => { diagnostics.push(kind); } },
    discovery,
    auth,
    { ensureListening: async () => ({ host: '192.168.1.10', port: 44000 }) },
    scheduler,
  );
  await service.activate(pair);
  const nonce = '20'.repeat(16); const host = '192.168.1.11'; const port = 42000; const controlPort = 45000;
  discovery.emit({ type: 'service_resolved', service: { serviceName: 'Chirp-remote', host, port, nonce, peerHint: await auth.derivePeerHint(secret, nonce), proof: await auth.createProof(secret, { nonce, host, port, controlPort }) } });
  await settle();
  return { discovery, scheduler, diagnostics, service, endpoint: { host, port: controlPort } };
}

test('available partner is re-probed on a short lease and demoted when endpoint dies', async () => {
  const { discovery, scheduler, diagnostics, service } = await harness();
  assert.equal(service.getSnapshot().kind, 'available');
  assert.equal(scheduler.tasks.some((task) => task.delay === AVAILABILITY_LEASE_REPROBE_MS), true);
  discovery.failProbe = true; scheduler.runNext(); await settle();
  assert.equal(service.getSnapshot().kind, 'offline');
  assert.ok(diagnostics.includes('availability_probe_failed'));
  service.dispose();
});

test('failed request endpoint can invalidate availability immediately', async () => {
  const { service, endpoint } = await harness();
  assert.equal(service.getSnapshot().kind, 'available');
  await service.markPartnerUnreachable(endpoint);
  assert.equal(service.getSnapshot().kind, 'offline');
  service.dispose();
});
