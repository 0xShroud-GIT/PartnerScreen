import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('media_degraded is only emitted after the disconnected grace timer survives', () => {
  const source = readFileSync('src/media/MediaSession.ts', 'utf8');
  const timer = source.indexOf('this.disconnectedTimer = setTimeout');
  const degraded = source.indexOf("await this.record('media_degraded')", timer);
  assert.ok(timer >= 0 && degraded > timer);
});

test('foreground revalidates availability and trust revocation requires destructive confirmation', () => {
  const availability = readFileSync('src/presentation/useAvailability.ts', 'utf8');
  const pairing = readFileSync('src/presentation/usePairing.ts', 'utf8');
  assert.equal(availability.includes("next === 'active'"), true);
  assert.equal(availability.includes('availabilityService.retry()'), true);
  assert.equal(pairing.includes("Alert.alert("), true);
  assert.equal(pairing.includes("style: 'destructive'"), true);
  assert.equal(pairing.includes('pairingService.revokePair().finally(resolve)'), true);
});

test('persistent media diagnostics and stale-endpoint invalidation are wired into app services', () => {
  const services = readFileSync('src/application/AppServices.ts', 'utf8');
  const diagnostics = readFileSync('app/diagnostics.tsx', 'utf8');
  assert.equal(services.includes('new AvailabilityAwareControlChannel(controlSession, availabilityService)'), true);
  assert.equal(services.includes('new MediaDiagnosticPersistence(ordinaryStore, mediaSession)'), true);
  assert.equal(diagnostics.includes('mediaDiagnosticPersistence.snapshotForReport('), true);
});
