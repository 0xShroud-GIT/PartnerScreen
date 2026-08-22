import type { KeyValueStore } from '../persistence/KeyValueStore';
import type { SecretStore } from '../security/SecretStore';
import { normalizeDeviceName } from '../identity/LocalDeviceIdentity';
import { PAIRING_PROTOCOL_VERSION } from './PairingQr';

export const PAIR_METADATA_STORAGE_KEY = '@chirp/pair-metadata/v1';
export const PAIR_SECRET_STORAGE_KEY = 'chirp.pair-secret.v1';
export const PAIR_PENDING_METADATA_KEY = '@chirp/pair-pending/v1';
export const PAIR_PENDING_SECRET_KEY = 'chirp.pair-pending-secret.v1';

export type PairTrustStatus = 'committed' | 'confirmed';

export interface PairTrustMetadata {
  schemaVersion: 1;
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  status: PairTrustStatus;
  pairId: string;
  partnerDeviceId: string;
  partnerDeviceName: string;
  pairedAt: string;
}

export interface PendingPairTrust {
  schemaVersion: 1;
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  pairId: string;
  partnerDeviceId: string;
  partnerDeviceName: string;
  pairedAt: string;
}

export class PairTrustPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PairTrustPersistenceError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^[0-9a-f]{64}$/i;

