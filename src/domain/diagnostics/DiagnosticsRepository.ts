import type { KeyValueStore } from '../persistence/KeyValueStore';
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  MAX_DIAGNOSTIC_EVENTS,
  isDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticEventKind,
} from './DiagnosticEvent';
import type { Clock } from '../identity/IdentityRepository';

export const DIAGNOSTICS_STORAGE_KEY = '@partnerscreen/diagnostics/v1';

export class DiagnosticsPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DiagnosticsPersistenceError';
  }
}

export class DiagnosticsRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: KeyValueStore,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<DiagnosticEvent[]> {
    let raw: string | null;
    try {
      raw = await this.store.getString(DIAGNOSTICS_STORAGE_KEY);
    } catch (error) {
      throw new DiagnosticsPersistenceError('Could not read local diagnostics.', { cause: error });
    }
    if (raw === null) return [];

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isDiagnosticEvent)) {
        throw new Error('Unexpected diagnostics shape.');
      }
      return parsed.slice(-MAX_DIAGNOSTIC_EVENTS);
    } catch (error) {
      throw new DiagnosticsPersistenceError('Persisted diagnostics are corrupt.', { cause: error });
    }
  }

  async append(kind: DiagnosticEventKind): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const existing = await this.list();
      const next: DiagnosticEvent = {
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        at: this.clock.nowIso(),
        kind,
      };
      const bounded = [...existing, next].slice(-MAX_DIAGNOSTIC_EVENTS);
      try {
        await this.store.setString(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(bounded));
      } catch (error) {
        throw new DiagnosticsPersistenceError('Could not persist local diagnostics.', { cause: error });
      }
    });

    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
