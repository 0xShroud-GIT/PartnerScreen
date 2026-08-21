import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { PairTrustMetadata } from '../domain/pairing/PairTrustRepository';
import type { HmacDiscoveryAuthenticator } from '../domain/discovery/TrustedDiscoveryAuthenticator';
import type {
  DiscoveryAdvertisementPreparation,
  PartnerDiscovery,
  PartnerDiscoveryEvent,
  ResolvedPartnerService,
} from '../platform/discovery/PartnerDiscovery';

export type AvailabilitySnapshot =
  | { kind: 'inactive' }
  | { kind: 'starting'; pair: PairTrustMetadata }
  | { kind: 'offline'; pair: PairTrustMetadata; localAdvertised: boolean; message?: string }
  | { kind: 'available'; pair: PairTrustMetadata; endpoint: { host: string; port: number }; serviceName: string };

export interface PairSecretSource { loadPairSecret(): Promise<string>; }
export interface AvailabilityDiagnostics { append(kind: DiagnosticEventKind): Promise<void>; }
export interface ControlListenerSource {
  ensureListening(expectedHost?: string): Promise<{ host: string; port: number }>;
  /** Notified whenever the local control listening socket is replaced/invalidated. */
  subscribeListenerChanges?(listener: () => void): () => void;
}

interface ActiveAvailability {
  generation: number;
  pair: PairTrustMetadata;
  pairSecretHex: string;
  preparation: DiscoveryAdvertisementPreparation;
  localServiceName: string;
  matchedServiceName: string | null;
}

const SAFE_START_MESSAGES = new Set([
  'Trusted availability authentication could not be prepared.',
  'Trusted availability needs an active private IPv4 Wi-Fi network.',
  'PartnerScreen could not prepare local availability.',
  'PartnerScreen could not advertise and discover trusted availability on this Wi-Fi.',
  'PartnerScreen control listener is unavailable.',
]);
const GENERIC_START_MESSAGE = 'Trusted availability could not start. Check that both phones are on the same Wi-Fi, then retry.';
function safeAvailabilityStartMessage(error: unknown): string {
  if (error instanceof Error && SAFE_START_MESSAGES.has(error.message)) return error.message;
  return GENERIC_START_MESSAGE;
}

export class AvailabilityService {
  private state: AvailabilitySnapshot = { kind: 'inactive' };
  private readonly listeners = new Set<() => void>();
  private operationQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private active: ActiveAvailability | null = null;
  private lastPair: PairTrustMetadata | null = null;
  private readonly unsubscribeDiscovery: () => void;
  private readonly unsubscribeControlListener: () => void;

  constructor(
    private readonly pairSecrets: PairSecretSource,
    private readonly diagnostics: AvailabilityDiagnostics,
    private readonly discovery: PartnerDiscovery,
    private readonly authenticator: HmacDiscoveryAuthenticator,
    private readonly controlListener: ControlListenerSource,
  ) {
    this.unsubscribeDiscovery = this.discovery.subscribe((event) => { void this.enqueue(() => this.handleDiscoveryEvent(event)).catch(() => undefined); });
    // When the local control listener is replaced/invalidated, the advertisement's authenticated
    // control port may be stale. Re-run activation (force) to stop the old advertisement, obtain a
    // fresh listener bound to the current Wi-Fi host, and re-advertise with a fresh control port.
    this.unsubscribeControlListener = this.controlListener.subscribeListenerChanges?.(() => {
      const pair = this.lastPair ?? this.active?.pair;
      if (pair) void this.enqueue(() => this.activateNow(pair, true)).catch(() => undefined);
    }) ?? (() => undefined);
  }