function validatePartnerName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label} partner name.`);
  let normalized: string;
  try {
    normalized = normalizeDeviceName(value);
  } catch {
    throw new Error(`Invalid ${label} partner name.`);
  }
  if (normalized !== value) throw new Error(`Invalid ${label} partner name.`);
  return normalized;
}

function parsePending(raw: string): PendingPairTrust {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Malformed pending pair metadata.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pending pair metadata.');
  const item = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'protocolVersion', 'pairId', 'partnerDeviceId', 'partnerDeviceName', 'pairedAt']);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error('Unsupported pending pair metadata.');
  if (item.schemaVersion !== 1 || item.protocolVersion !== PAIRING_PROTOCOL_VERSION) throw new Error('Unsupported pending pair metadata.');
  if (typeof item.pairId !== 'string' || !UUID_RE.test(item.pairId)) throw new Error('Invalid pending pair ID.');
  if (typeof item.partnerDeviceId !== 'string' || !UUID_RE.test(item.partnerDeviceId)) throw new Error('Invalid pending partner ID.');
  const partnerDeviceName = validatePartnerName(item.partnerDeviceName, 'pending');
  if (typeof item.pairedAt !== 'string' || Number.isNaN(Date.parse(item.pairedAt))) throw new Error('Invalid pending pair time.');
  return {
    schemaVersion: 1,
    protocolVersion: PAIRING_PROTOCOL_VERSION,
    pairId: item.pairId,
    partnerDeviceId: item.partnerDeviceId,
    partnerDeviceName,
    pairedAt: item.pairedAt,
  };
}

function parseMetadata(raw: string): PairTrustMetadata {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Malformed pair metadata.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pair metadata.');
  const item = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'protocolVersion', 'status', 'pairId', 'partnerDeviceId', 'partnerDeviceName', 'pairedAt']);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error('Unsupported pair metadata.');
  if (item.schemaVersion !== 1 || item.protocolVersion !== PAIRING_PROTOCOL_VERSION) throw new Error('Unsupported pair metadata.');
  if (item.status !== 'committed' && item.status !== 'confirmed') throw new Error('Invalid pair status.');
  if (typeof item.pairId !== 'string' || !UUID_RE.test(item.pairId)) throw new Error('Invalid pair ID.');
  if (typeof item.partnerDeviceId !== 'string' || !UUID_RE.test(item.partnerDeviceId)) throw new Error('Invalid partner ID.');
  const partnerDeviceName = validatePartnerName(item.partnerDeviceName, 'saved');
  if (typeof item.pairedAt !== 'string' || Number.isNaN(Date.parse(item.pairedAt))) throw new Error('Invalid pair time.');
  return {
    schemaVersion: 1,
    protocolVersion: PAIRING_PROTOCOL_VERSION,
    status: item.status,
    pairId: item.pairId,
    partnerDeviceId: item.partnerDeviceId,
    partnerDeviceName,
    pairedAt: item.pairedAt,
  };
}

export class PairTrustRepository {
  constructor(
    private readonly ordinaryStore: KeyValueStore,
    private readonly secretStore: SecretStore,
  ) {}

  async loadConfirmed(): Promise<PairTrustMetadata | null> {
    const [rawMetadata, secret] = await Promise.all([
      this.ordinaryStore.getString(PAIR_METADATA_STORAGE_KEY),
      this.secretStore.getSecret(PAIR_SECRET_STORAGE_KEY),
    ]);

    if (rawMetadata === null && secret === null) return null;
    if (rawMetadata === null || secret === null) {
      throw new PairTrustPersistenceError('Pair trust storage is incomplete. Refusing to invent or rotate trust material.');
    }

    try {
      const metadata = parseMetadata(rawMetadata);
      if (!KEY_RE.test(secret)) throw new Error('Invalid pair secret.');
      return metadata.status === 'confirmed' ? metadata : null;
    } catch (error) {
      throw new PairTrustPersistenceError('Persisted pair trust is corrupt.', { cause: error });
    }
  }

  async hasAnyDurablePairMaterial(): Promise<boolean> {
    const [rawMetadata, secret] = await Promise.all([
      this.ordinaryStore.getString(PAIR_METADATA_STORAGE_KEY),
      this.secretStore.getSecret(PAIR_SECRET_STORAGE_KEY),
    ]);
    return rawMetadata !== null || secret !== null;
  }

  async stage(pending: PendingPairTrust, pairKeyHex: string): Promise<void> {
    if (!KEY_RE.test(pairKeyHex)) throw new PairTrustPersistenceError('Refusing to stage an invalid pair secret.');
    if (await this.hasAnyDurablePairMaterial()) {
      throw new PairTrustPersistenceError('This phone already contains durable pair trust material.');
    }

    const validated = parsePending(JSON.stringify(pending));
    try {
      await this.secretStore.setSecret(PAIR_PENDING_SECRET_KEY, pairKeyHex.toLowerCase());
      await this.ordinaryStore.setString(PAIR_PENDING_METADATA_KEY, JSON.stringify(validated));
    } catch (error) {
      let cleanupError: unknown;
      try { await this.discardPendingVerified(); } catch (failure) { cleanupError = failure; }
      throw new PairTrustPersistenceError(
        cleanupError ? 'Could not stage pair trust and provisional cleanup was incomplete.' : 'Could not stage pair trust.',
        { cause: cleanupError ?? error },
      );
    }
  }

  async installCommitted(): Promise<PairTrustMetadata> {
    const [rawPending, pendingSecret] = await Promise.all([
      this.ordinaryStore.getString(PAIR_PENDING_METADATA_KEY),
      this.secretStore.getSecret(PAIR_PENDING_SECRET_KEY),
    ]);
    if (rawPending === null || pendingSecret === null) {
      try { await this.discardPendingVerified(); } catch (error) {
        throw new PairTrustPersistenceError('Pending pair trust is incomplete and cleanup failed.', { cause: error });
      }
      throw new PairTrustPersistenceError('Pending pair trust is incomplete.');
    }

    let pending: PendingPairTrust;
    try {
      pending = parsePending(rawPending);
      if (!KEY_RE.test(pendingSecret)) throw new Error('Invalid pending secret.');
    } catch (error) {
      try { await this.discardPendingVerified(); } catch (cleanupError) {
        throw new PairTrustPersistenceError('Pending pair trust is corrupt and cleanup failed.', { cause: cleanupError });
      }
      throw new PairTrustPersistenceError('Pending pair trust is corrupt.', { cause: error });
    }

    const metadata: PairTrustMetadata = { ...pending, status: 'committed' };
    try {
      await this.secretStore.setSecret(PAIR_SECRET_STORAGE_KEY, pendingSecret);
      await this.ordinaryStore.setString(PAIR_METADATA_STORAGE_KEY, JSON.stringify(metadata));
      await this.discardPendingVerified();
      return metadata;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { await this.deleteDurableVerified(); } catch (failure) { cleanupErrors.push(failure); }
      try { await this.discardPendingVerified(); } catch (failure) { cleanupErrors.push(failure); }
      throw new PairTrustPersistenceError(
        cleanupErrors.length ? 'Could not install pair trust and cleanup was incomplete.' : 'Could not install pair trust.',
        { cause: cleanupErrors[0] ?? error },
      );
    }
  }

  async markConfirmed(): Promise<PairTrustMetadata> {
    const [rawMetadata, secret] = await Promise.all([
      this.ordinaryStore.getString(PAIR_METADATA_STORAGE_KEY),
      this.secretStore.getSecret(PAIR_SECRET_STORAGE_KEY),
    ]);
    if (rawMetadata === null || secret === null) throw new PairTrustPersistenceError('Committed pair trust is incomplete.');

    try {
      const metadata = parseMetadata(rawMetadata);
      if (metadata.status !== 'committed' || !KEY_RE.test(secret)) throw new Error('Pair trust is not ready for confirmation.');
      const confirmed: PairTrustMetadata = { ...metadata, status: 'confirmed' };
      await this.ordinaryStore.setString(PAIR_METADATA_STORAGE_KEY, JSON.stringify(confirmed));
      return confirmed;
    } catch (error) {
      throw new PairTrustPersistenceError('Could not confirm pair trust.', { cause: error });
    }
  }

  async loadPairSecret(): Promise<string> {
    const metadata = await this.loadConfirmed();
    if (!metadata) throw new PairTrustPersistenceError('No confirmed partner trust exists.');
    const secret = await this.secretStore.getSecret(PAIR_SECRET_STORAGE_KEY);
    if (!secret || !KEY_RE.test(secret)) throw new PairTrustPersistenceError('Confirmed pair secret is unavailable.');
    return secret;
  }

  async discardIncomplete(): Promise<void> {
    await this.discardPendingVerified();
    const [rawMetadata, secret] = await Promise.all([
      this.ordinaryStore.getString(PAIR_METADATA_STORAGE_KEY),
      this.secretStore.getSecret(PAIR_SECRET_STORAGE_KEY),
    ]);

    if (rawMetadata === null && secret === null) return;
    if (rawMetadata === null && secret !== null) {
      await this.deleteDurableVerified();
      return;
    }
    if (rawMetadata === null) return;

    let metadata: PairTrustMetadata;
    try {
      metadata = parseMetadata(rawMetadata);
    } catch (error) {
      throw new PairTrustPersistenceError('Persisted pair trust is corrupt.', { cause: error });
    }

    if (metadata.status === 'committed') {
      await this.deleteDurableVerified();
      return;
    }
    if (secret === null) {
      throw new PairTrustPersistenceError('Confirmed pair trust storage is incomplete.');
    }
    if (!KEY_RE.test(secret)) {
      throw new PairTrustPersistenceError('Confirmed pair trust storage is corrupt.');
    }
  }

  async abortPairAttempt(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.discardPendingVerified(); } catch (error) { errors.push(error); }
    try { await this.deleteDurableVerified(); } catch (error) { errors.push(error); }
    if (errors.length) {
      throw new PairTrustPersistenceError('Could not fully remove unfinished pair trust.', { cause: errors[0] });
    }
  }

  async revoke(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.deleteDurableVerified(); } catch (error) { errors.push(error); }
    try { await this.discardPendingVerified(); } catch (error) { errors.push(error); }
    if (errors.length) throw new PairTrustPersistenceError('Could not fully revoke pair trust.', { cause: errors[0] });
  }

  private async discardPendingVerified(): Promise<void> {
    const results = await Promise.allSettled([
      this.ordinaryStore.remove(PAIR_PENDING_METADATA_KEY),
      this.secretStore.deleteSecret(PAIR_PENDING_SECRET_KEY),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw new PairTrustPersistenceError('Could not remove provisional pair trust.', { cause: failure.reason });
  }

  private async deleteDurableVerified(): Promise<void> {
    const results = await Promise.allSettled([
      this.ordinaryStore.remove(PAIR_METADATA_STORAGE_KEY),
      this.secretStore.deleteSecret(PAIR_SECRET_STORAGE_KEY),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw new PairTrustPersistenceError('Could not remove durable pair trust.', { cause: failure.reason });
  }
}
