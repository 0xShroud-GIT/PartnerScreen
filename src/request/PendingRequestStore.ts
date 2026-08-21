import type { KeyValueStore } from '../domain/persistence/KeyValueStore';
import { UUID_V4_RE } from '../protocol/ControlMessage';

export const PENDING_REQUEST_STORAGE_KEY = '@partnerscreen/pending-request/v1';

export interface PendingRequestRecord {
  schemaVersion: 1;
  sessionId: string;
  partnerDeviceId: string;
  receivedAt: string;
  expiresAt: string;
}

export class PendingRequestStore {
  constructor(private readonly store: KeyValueStore) {}

  async load(): Promise<PendingRequestRecord | null> {
    const raw = await this.store.getString(PENDING_REQUEST_STORAGE_KEY);
    if (raw === null) return null;
    try { return this.parse(JSON.parse(raw) as unknown); }
    catch {
      await this.store.remove(PENDING_REQUEST_STORAGE_KEY).catch(() => undefined);
      return null;
    }
  }

  async save(record: PendingRequestRecord): Promise<void> {
    await this.store.setString(PENDING_REQUEST_STORAGE_KEY, JSON.stringify(this.parse(record)));
  }

  async clear(): Promise<void> { await this.store.remove(PENDING_REQUEST_STORAGE_KEY); }

  async clearOnStartup(): Promise<void> {
    // A process restart terminates the authenticated transport. A durable request cannot remain
    // actionable without that channel, so startup is a terminal cleanup boundary for M4.
    if (await this.load()) await this.clear();
  }

  private parse(value: unknown): PendingRequestRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pending request.');
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== ['expiresAt', 'partnerDeviceId', 'receivedAt', 'schemaVersion', 'sessionId'].sort().join(',')) {
      throw new Error('Unsupported pending request fields.');
    }
    if (item.schemaVersion !== 1) throw new Error('Unsupported pending request version.');
    if (typeof item.sessionId !== 'string' || !UUID_V4_RE.test(item.sessionId)) throw new Error('Invalid pending request session.');
    if (typeof item.partnerDeviceId !== 'string' || !UUID_V4_RE.test(item.partnerDeviceId)) throw new Error('Invalid pending request partner.');
    if (typeof item.receivedAt !== 'string' || Number.isNaN(Date.parse(item.receivedAt))) throw new Error('Invalid pending request time.');
    if (typeof item.expiresAt !== 'string' || Number.isNaN(Date.parse(item.expiresAt))) throw new Error('Invalid pending request expiry.');
    if (Date.parse(item.expiresAt) <= Date.parse(item.receivedAt)) throw new Error('Invalid pending request expiry order.');
    return {
      schemaVersion: 1,
      sessionId: item.sessionId.toLowerCase(),
      partnerDeviceId: item.partnerDeviceId.toLowerCase(),
      receivedAt: item.receivedAt,
      expiresAt: item.expiresAt,
    };
  }
}
