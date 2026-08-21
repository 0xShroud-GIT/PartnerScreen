import type { HmacSha256 } from '../../domain/discovery/TrustedDiscoveryAuthenticator';

interface NativeDiscoveryAuthModule {
  hmacSha256(keyHex: string, message: string): Promise<string>;
}

function getNativeModule(): NativeDiscoveryAuthModule {
  // Deferred so headless domain tests never evaluate an Android-only native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../../modules/partner-discovery-auth').default as NativeDiscoveryAuthModule;
}

export class ExpoDiscoveryHmac implements HmacSha256 {
  async macHex(keyHex: string, message: string): Promise<string> {
    try {
      const result = await getNativeModule().hmacSha256(keyHex, message);
      if (!/^[0-9a-f]{64}$/i.test(result)) throw new Error('invalid native HMAC output');
      return result.toLowerCase();
    } catch {
      throw new Error('Trusted availability authentication could not be prepared.');
    }
  }
}
