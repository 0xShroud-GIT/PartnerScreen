import type { KeyValueStore } from '../persistence/KeyValueStore';
import {
  LOCAL_IDENTITY_SCHEMA_VERSION,
  normalizeDeviceName,
  parseLocalDeviceIdentity,
  type LocalDeviceIdentity,
} from './LocalDeviceIdentity';

export const LOCAL_IDENTITY_STORAGE_KEY = '@partnerscreen/local-identity/v1';

export interface DeviceIdFactory {
  createDeviceId(): string;
}

export interface Clock {
  nowIso(): string;
}

export interface IdentityBootstrapResult {
  identity: LocalDeviceIdentity;
  created: boolean;
}

export class IdentityPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdentityPersistenceError';
  }
}

export class IdentityRepository {
  private current: LocalDeviceIdentity | null = null;
  private bootstrapPromise: Promise<IdentityBootstrapResult> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: KeyValueStore,
    private readonly idFactory: DeviceIdFactory,
    private readonly clock: Clock,
  ) {}

  async bootstrap(): Promise<IdentityBootstrapResult> {
    if (this.current) {
      return { identity: this.current, created: false };
    }
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrapOnce();
    }

    try {
      const result = await this.bootstrapPromise;
      this.current = result.identity;
      return result;
    } finally {
      this.bootstrapPromise = null;
    }
  }

  async rename(deviceNameInput: string): Promise<LocalDeviceIdentity> {
    const operation = this.mutationQueue.then(async () => {
      const bootstrapped = await this.bootstrap();
      const deviceName = normalizeDeviceName(deviceNameInput);
      const updatedAt = this.clock.nowIso();
      const updated: LocalDeviceIdentity = {
        ...bootstrapped.identity,
        deviceName,
        updatedAt,
      };

      try {
        const validated = parseLocalDeviceIdentity(updated);
        await this.store.setString(LOCAL_IDENTITY_STORAGE_KEY, JSON.stringify(validated));
        this.current = validated;
        return validated;
      } catch (error) {
        throw new IdentityPersistenceError('Could not persist the local device name.', { cause: error });
      }
    });

    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  getCached(): LocalDeviceIdentity | null {
    return this.current;
  }

  private async bootstrapOnce(): Promise<IdentityBootstrapResult> {
    let raw: string | null;
    try {
      raw = await this.store.getString(LOCAL_IDENTITY_STORAGE_KEY);
    } catch (error) {
      throw new IdentityPersistenceError('Could not read the local identity.', { cause: error });
    }

    if (raw !== null) {
      try {
        return { identity: parseLocalDeviceIdentity(JSON.parse(raw) as unknown), created: false };
      } catch (error) {
        throw new IdentityPersistenceError(
          'Persisted local identity is corrupt. Refusing to silently rotate the device ID.',
          { cause: error },
        );
      }
    }

    const now = this.clock.nowIso();
    const created: LocalDeviceIdentity = {
      schemaVersion: LOCAL_IDENTITY_SCHEMA_VERSION,
      deviceId: this.idFactory.createDeviceId(),
      deviceName: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const validated = parseLocalDeviceIdentity(created);
      await this.store.setString(LOCAL_IDENTITY_STORAGE_KEY, JSON.stringify(validated));
      return { identity: validated, created: true };
    } catch (error) {
      throw new IdentityPersistenceError('Could not create the stable local identity.', { cause: error });
    }
  }
}
