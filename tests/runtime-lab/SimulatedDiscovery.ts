import type {
  DiscoveryAdvertisementPreparation,
  DiscoveryRegistration,
  PartnerDiscovery,
  PartnerDiscoveryEvent,
  ResolvedPartnerService,
} from '../../src/platform/discovery/PartnerDiscovery';
import { LabIdSource } from './NodeCrypto';
import { VirtualNetwork } from './VirtualNetwork';

type ActiveService = {
  owner: SimulatedDiscovery;
  service: ResolvedPartnerService;
};

export class SimulatedDiscoveryFabric {
  private nextPort = 42000;
  private nextService = 1;
  private readonly probes = new Map<string, SimulatedDiscovery>();
  private readonly services = new Map<string, ActiveService>();
  controlFabric?: { hasEndpoint(host: string, port: number): boolean };

  constructor(readonly network: VirtualNetwork) {}

  removeServicesForHost(host: string): void {
    const toRemove: string[] = [];
    for (const [name, active] of this.services.entries()) {
      if (active.service.host === host) toRemove.push(name);
    }
    for (const name of toRemove) {
      const active = this.services.get(name);
      if (!active) continue;
      this.services.delete(name);
      for (const other of this.services.values()) {
        this.network.transmit('discovery', 32, () => other.owner.emit({ type: 'service_lost', serviceName: name }));
      }
    }
  }

  allocateProbe(owner: SimulatedDiscovery): number {
    const port = this.nextPort++;
    this.probes.set(`${owner.host}:${port}`, owner);
    return port;
  }

  removeProbe(host: string, port: number): void {
    this.probes.delete(`${host}:${port}`);
  }

  hasProbe(host: string, port: number): boolean {
    return this.probes.has(`${host}:${port}`);
  }

  register(owner: SimulatedDiscovery, preparation: DiscoveryAdvertisementPreparation, peerHint: string, proof: string): DiscoveryRegistration {
    const serviceName = `PartnerScreen-Lab-${this.nextService++}`;
    const service: ResolvedPartnerService = {
      serviceName,
      host: preparation.host,
      port: preparation.port,
      peerHint,
      nonce: preparation.nonce,
      proof,
    };
    this.services.set(serviceName, { owner, service });

    for (const active of this.services.values()) {
      if (active.owner === owner) continue;
      this.deliverResolved(active.owner, service);
      this.deliverResolved(owner, active.service);
    }
    return { serviceName };
  }

  unregister(owner: SimulatedDiscovery, serviceName: string | null): void {
    if (!serviceName) return;
    const active = this.services.get(serviceName);
    if (!active || active.owner !== owner) return;
    this.services.delete(serviceName);
    for (const other of this.services.values()) {
      this.network.transmit('discovery', 32, () => other.owner.emit({ type: 'service_lost', serviceName }));
    }
  }

  private deliverResolved(target: SimulatedDiscovery, service: ResolvedPartnerService): void {
    const bytes = Buffer.byteLength(JSON.stringify(service), 'utf8');
    this.network.transmit('discovery', bytes, () => target.emit({ type: 'service_resolved', service }));
  }
}

/** Android NSD stand-in; AvailabilityService itself remains the production implementation. */
export class SimulatedDiscovery implements PartnerDiscovery {
  private readonly listeners = new Set<(event: PartnerDiscoveryEvent) => void>();
  private readonly ids: LabIdSource;
  private preparation: DiscoveryAdvertisementPreparation | null = null;
  private serviceName: string | null = null;

  constructor(readonly host: string, readonly fabric: SimulatedDiscoveryFabric, seed: string) {
    this.ids = new LabIdSource(seed);
  }

  async prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation> {
    if (this.preparation) throw new Error('Simulated discovery is already prepared.');
    const port = this.fabric.allocateProbe(this);
    this.preparation = {
      advertisementId: this.ids.uuid(),
      host: this.host,
      port,
      nonce: this.ids.hex(16),
    };
    return this.preparation;
  }

  async start(advertisementId: string, peerHint: string, proof: string): Promise<DiscoveryRegistration> {
    const preparation = this.preparation;
    if (!preparation || preparation.advertisementId !== advertisementId) throw new Error('Simulated discovery preparation is stale.');
    const registration = this.fabric.register(this, preparation, peerHint, proof);
    this.serviceName = registration.serviceName;
    return registration;
  }

  async probe(host: string, port: number): Promise<void> {
    // P0-A: PairedAvailable requires proof of the exact CONTROL endpoint, not the NSD probe socket.
    // The discovery probe port (42000+) is distinct from the control port (44000+). After the fix,
    // AvailabilityService probes host:controlPort, which must be checked against the control fabric
    // rather than the discovery probe registry. Accept either a discovery probe or a live control
    // endpoint as reachable; otherwise the endpoint is stale and availability must stay offline.
    const isDiscoveryProbe = this.fabric.hasProbe(host, port);
    const isControlEndpoint = this.fabric.controlFabric?.hasEndpoint(host, port) ?? false;
    if (!isDiscoveryProbe && !isControlEndpoint) throw new Error('Simulated discovery probe endpoint is stale.');
    await new Promise<void>((resolve, reject) => {
      const sent = this.fabric.network.transmit('discovery', 8, resolve);
      if (!sent) reject(new Error('Simulated discovery probe is unreachable.'));
    });
  }

  async stop(): Promise<void> {
    this.fabric.unregister(this, this.serviceName);
    this.serviceName = null;
    if (this.preparation) this.fabric.removeProbe(this.preparation.host, this.preparation.port);
    this.preparation = null;
  }

  subscribe(listener: (event: PartnerDiscoveryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PartnerDiscoveryEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  currentProbe(): { host: string; port: number } | null {
    return this.preparation ? { host: this.preparation.host, port: this.preparation.port } : null;
  }

  makeProbeStale(): void {
    if (this.preparation) this.fabric.removeProbe(this.preparation.host, this.preparation.port);
  }
}
