import type { DiagnosticsRepository } from '../domain/diagnostics/DiagnosticsRepository';
import { PairingCryptoError, type PairingCrypto } from '../domain/pairing/PairingCrypto';

export class InstrumentedPairingCrypto implements PairingCrypto {
  constructor(
    private readonly inner: PairingCrypto,
    private readonly diagnostics: DiagnosticsRepository,
  ) {}

  randomId(): string {
    return this.inner.randomId();
  }

  async generateKeyHex(): Promise<string> {
    try {
      return await this.inner.generateKeyHex();
    } catch (error) {
      await this.recordCryptoFailure(error);
      throw error;
    }
  }

  async assertRuntimeCompatible(): Promise<void> {
    if (!this.inner.assertRuntimeCompatible) return;
    try {
      await this.inner.assertRuntimeCompatible();
    } catch (error) {
      await this.recordCryptoFailure(error);
      throw error;
    }
  }

  async seal(keyHex: string, additionalData: string, plaintext: string): Promise<string> {
    try {
      return await this.inner.seal(keyHex, additionalData, plaintext);
    } catch (error) {
      await this.recordCryptoFailure(error);
      throw error;
    }
  }

  async open(keyHex: string, additionalData: string, sealedWire: string): Promise<string> {
    try {
      return await this.inner.open(keyHex, additionalData, sealedWire);
    } catch (error) {
      await this.recordCryptoFailure(error);
      throw error;
    }
  }

  private async recordCryptoFailure(error: unknown): Promise<void> {
    const kind = error instanceof PairingCryptoError && error.code === 'runtime_self_test'
      ? 'pairing_crypto_selftest_failed'
      : 'pairing_crypto_failed';
    try {
      await this.diagnostics.append(kind);
    } catch {
      // Diagnostics never controls the security decision or pairing outcome.
    }
  }
}
