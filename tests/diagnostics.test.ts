import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import { MAX_DIAGNOSTIC_EVENTS } from '../src/domain/diagnostics/DiagnosticEvent';
import { DIAGNOSTICS_STORAGE_KEY, DiagnosticsRepository } from '../src/domain/diagnostics/DiagnosticsRepository';
import { buildDiagnosticReport } from '../src/application/DiagnosticsReport';
import type { LocalDeviceIdentity } from '../src/domain/identity/LocalDeviceIdentity';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

test('diagnostics stay bounded', async () => {
  const store = new MemoryStore();
  let tick = 0;
  const repository = new DiagnosticsRepository(store, {
    nowIso: () => new Date(Date.UTC(2026, 7, 17, 20, 0, tick++)).toISOString(),
  });
  for (let index = 0; index < MAX_DIAGNOSTIC_EVENTS + 7; index += 1) {
    await repository.append('app_started');
  }
  assert.equal((await repository.list()).length, MAX_DIAGNOSTIC_EVENTS);
});

test('diagnostics reject persisted events with unknown fields', async () => {
  const store = new MemoryStore();
  store.values.set(DIAGNOSTICS_STORAGE_KEY, JSON.stringify([{
    schemaVersion: 1,
    at: '2026-08-18T00:00:00.000Z',
    kind: 'app_started',
    accidentalPayload: 'must-not-become-durable-schema',
  }]));
  const repository = new DiagnosticsRepository(store, { nowIso: () => '2026-08-18T00:00:01.000Z' });
  await assert.rejects(repository.list(), /corrupt/i);
});

test('diagnostic report omits full device ID and user-selected device name', () => {
  const identity: LocalDeviceIdentity = {
    schemaVersion: 1,
    deviceId: '11111111-1111-4111-8111-111111111111',
    deviceName: 'Sensitive Personal Device Name',
    createdAt: '2026-08-17T20:00:00.000Z',
    updatedAt: '2026-08-17T20:00:00.000Z',
  };
  const report = buildDiagnosticReport({
    generatedAt: '2026-08-17T20:01:00.000Z',
    identity,
    events: [],
    build: { appVersion: '0.0.1', buildCommit: 'abc123', platform: 'android', platformVersion: '36' },
  });

  assert.equal(report.includes(identity.deviceId), false);
  assert.equal(report.includes(identity.deviceName ?? ''), false);
  assert.equal(report.includes('deviceIdSuffix=11111111'), true);
  assert.equal(report.includes('deviceNameConfigured=true'), true);
});
