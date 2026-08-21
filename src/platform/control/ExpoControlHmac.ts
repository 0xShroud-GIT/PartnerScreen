import type { HmacSha256Primitive } from '../../security/SignalingCipher';

type NativeHmacModule = { hmacSha256(keyHex: string, message: string): Promise<string> };
declare const require: (modulePath: string) => { default: NativeHmacModule };
let nativeModule: NativeHmacModule | null = null;

function module(): NativeHmacModule {
  if (!nativeModule) nativeModule = require('../../../modules/partner-discovery-auth').default;
  return nativeModule;
}

export class ExpoControlHmac implements HmacSha256Primitive {
  async macHex(keyHex: string, message: string): Promise<string> {
    try { return await module().hmacSha256(keyHex, message); }
    catch { throw new Error('Control authentication primitive is unavailable.'); }
  }
}
