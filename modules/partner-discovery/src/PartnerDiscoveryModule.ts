import { NativeModule, requireNativeModule } from 'expo';
import type {
  DiscoveryAdvertisementPreparation,
  DiscoveryRegistration,
  PartnerDiscoveryModuleEvents,
} from './PartnerDiscovery.types';

declare class PartnerDiscoveryModule extends NativeModule<PartnerDiscoveryModuleEvents> {
  prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation>;
  start(advertisementId: string, peerHint: string, proof: string): Promise<DiscoveryRegistration>;
  probe(host: string, port: number): Promise<void>;
  stop(): Promise<void>;
}

export default requireNativeModule<PartnerDiscoveryModule>('PartnerDiscovery');