  getSnapshot = (): AvailabilitySnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  activate(pair: PairTrustMetadata): Promise<void> { this.lastPair = pair; return this.enqueue(() => this.activateNow(pair)); }
  retry(): Promise<void> { const pair = this.lastPair; return pair ? this.enqueue(() => this.activateNow(pair, true)) : Promise.resolve(); }
  deactivate(): Promise<void> { this.lastPair = null; return this.enqueue(async () => { await this.stopActive(true); this.setState({ kind: 'inactive' }); }); }
  dispose(): void { this.unsubscribeDiscovery(); this.unsubscribeControlListener(); void this.discovery.stop().catch(() => undefined); }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async activateNow(pair: PairTrustMetadata, force = false): Promise<void> {
    if (!force && this.active?.pair.pairId === pair.pairId) return;
    await this.stopActive(false);
    this.setState({ kind: 'starting', pair });
    const generation = ++this.generation;
    try {
      const pairSecretHex = await this.pairSecrets.loadPairSecret();
      // Prepare the current Wi-Fi advertisement/host first, then ensure the control listener is bound
      // for that exact host (rebinding when the Wi-Fi host changed). Reusing a stale listener from an
      // older Wi-Fi host is what previously wedged inbound requests after Wi-Fi interruption/re-IP.
      const preparation = await this.discovery.prepareAdvertisement();
      const controlEndpoint = await this.controlListener.ensureListening(preparation.host);
      if (controlEndpoint.host !== preparation.host) throw new Error('PartnerScreen control listener is unavailable.');
      const peerHint = await this.authenticator.derivePeerHint(pairSecretHex, preparation.nonce);
      const proof = await this.authenticator.createProof(pairSecretHex, { ...preparation, controlPort: controlEndpoint.port });
      const registration = await this.discovery.start(preparation.advertisementId, peerHint, proof);
      if (generation !== this.generation) { await this.discovery.stop().catch(() => undefined); return; }
      this.active = { generation, pair, pairSecretHex, preparation, localServiceName: registration.serviceName, matchedServiceName: null };
      this.setState({ kind: 'offline', pair, localAdvertised: true });
      await this.record('availability_started');
    } catch (error) {
      if (generation !== this.generation) return;
      await this.discovery.stop().catch(() => undefined);
      this.active = null;
      this.setState({ kind: 'offline', pair, localAdvertised: false, message: safeAvailabilityStartMessage(error) });
      await this.record('availability_failed');
    }
  }

  private async stopActive(recordStop: boolean): Promise<void> {
    const hadActive = this.active !== null;
    this.generation += 1;
    this.active = null;
    try { await this.discovery.stop(); } catch { await this.record('availability_failed'); }
    if (hadActive && recordStop) await this.record('availability_stopped');
  }

  private async handleDiscoveryEvent(event: PartnerDiscoveryEvent): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (event.type === 'service_resolved') { await this.handleResolved(active, event.service); return; }
    if (event.type === 'service_lost') {
      if (active.matchedServiceName !== event.serviceName) return;
      active.matchedServiceName = null;
      this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true });
      await this.record('availability_partner_lost');
      return;
    }
    active.matchedServiceName = null;
    this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true, message: 'Trusted discovery reported a local network error. PartnerScreen will remain fail-closed until the partner is proven reachable again.' });
    await this.record('availability_failed');
  }

  private async handleResolved(active: ActiveAvailability, service: ResolvedPartnerService): Promise<void> {
    if (active.generation !== this.generation || service.serviceName === active.localServiceName) return;
    if (service.host === active.preparation.host && service.port === active.preparation.port && service.nonce.toLowerCase() === active.preparation.nonce.toLowerCase()) return;
    const controlPort = this.authenticator.extractControlPort(service.proof);
    if (controlPort === null) return;
    const trustedHint = await this.authenticator.verifyPeerHint(active.pairSecretHex, service.nonce, service.peerHint);
    if (!trustedHint || active.generation !== this.generation) return;
    const validProof = await this.authenticator.verifyProof(active.pairSecretHex, {
      nonce: service.nonce, host: service.host, port: service.port, controlPort,
    }, service.proof);
    if (!validProof || active.generation !== this.generation) return;
    try { await this.discovery.probe(service.host, service.port); }
    catch { await this.record('availability_probe_failed'); return; }
    if (active.generation !== this.generation) return;
    const changed = active.matchedServiceName !== service.serviceName;
    active.matchedServiceName = service.serviceName;
    this.setState({ kind: 'available', pair: active.pair, endpoint: { host: service.host, port: controlPort }, serviceName: service.serviceName });
    if (changed) await this.record('availability_partner_found');
  }

  private async record(kind: DiagnosticEventKind): Promise<void> { try { await this.diagnostics.append(kind); } catch { /* diagnostics never own availability */ } }
  private setState(next: AvailabilitySnapshot): void { this.state = next; for (const listener of this.listeners) listener(); }
}
