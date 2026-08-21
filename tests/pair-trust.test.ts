import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import type { SecretStore } from '../src/domain/security/SecretStore';
import {
  PAIR_METADATA_STORAGE_KEY,
  PAIR_PENDING_METADATA_KEY,
  PAIR_PENDING_SECRET_KEY,
  PAIR_SECRET_STORAGE_KEY,
  PairTrustRepository,
  type PendingPairTrust,
} from '../src/domain/pairing/PairTrustRepository';

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

const pending: PendingPairTrust = {
  schemaVersion: 1,
  protocolVersion: 1,
  pairId: '11111111-1111-4111-8111-111111111111',
  partnerDeviceId: '22222222-2222-4222-8222-222222222222',
  partnerDeviceName: 'Partner Phone',
  pairedAt: '2026-08-17T22:00:00.000Z',
};
const KEY = 'ab'.repeat(32);

test('pair secret keys are valid Expo SecureStore keys', () => {
  const secureStoreKey = /^[A-Za-z0-9._-]+$/;
  assert.match(PAIR_SECRET_STORAGE_KEY, secureStoreKey);
  assert.match(PAIR_PENDING_SECRET_KEY, secureStoreKey);
});

test('durable pair secret never enters ordinary metadata', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  const repo = new PairTrustRepository(ordinary, secrets);
  await repo.stage(pending, KEY);

  assert.equal(ordinary.values.get(PAIR_PENDING_METADATA_KEY)?.includes(KEY), false);
  assert.equal(secrets.values.get(PAIR_PENDING_SECRET_KEY), KEY);

  await repo.installCommitted();
  assert.equal(ordinary.values.get(PAIR_METADATA_STORAGE_KEY)?.includes(KEY), false);
  assert.equal(secrets.values.get(PAIR_SECRET_STORAGE_KEY), KEY);
  assert.equal(await repo.loadConfirmed(), null, 'committed trust is not paired Home truth');

  const confirmed = await repo.markConfirmed();
  assert.equal(confirmed.status, 'confirmed');
  assert.equal((await repo.loadConfirmed())?.partnerDeviceId, pending.partnerDeviceId);
});

test('restart during provisional staging discards temporary pair material', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  await new PairTrustRepository(ordinary, secrets).stage(pending, KEY);

  const afterRestart = new PairTrustRepository(ordinary, secrets);
  await afterRestart.discardIncomplete();
  assert.equal(ordinary.values.has(PAIR_PENDING_METADATA_KEY), false);
  assert.equal(secrets.values.has(PAIR_PENDING_SECRET_KEY), false);
  assert.equal(await afterRestart.loadConfirmed(), null);
});

test('restart during committed-but-unconfirmed finalization fails closed to unpaired', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  const first = new PairTrustRepository(ordinary, secrets);
  await first.stage(pending, KEY);
  await first.installCommitted();
  assert.equal(await first.loadConfirmed(), null);

  const afterRestart = new PairTrustRepository(ordinary, secrets);
  await afterRestart.discardIncomplete();
  assert.equal(await afterRestart.loadConfirmed(), null);
  assert.equal(ordinary.values.has(PAIR_METADATA_STORAGE_KEY), false);
  assert.equal(secrets.values.has(PAIR_SECRET_STORAGE_KEY), false);
});

test('confirmed metadata without secure secret fails closed', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  ordinary.values.set(PAIR_METADATA_STORAGE_KEY, JSON.stringify({ ...pending, status: 'confirmed' }));
  const repo = new PairTrustRepository(ordinary, secrets);
  await assert.rejects(repo.loadConfirmed(), /incomplete/i);
});

test('orphan durable secret fails closed instead of inventing metadata', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  secrets.values.set(PAIR_SECRET_STORAGE_KEY, KEY);
  const repo = new PairTrustRepository(ordinary, secrets);
  await assert.rejects(repo.loadConfirmed(), /incomplete/i);
});

test('revoke removes both ordinary metadata and secure secret', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  const repo = new PairTrustRepository(ordinary, secrets);
  await repo.stage(pending, KEY);
  await repo.installCommitted();
  await repo.markConfirmed();
  await repo.revoke();
  assert.equal(await repo.loadConfirmed(), null);
});
