import type { PairingListenerEndpoint, PairingTransportEvent } from '../../modules/partner-pairing-transport';
import type { ControlListenerEndpoint, ControlTransport, ControlTransportEvent } from '../../src/platform/control/ControlTransport';
import type { PairingTransport } from '../../src/platform/pairing/ExpoPairingTransport';
import { LabIdSource } from './NodeCrypto';
import { VirtualNetwork } from './VirtualNetwork';

type ControlLink = { peer: SimulatedControlTransport; peerConnectionId: string };

type ControlRegistration = {
  transport: SimulatedControlTransport;
  endpoint: ControlListenerEndpoint;
};

export class SimulatedControlFabric {
  private nextPort = 44000;
  private readonly registrations = new Map<string, ControlRegistration>();
  /** Native-process-owned endpoint state. A full process death clears this map. */
  private readonly serviceEndpoints = new Map<string, ControlListenerEndpoint>();
  private readonly ids = new LabIdSource('runtime-lab-control-fabric');
  discoveryFabric?: { removeServicesForHost(host: string): void };

  constructor(readonly network: VirtualNetwork) {}

  hasEndpoint(host: string, port: number): boolean {
    return this.registrations.has(`${host}:${port}`) || this.serviceEndpoints.get(host)?.port === port;
  }

  allocate(transport: SimulatedControlTransport): ControlListenerEndpoint {
    if (transport.trustedPresenceActive) {
      const existing = this.serviceEndpoints.get(transport.host);
      if (existing) {
        this.registrations.set(`${existing.host}:${existing.port}`, { transport, endpoint: existing });
        return existing;
      }
    }
    const endpoint = { listenerId: this.ids.uuid(), host: transport.host, port: this.nextPort++ };
    this.registrations.set(`${endpoint.host}:${endpoint.port}`, { transport, endpoint });
    return endpoint;
  }

  allocateServiceEndpoint(host: string): ControlListenerEndpoint {
    const existing = this.serviceEndpoints.get(host);
    if (existing) return existing;
    const endpoint = { listenerId: this.ids.uuid(), host, port: this.nextPort++ };
    this.serviceEndpoints.set(host, endpoint);
    return endpoint;
  }

  getServiceEndpoint(host: string): ControlListenerEndpoint | null {
    return this.serviceEndpoints.get(host) ?? null;
  }

  release(endpoint: ControlListenerEndpoint): void {
    this.registrations.delete(`${endpoint.host}:${endpoint.port}`);
    const serviceEndpoint = this.serviceEndpoints.get(endpoint.host);
    if (serviceEndpoint?.listenerId === endpoint.listenerId) this.serviceEndpoints.delete(endpoint.host);
  }

  releaseServiceEndpoint(host: string): void {
    const endpoint = this.serviceEndpoints.get(host);
    if (!endpoint) return;
    this.serviceEndpoints.delete(host);
    this.registrations.delete(`${endpoint.host}:${endpoint.port}`);
  }

  makeEndpointStale(endpoint: ControlListenerEndpoint): void {
    this.release(endpoint);
    this.discoveryFabric?.removeServicesForHost(endpoint.host);
  }

  connect(source: SimulatedControlTransport, host: string, port: number): string {
    this.network.requireReachable('control', 'Simulated control network is unreachable.');
    const registration = this.registrations.get(`${host}:${port}`);
    if (!registration) throw new Error('Simulated control endpoint is stale or unreachable.');
    const localId = this.ids.uuid();
    const remoteId = this.ids.uuid();
    source.links.set(localId, { peer: registration.transport, peerConnectionId: remoteId });
    registration.transport.links.set(remoteId, { peer: source, peerConnectionId: localId });

    this.network.transmit('control', 32, () => {
      source.emit({ type: 'connected', connectionId: localId, direction: 'outbound' });
      registration.transport.emit({
        type: 'connected',
        connectionId: remoteId,
        direction: 'inbound',
        listenerId: registration.endpoint.listenerId,
      });
    });
    return localId;
  }
}

export class SimulatedControlTransport implements ControlTransport {
  readonly links = new Map<string, ControlLink>();
  private readonly callbacks = new Set<(event: ControlTransportEvent) => void>();
  endpoint: ControlListenerEndpoint | null = null;
  startCount = 0;
  stopCount = 0;
  trustedPresenceActive = false;

  constructor(readonly host: string, readonly fabric: SimulatedControlFabric) {}

  async startTrustedPresence(): Promise<void> {
    this.trustedPresenceActive = true;
    if (!this.fabric.getServiceEndpoint(this.host)) this.fabric.allocateServiceEndpoint(this.host);
  }

  async stopTrustedPresence(): Promise<void> {
    this.trustedPresenceActive = false;
    this.fabric.releaseServiceEndpoint(this.host);
  }

  async startListener(): Promise<ControlListenerEndpoint> {
    this.startCount += 1;
    this.endpoint = this.fabric.allocate(this);
    return this.endpoint;
  }

  async stopListener(listenerId: string): Promise<void> {
    this.stopCount += 1;
    if (this.endpoint?.listenerId !== listenerId) return;
    this.fabric.release(this.endpoint);
    this.endpoint = null;
  }

  async connect(host: string, port: number): Promise<string> {
    return this.fabric.connect(this, host, port);
  }

  async send(connectionId: string, frame: string): Promise<void> {
    const link = this.links.get(connectionId);
    if (!link) throw new Error('Simulated control connection is closed.');
    const delivered = this.fabric.network.transmit('control', Buffer.byteLength(frame, 'utf8'), () => {
      link.peer.emit({ type: 'message', connectionId: link.peerConnectionId, frame });
    });
    if (!delivered) {
      this.emit({ type: 'error', code: 'connection_failed', connectionId });
      throw new Error('Simulated control send failed.');
    }
  }

