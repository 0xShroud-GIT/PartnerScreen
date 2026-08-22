import type { DiagnosticsRepository } from '../domain/diagnostics/DiagnosticsRepository';
import { IdentityPersistenceError, type IdentityRepository } from '../domain/identity/IdentityRepository';
import { InvalidDeviceNameError, type LocalDeviceIdentity } from '../domain/identity/LocalDeviceIdentity';

export class LocalIdentityService {
  private cachedIdentity: LocalDeviceIdentity | null = null;
  private bootstrapInFlight: Promise<LocalDeviceIdentity> | null = null;

  constructor(
    private readonly identities: IdentityRepository,
    private readonly diagnostics: DiagnosticsRepository,
  ) {}

  bootstrap(): Promise<LocalDeviceIdentity> {
    if (this.cachedIdentity) return Promise.resolve(this.cachedIdentity);
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    const pending = this.bootstrapOnce();
    this.bootstrapInFlight = pending;
    void pending.finally(() => {
      if (this.bootstrapInFlight === pending) this.bootstrapInFlight = null;
    }).catch(() => undefined);
    return pending;
  }

  async rename(input: string): Promise<LocalDeviceIdentity> {
    try {
      // Avoid an older in-flight bootstrap overwriting the freshly renamed process cache.
      if (this.bootstrapInFlight) await this.bootstrapInFlight.catch(() => undefined);
      const identity = await this.identities.rename(input);
      this.cachedIdentity = identity;
      await this.safeRecord('device_name_updated');
      return identity;
    } catch (error) {
      if (error instanceof InvalidDeviceNameError) await this.safeRecord('identity_validation_rejected');
      else if (error instanceof IdentityPersistenceError) await this.safeRecord('identity_storage_error');
      throw error;
    }
  }

  private async bootstrapOnce(): Promise<LocalDeviceIdentity> {
    try {
      const result = await this.identities.bootstrap();
      this.cachedIdentity = result.identity;
      await this.safeRecord(result.created ? 'identity_created' : 'identity_loaded');
      return result.identity;
    } catch (error) {
      if (error instanceof IdentityPersistenceError) await this.safeRecord('identity_storage_error');
      throw error;
    }
  }

  private async safeRecord(kind: Parameters<DiagnosticsRepository['append']>[0]): Promise<void> {
    try {
      await this.diagnostics.append(kind);
    } catch {
      // Diagnostics must never block identity persistence or UI recovery.
    }
  }
}
