export interface DiscoveryAdvertisementPreparation {
  advertisementId: string;
  host: string;
  port: number;
  nonce: string;
}

export interface DiscoveryRegistration {
  serviceName: string;
}

export interface ResolvedPartnerService {
  serviceName: string;
  host: string;
  port: number;
  peerHint: string;
  nonce: string;
  proof: string;
}

export type ChirpDiscoveryEvent =
  | { type: 'service_resolved'; service: ResolvedPartnerService }
  | { type: 'service_lost'; serviceName: string }
  | { type: 'error'; code: string };

export type ChirpDiscoveryModuleEvents = {
  onChirpDiscoveryEvent: (event: ChirpDiscoveryEvent) => void;
};
