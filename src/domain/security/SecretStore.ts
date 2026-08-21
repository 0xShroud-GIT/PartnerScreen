/**
 * Boundary for small pairing/authentication secrets.
 * Implementations must use platform-protected secure storage and must never log values.
 */
export interface SecretStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
