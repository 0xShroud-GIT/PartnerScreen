import { NativeModule, requireNativeModule } from 'expo';

declare class PartnerDiscoveryAuthModule extends NativeModule {
  hmacSha256(keyHex: string, message: string): Promise<string>;
}

export default requireNativeModule<PartnerDiscoveryAuthModule>('PartnerDiscoveryAuth');
