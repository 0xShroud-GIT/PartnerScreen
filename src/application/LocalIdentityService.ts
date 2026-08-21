import type { DiagnosticsRepository } from '../domain/diagnostics/DiagnosticsRepository';
import type { LocalDeviceIdentity } from '../domain/identity/LocalDeviceIdentity';
import type { IdentityRepository } from '../domain/identity/IdentityRepository';

export class LocalIdentityService {
  constructor(
    private readonly identities: IdentityRepository,
    private readonly diagnostics: DiagnosticsRepository,
  ) {}

  async bootstrap(): Promise<LocalDeviceIdentity> {
    try {
      const result = await this.identities.bootstrap();
      await this.safeRecord(result.created ? 'identity_created' : 'identity_loaded');
      return result.identity;
    } catch (error) {
      await this.safeRecord('identity_storage_error');
      throw error;
    }
  }

  async rename(input: string): Promise<LocalDeviceIdentity> {
    try {
      const identity = await this.identities.rename(input);
      await this.safeRecord('device_name_updated');
      return identity;
    } catch (error) {
      await this.safeRecord('identity_storage_error');
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
