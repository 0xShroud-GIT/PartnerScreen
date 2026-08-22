import { NativeModule, requireNativeModule } from 'expo';

declare class ChirpDiscoveryAuthModule extends NativeModule {
  hmacSha256(keyHex: string, message: string): Promise<string>;
}

export default requireNativeModule<ChirpDiscoveryAuthModule>('ChirpDiscoveryAuth');
