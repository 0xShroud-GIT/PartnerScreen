import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import { IdentityRepository, LOCAL_IDENTITY_STORAGE_KEY } from '../src/domain/identity/IdentityRepository';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

const clock = { nowIso: () => '2026-08-17T20:00:00.000Z' };
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

test('stable local identity survives repository recreation', async () => {
  const store = new MemoryStore();
  const first = new IdentityRepository(store, { createDeviceId: () => ID_A }, clock);
  const created = await first.bootstrap();
  assert.equal(created.created, true);
  assert.equal(created.identity.deviceId, ID_A);

  const afterRestart = new IdentityRepository(store, { createDeviceId: () => ID_B }, clock);
  const loaded = await afterRestart.bootstrap();
  assert.equal(loaded.created, false);
  assert.equal(loaded.identity.deviceId, ID_A);
});

test('device name is normalized and persists across repository recreation', async () => {
  const store = new MemoryStore();
  const first = new IdentityRepository(store, { createDeviceId: () => ID_A }, clock);
  await first.bootstrap();
  const renamed = await first.rename('  My   Pixel  ');
  assert.equal(renamed.deviceName, 'My Pixel');

  const afterRestart = new IdentityRepository(store, { createDeviceId: () => ID_B }, clock);
  assert.equal((await afterRestart.bootstrap()).identity.deviceName, 'My Pixel');
});

test('corrupt persisted identity fails closed instead of rotating the device ID', async () => {
  const store = new MemoryStore();
  store.values.set(LOCAL_IDENTITY_STORAGE_KEY, '{"schemaVersion":1,"deviceId":"broken"}');
  let factoryCalls = 0;
  const repository = new IdentityRepository(store, { createDeviceId: () => { factoryCalls += 1; return ID_B; } }, clock);

  await assert.rejects(repository.bootstrap(), /Refusing to silently rotate/);
  assert.equal(factoryCalls, 0);
});
