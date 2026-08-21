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
  private readonly ids = new LabIdSource('runtime-lab-control-fabric');

  constructor(readonly network: VirtualNetwork) {}

  allocate(transport: SimulatedControlTransport): ControlListenerEndpoint {
    const endpoint = { listenerId: this.ids.uuid(), host: transport.host, port: this.nextPort++ };
    this.registrations.set(`${endpoint.host}:${endpoint.port}`, { transport, endpoint });
    return endpoint;
  }

  release(endpoint: ControlListenerEndpoint): void {
    this.registrations.delete(`${endpoint.host}:${endpoint.port}`);
  }

  makeEndpointStale(endpoint: ControlListenerEndpoint): void {
    this.release(endpoint);
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

  constructor(readonly host: string, readonly fabric: SimulatedControlFabric) {}

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
    // TCP either eventually delivers or the connection fails; deterministic packet loss is surfaced as a transport error.
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
