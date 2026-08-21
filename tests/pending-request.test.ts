import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingRequestStore, PENDING_REQUEST_STORAGE_KEY } from '../src/request/PendingRequestStore';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setString(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async remove(key: string): Promise<void> { this.values.delete(key); }
}
const record = { schemaVersion: 1 as const, sessionId: '11111111-1111-4111-8111-111111111111', partnerDeviceId: '22222222-2222-4222-8222-222222222222', receivedAt: '2026-08-19T00:00:00.000Z', expiresAt: '2026-08-19T00:00:30.000Z' };

test('pending request storage persists only bounded non-secret metadata', async () => {
  const store = new MemoryStore(), pending = new PendingRequestStore(store); await pending.save(record); assert.deepEqual(await pending.load(), record);
  const raw = store.values.get(PENDING_REQUEST_STORAGE_KEY) ?? ''; assert.equal(raw.includes('secret'), false); assert.equal(raw.includes('proof'), false); assert.equal(raw.includes('cipher'), false);
});

test('corrupt or stale-process pending request data is cleared fail closed', async () => {
  const store = new MemoryStore(), pending = new PendingRequestStore(store); store.values.set(PENDING_REQUEST_STORAGE_KEY, '{"schemaVersion":1,"oops":true}'); assert.equal(await pending.load(), null); assert.equal(store.values.has(PENDING_REQUEST_STORAGE_KEY), false);
  await pending.save(record); await pending.clearOnStartup(); assert.equal(await pending.load(), null);
});
