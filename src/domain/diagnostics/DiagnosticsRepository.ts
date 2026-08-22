import type { KeyValueStore } from '../persistence/KeyValueStore';
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  MAX_DIAGNOSTIC_EVENTS,
  isDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticEventKind,
} from './DiagnosticEvent';
import type { Clock } from '../identity/IdentityRepository';

export const DIAGNOSTICS_STORAGE_KEY = '@chirp/diagnostics/v1';

export class DiagnosticsPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DiagnosticsPersistenceError';
  }
}

const HIGH_FREQUENCY_KINDS = new Set<DiagnosticEventKind>(['media_stats']);

export class DiagnosticsRepository {
  private writeQueue: Promise<void> = Promise.resolve();
  private memory: DiagnosticEvent[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<DiagnosticEvent[]> {
    await this.ensureLoaded();
    return this.memory.slice(-MAX_DIAGNOSTIC_EVENTS);
  }

  async append(kind: DiagnosticEventKind): Promise<void> {
    await this.ensureLoaded();
    const next: DiagnosticEvent = {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      at: this.clock.nowIso(),
      kind,
    };
    if (HIGH_FREQUENCY_KINDS.has(kind)) {
      const withoutStats = this.memory.filter((event) => event.kind !== 'media_stats');
      this.memory = [...withoutStats, next].slice(-MAX_DIAGNOSTIC_EVENTS);
    } else {
      this.memory = [...this.memory, next].slice(-MAX_DIAGNOSTIC_EVENTS);
    }
    this.schedulePersist();
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.store.getString(DIAGNOSTICS_STORAGE_KEY);
    } catch {
      this.memory = [];
      return;
    }
    if (raw === null) {
      this.memory = [];
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isDiagnosticEvent)) {
        throw new DiagnosticsPersistenceError('Persisted diagnostics are corrupt.');
      }
      this.memory = parsed.slice(-MAX_DIAGNOSTIC_EVENTS);
    } catch (error) {
      if (error instanceof DiagnosticsPersistenceError) throw error;
      throw new DiagnosticsPersistenceError('Persisted diagnostics are corrupt.', { cause: error });
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const snapshot = this.memory.slice(-MAX_DIAGNOSTIC_EVENTS);
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          await this.store.setString(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(snapshot));
        } catch {
          /* persistence never owns product flow */
        }
      }).catch(() => undefined);
    }, 750);
  }
}