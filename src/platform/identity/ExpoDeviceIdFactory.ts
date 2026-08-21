import * as Crypto from 'expo-crypto';
import type { DeviceIdFactory } from '../../domain/identity/IdentityRepository';

export class ExpoDeviceIdFactory implements DeviceIdFactory {
  createDeviceId(): string {
    return Crypto.randomUUID();
  }
}
