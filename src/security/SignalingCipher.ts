export interface HmacSha256Primitive {
  macHex(keyHex: string, message: string): Promise<string>;
}

export interface AesGcmPrimitive {
  assertRuntimeCompatible(): Promise<void>;
  randomId(): string;
  randomNonceHex(bytes?: number): Promise<string>;
  seal(keyHex: string, additionalData: string, plaintext: string): Promise<string>;
  open(keyHex: string, additionalData: string, sealedWire: string): Promise<string>;
}

export interface ControlSessionKeyContext {
  sessionId: string;
  initiatorDeviceId: string;
  responderDeviceId: string;
  initiatorNonce: string;
  responderNonce: string;
}

export class SignalingCryptoError extends Error {
  constructor(readonly code: 'invalid_input' | 'authentication' | 'runtime' | 'seal' | 'open', message: string) {
    super(message);
    this.name = 'SignalingCryptoError';
  }
}