  async close(connectionId: string): Promise<void> {
    const link = this.links.get(connectionId);
    if (!link) return;
    this.links.delete(connectionId);
    link.peer.links.delete(link.peerConnectionId);
    this.fabric.network.transmit('control', 8, () => {
      this.emit({ type: 'closed', connectionId });
      link.peer.emit({ type: 'closed', connectionId: link.peerConnectionId });
    });
  }

  subscribe(listener: (event: ControlTransportEvent) => void): () => void {
    this.callbacks.add(listener);
    return () => this.callbacks.delete(listener);
  }

  emit(event: ControlTransportEvent): void {
    for (const callback of this.callbacks) callback(event);
  }

  failCurrentListener(): void {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    this.fabric.release(endpoint);
    this.endpoint = null;
    this.emit({ type: 'error', code: 'listener_failed', listenerId: endpoint.listenerId });
  }

  /** Activity/UI recreation does not kill the process-scoped native listener or JS authority. */
  recreateActivity(): void {
    // Deliberately no transport mutation. UI lifecycle is outside the transport authority.
  }

  /** Full app-process death destroys JS callbacks, sockets, links and native-process service state. */
  killProcess(): void {
    const endpoint = this.endpoint;
    if (endpoint) this.fabric.release(endpoint);
    this.endpoint = null;
    for (const [connectionId, link] of [...this.links.entries()]) {
      this.links.delete(connectionId);
      link.peer.links.delete(link.peerConnectionId);
      link.peer.emit({ type: 'closed', connectionId: link.peerConnectionId });
    }
    this.callbacks.clear();
    this.fabric.releaseServiceEndpoint(this.host);
    this.trustedPresenceActive = false;
  }

  callbackCount(): number {
    return this.callbacks.size;
  }
}

type PairingLink = { peer: SimulatedPairingTransport; peerConnectionId: string };

type PairingRegistration = {
  transport: SimulatedPairingTransport;
  endpoint: PairingListenerEndpoint;
};

export class SimulatedPairingFabric {
  private nextPort = 43000;
  private readonly registrations = new Map<string, PairingRegistration>();
  private readonly ids = new LabIdSource('runtime-lab-pairing-fabric');

  constructor(readonly network: VirtualNetwork) {}

  allocate(transport: SimulatedPairingTransport): PairingListenerEndpoint {
    const endpoint = { listenerId: this.ids.uuid(), host: transport.host, port: this.nextPort++ };
    this.registrations.set(`${endpoint.host}:${endpoint.port}`, { transport, endpoint });
    return endpoint;
  }

  release(endpoint: PairingListenerEndpoint): void {
    this.registrations.delete(`${endpoint.host}:${endpoint.port}`);
  }

  connect(source: SimulatedPairingTransport, host: string, port: number): string {
    this.network.requireReachable('pairing', 'Simulated pairing network is unreachable.');
    const registration = this.registrations.get(`${host}:${port}`);
    if (!registration) throw new Error('Simulated pairing endpoint is unreachable.');
    const localId = this.ids.uuid();
    const remoteId = this.ids.uuid();
    source.links.set(localId, { peer: registration.transport, peerConnectionId: remoteId });
    registration.transport.links.set(remoteId, { peer: source, peerConnectionId: localId });
    this.network.transmit('pairing', 32, () => {
      source.emit({ type: 'connected', connectionId: localId });
      registration.transport.emit({ type: 'connected', connectionId: remoteId, listenerId: registration.endpoint.listenerId });
    });
    return localId;
  }
}

export class SimulatedPairingTransport implements PairingTransport {
  readonly links = new Map<string, PairingLink>();
  private readonly callbacks = new Set<(event: PairingTransportEvent) => void>();
  endpoint: PairingListenerEndpoint | null = null;

  constructor(readonly host: string, readonly fabric: SimulatedPairingFabric) {}

  async startListener(): Promise<PairingListenerEndpoint> {
    this.endpoint = this.fabric.allocate(this);
    return this.endpoint;
  }

  async stopListener(listenerId: string): Promise<void> {
    if (this.endpoint?.listenerId !== listenerId) return;
    this.fabric.release(this.endpoint);
    this.endpoint = null;
  }

  async connect(host: string, port: number): Promise<string> {
    return this.fabric.connect(this, host, port);
  }

  async send(connectionId: string, frame: string): Promise<void> {
    const link = this.links.get(connectionId);
    if (!link) throw new Error('Simulated pairing connection is closed.');
    const delivered = this.fabric.network.transmit('pairing', Buffer.byteLength(frame, 'utf8'), () => {
      link.peer.emit({ type: 'message', connectionId: link.peerConnectionId, frame });
    });
    if (!delivered) throw new Error('Simulated pairing send failed.');
  }

  async close(connectionId: string): Promise<void> {
    const link = this.links.get(connectionId);
    if (!link) return;
    this.links.delete(connectionId);
    link.peer.links.delete(link.peerConnectionId);
    this.fabric.network.transmit('pairing', 8, () => {
      this.emit({ type: 'closed', connectionId });
      link.peer.emit({ type: 'closed', connectionId: link.peerConnectionId });
    });
  }

  subscribe(listener: (event: PairingTransportEvent) => void): () => void {
    this.callbacks.add(listener);
    return () => this.callbacks.delete(listener);
  }

  emit(event: PairingTransportEvent): void {
    for (const callback of this.callbacks) callback(event);
  }
}
