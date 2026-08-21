export type PairingCryptoErrorCode =
  | 'runtime_self_test'
  | 'key_generation'
  | 'seal'
  | 'open'
  | 'wire';

export class PairingCryptoError extends Error {
  constructor(
    readonly code: PairingCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PairingCryptoError';
  }
}

export interface PairingCrypto {
  randomId(): string;
  generateKeyHex(): Promise<string>;
  assertRuntimeCompatible?(): Promise<void>;
  seal(keyHex: string, additionalData: string, plaintext: string): Promise<string>;
  open(keyHex: string, additionalData: string, sealedWire: string): Promise<string>;
}
