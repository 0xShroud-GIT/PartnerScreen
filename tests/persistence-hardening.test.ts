import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import type { SecretStore } from '../src/domain/security/SecretStore';
import { IdentityRepository, LOCAL_IDENTITY_STORAGE_KEY } from '../src/domain/identity/IdentityRepository';
import { parseLocalDeviceIdentity } from '../src/domain/identity/LocalDeviceIdentity';
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
  readonly failRemove = new Set<string>();

  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) {
    if (this.failRemove.has(key)) throw new Error('injected ordinary delete failure');
    this.values.delete(key);
  }
}

class DelayedIdentityStore extends MemoryStore {
  override async setString(key: string, value: string) {
    if (key === LOCAL_IDENTITY_STORAGE_KEY && value.includes('"deviceName":"First"')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await super.setString(key, value);
  }
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  readonly failDelete = new Set<string>();

  async getSecret(key: string) { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string) { this.values.set(key, value); }
  async deleteSecret(key: string) {
    if (this.failDelete.has(key)) throw new Error('injected secret delete failure');
    this.values.delete(key);
  }
}

const ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const KEY = 'ab'.repeat(32);
const pending: PendingPairTrust = {
  schemaVersion: 1,
  protocolVersion: 1,
  pairId: '33333333-3333-4333-8333-333333333333',
  partnerDeviceId: PARTNER_ID,
  partnerDeviceName: 'Partner Phone',
  pairedAt: '2026-08-18T00:00:00.000Z',
};

test('concurrent M1 device-name writes are serialized in call order', async () => {
  const store = new DelayedIdentityStore();
  const repo = new IdentityRepository(
    store,
    { createDeviceId: () => ID },
    { nowIso: () => '2026-08-18T00:00:00.000Z' },
  );
  await repo.bootstrap();

  const first = repo.rename('First');
  const second = repo.rename('Second');
  await Promise.all([first, second]);

  const saved = JSON.parse(store.values.get(LOCAL_IDENTITY_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
  assert.equal(saved.deviceName, 'Second');
  assert.equal(repo.getCached()?.deviceName, 'Second');
});

test('M1 rejects identity timestamps that move backwards', () => {
  assert.throws(() => parseLocalDeviceIdentity({
    schemaVersion: 1,
    deviceId: ID,
    deviceName: 'Phone',
    createdAt: '2026-08-18T00:01:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  }), /timestamps are out of order/i);
});

test('M2 pair metadata uses the same normalized name contract as M1', async () => {
  const repo = new PairTrustRepository(new MemoryStore(), new MemorySecrets());
  await assert.rejects(
    repo.stage({ ...pending, partnerDeviceName: 'Partner  Phone' }, KEY),
    /partner name/i,
  );
});

test('abort removes orphan durable pair secret even without metadata', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  secrets.values.set(PAIR_SECRET_STORAGE_KEY, KEY);
  const repo = new PairTrustRepository(ordinary, secrets);

  await repo.abortPairAttempt();
  assert.equal(secrets.values.has(PAIR_SECRET_STORAGE_KEY), false);
  assert.equal(ordinary.values.has(PAIR_METADATA_STORAGE_KEY), false);
});

test('restart cleanup fails closed when provisional deletion cannot be verified', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  const repo = new PairTrustRepository(ordinary, secrets);
  await repo.stage(pending, KEY);
  secrets.failDelete.add(PAIR_PENDING_SECRET_KEY);

  await assert.rejects(repo.discardIncomplete(), /provisional pair trust/i);
});

test('revoke surfaces pending cleanup failure instead of reporting false success', async () => {
  const ordinary = new MemoryStore();
  const secrets = new MemorySecrets();
  const repo = new PairTrustRepository(ordinary, secrets);
  await repo.stage(pending, KEY);
  ordinary.failRemove.add(PAIR_PENDING_METADATA_KEY);

  await assert.rejects(repo.revoke(), /revoke/i);
});
