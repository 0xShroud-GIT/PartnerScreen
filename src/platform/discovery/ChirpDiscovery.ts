export interface DiscoveryAdvertisementPreparation {
  advertisementId: string;
  host: string;
  port: number;
  nonce: string;
}

export interface DiscoveryRegistration { serviceName: string; }

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

export interface ChirpDiscovery {
  prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation>;
  start(advertisementId: string, peerHint: string, proof: string): Promise<DiscoveryRegistration>;
  probe(host: string, port: number): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (event: ChirpDiscoveryEvent) => void): () => void;
}
