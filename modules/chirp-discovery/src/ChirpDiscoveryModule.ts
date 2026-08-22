import { NativeModule, requireNativeModule } from 'expo';
import type {
  DiscoveryAdvertisementPreparation,
  DiscoveryRegistration,
  ChirpDiscoveryModuleEvents,
} from './ChirpDiscovery.types';

declare class ChirpDiscoveryModule extends NativeModule<ChirpDiscoveryModuleEvents> {
  prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation>;
  start(advertisementId: string, peerHint: string, proof: string): Promise<DiscoveryRegistration>;
  probe(host: string, port: number): Promise<void>;
  stop(): Promise<void>;
}

export default requireNativeModule<ChirpDiscoveryModule>('ChirpDiscovery');
