import type { DiagnosticsRepository } from '../../src/domain/diagnostics/DiagnosticsRepository';
import type { DiagnosticEventKind } from '../../src/domain/diagnostics/DiagnosticEvent';
import { HmacDiscoveryAuthenticator } from '../../src/domain/discovery/TrustedDiscoveryAuthenticator';
import type { IdentityRepository } from '../../src/domain/identity/IdentityRepository';
import type { LocalDeviceIdentity } from '../../src/domain/identity/LocalDeviceIdentity';
import { PairTrustRepository } from '../../src/domain/pairing/PairTrustRepository';
import type { KeyValueStore } from '../../src/domain/persistence/KeyValueStore';
import type { SecretStore } from '../../src/domain/security/SecretStore';
import { PairingService } from '../../src/application/PairingService';
import { AvailabilityService } from '../../src/availability/AvailabilityService';
import { ControlSession } from '../../src/control/ControlSession';
import { ScreenCaptureCoordinator } from '../../src/capture/ScreenCaptureCoordinator';
import { MediaSessionController } from '../../src/media/MediaSessionController';
import type { PendingRequestRecord } from '../../src/request/PendingRequestStore';
import { IncomingRequestNotifier } from '../../src/request/IncomingRequestNotifier';
import { SessionController, type PendingRequestPersistence } from '../../src/session/SessionController';
import { AuthenticatedSignalingCipher } from '../../src/security/AuthenticatedSignalingCipher';
import { RuntimeInvariantMonitor } from '../../src/runtime/RuntimeInvariantMonitor';
import { LabIdSource, NodeAes, NodeHmac, NodePairingCrypto } from './NodeCrypto';
import { SimulatedDiscovery, SimulatedDiscoveryFabric } from './SimulatedDiscovery';
import {
  SimulatedCapturePort,
  SimulatedMediaFabric,
  SimulatedMediaPort,
  SimulatedNotificationPort,
} from './SimulatedPlatforms';
import {
  SimulatedControlFabric,
  SimulatedControlTransport,
  SimulatedPairingFabric,
  SimulatedPairingTransport,
} from './SimulatedTransports';
import { VirtualClock, settleMicrotasks } from './VirtualClock';
import { VirtualNetwork } from './VirtualNetwork';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setString(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async remove(key: string): Promise<void> { this.values.delete(key); }
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  async getSecret(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async deleteSecret(key: string): Promise<void> { this.values.delete(key); }
}

class MemoryPendingRequests implements PendingRequestPersistence {
  saved: PendingRequestRecord | null = null;
  async clearOnStartup(): Promise<void> { this.saved = null; }
  async clear(): Promise<void> { this.saved = null; }
  async save(record: PendingRequestRecord): Promise<void> { this.saved = record; }
}

export class LabDiagnostics {
  readonly events: DiagnosticEventKind[] = [];
  async append(kind: DiagnosticEventKind): Promise<void> { this.events.push(kind); }
  count(kind: DiagnosticEventKind): number { return this.events.filter((event) => event === kind).length; }
}

function identityRepository(identity: LocalDeviceIdentity): IdentityRepository {
  return {
    bootstrap: async () => ({ identity, created: false }),
  } as unknown as IdentityRepository;
}

function pairingDiagnostics(value: LabDiagnostics): DiagnosticsRepository {
  return value as unknown as DiagnosticsRepository;
}

export interface SimulatedDeviceOptions {
  name: string;
  deviceId: string;
  host: string;
  seed: string;
}

export class SimulatedDevice {
  readonly diagnostics = new LabDiagnostics();
  readonly pairTrustRepository = new PairTrustRepository(new MemoryStore(), new MemorySecrets());
  readonly pairingTransport: SimulatedPairingTransport;
  readonly controlTransport: SimulatedControlTransport;
  readonly discovery: SimulatedDiscovery;
  readonly notificationPort = new SimulatedNotificationPort();
  readonly capturePort: SimulatedCapturePort;
  readonly mediaPort: SimulatedMediaPort;
  readonly pairingService: PairingService;
  readonly controlSession: ControlSession;
  readonly availabilityService: AvailabilityService;
  readonly sessionController: SessionController;
  readonly screenCaptureCoordinator: ScreenCaptureCoordinator;
  readonly mediaSessionController: MediaSessionController;
  readonly incomingRequestNotifier: IncomingRequestNotifier;
  readonly invariants = new RuntimeInvariantMonitor(true);

  rendererDelayMs = 0;
  autoRender = true;

  private pairLifecycle: Promise<void> = Promise.resolve();
  private readonly identity: LocalDeviceIdentity;
  private readonly unsubscribePairing: () => void;
  private readonly unsubscribeAvailability: () => void;
  private readonly unsubscribeMediaRender: () => void;
  private readonly unsubscribeInvariantSession: () => void;
  private readonly unsubscribeInvariantCapture: () => void;
  private readonly unsubscribeInvariantMedia: () => void;
  private sessionClaim: (() => void) | null = null;
  private captureClaim: (() => void) | null = null;
  private peerClaim: (() => void) | null = null;
  private rendererClaim: (() => void) | null = null;
  private claimedSessionId: string | null = null;
  private claimedCaptureId: string | null = null;
  private claimedPeerId: string | null = null;
  private claimedRendererKey: string | null = null;
  private readonly firstFrameKeys = new Set<string>();
  private viewerSessionId: string | null = null;
  private viewerRelease: (() => void) | null = null;

  constructor(
    readonly options: SimulatedDeviceOptions,
    readonly clock: VirtualClock,
    pairingFabric: SimulatedPairingFabric,
    controlFabric: SimulatedControlFabric,
    discoveryFabric: SimulatedDiscoveryFabric,
    mediaFabric: SimulatedMediaFabric,
  ) {
    this.identity = {
      schemaVersion: 1,
      deviceId: options.deviceId,
      deviceName: options.name,
      createdAt: clock.nowDate().toISOString(),
      updatedAt: clock.nowDate().toISOString(),
    };

    this.pairingTransport = new SimulatedPairingTransport(options.host, pairingFabric);
    this.controlTransport = new SimulatedControlTransport(options.host, controlFabric);
    this.discovery = new SimulatedDiscovery(options.host, discoveryFabric, `${options.seed}:discovery`);
    this.capturePort = new SimulatedCapturePort(clock);
    this.mediaPort = new SimulatedMediaPort(options.host, mediaFabric, clock);

    const identityRepo = identityRepository(this.identity);
    this.pairingService = new PairingService(
      identityRepo,
      this.pairTrustRepository,
      pairingDiagnostics(this.diagnostics),
      this.pairingTransport,
      new NodePairingCrypto(new LabIdSource(`${options.seed}:pairing-crypto`)),
      clock.nowDate,
      clock,
    );

    this.controlSession = new ControlSession(
      this.controlTransport,
      new AuthenticatedSignalingCipher(
        new NodeAes(new LabIdSource(`${options.seed}:control-aes`)),
        new NodeHmac(),
      ),
      clock.nowMs,
    );
    this.sessionController = new SessionController(
      identityRepo,
      this.pairTrustRepository,
      new MemoryPendingRequests(),
      this.controlSession,
      this.diagnostics,
      clock.nowMs,
      clock,
    );
    this.screenCaptureCoordinator = new ScreenCaptureCoordinator(this.capturePort, this.sessionController, this.diagnostics);
    this.mediaSessionController = new MediaSessionController(
      this.mediaPort,
      this.sessionController,
      this.screenCaptureCoordinator,
      this.diagnostics,
      clock,
      clock.nowMs,
    );
    this.availabilityService = new AvailabilityService(
      this.pairTrustRepository,
      this.diagnostics,
      this.discovery,
      new HmacDiscoveryAuthenticator(new NodeHmac()),
      this.controlSession,
    );
    this.incomingRequestNotifier = new IncomingRequestNotifier(this.sessionController, this.notificationPort, this.diagnostics);

    this.unsubscribeAvailability = this.availabilityService.subscribe(() => {
      this.sessionController.updateAvailability(this.availabilityService.getSnapshot());
    });

    this.unsubscribePairing = this.pairingService.subscribe(() => {
      this.pairLifecycle = this.pairLifecycle.then(async () => {
        const state = this.pairingService.getSnapshot();
        if (state.kind === 'paired') {
          await this.sessionController.activatePair(state.pair);
          await this.availabilityService.activate(state.pair);
          this.sessionController.updateAvailability(this.availabilityService.getSnapshot());
        } else if (state.kind === 'unpaired') {
          await this.availabilityService.deactivate();
          await this.sessionController.deactivatePair();
        }
      }).catch(() => undefined);
    });

    this.unsubscribeMediaRender = this.mediaSessionController.subscribe(() => this.maybeScheduleFirstFrame());
    this.unsubscribeInvariantSession = this.sessionController.subscribe(() => this.refreshInvariants());
    this.unsubscribeInvariantCapture = this.screenCaptureCoordinator.subscribe(() => this.refreshInvariants());
    this.unsubscribeInvariantMedia = this.mediaSessionController.subscribe(() => this.refreshInvariants());
  }

  async initialize(): Promise<void> {
    await this.pairingService.initialize();
    await this.pairLifecycle;
    this.refreshInvariants();
  }

  async acceptIncomingAndStartCapture(): Promise<void> {
    await this.sessionController.acceptRequest();
    await this.screenCaptureCoordinator.requestForConnectedSharer();
  }

  beginAcceptIncomingAndStartCapture(): Promise<void> {
    return (async () => {
      await this.sessionController.acceptRequest();
      await this.screenCaptureCoordinator.requestForConnectedSharer();
    })();
  }

  openViewer(): boolean {
    const state = this.sessionController.getSnapshot();
    if (state.type !== 'Connected' || state.role !== 'requester') return false;
    if (this.viewerSessionId === state.sessionId) return false;
    this.closeViewer();
    this.viewerSessionId = state.sessionId;
    this.viewerRelease = this.invariants.claim('viewer', state.sessionId, 1);
    return true;
  }

  closeViewer(): void {
    this.viewerRelease?.();
    this.viewerRelease = null;
    this.viewerSessionId = null;
  }

  forceDuplicateViewerForInvariantTest(): void {
    const state = this.sessionController.getSnapshot();
    if (state.type !== 'Connected' || state.role !== 'requester') throw new Error('Requester session required.');
    const release = this.invariants.claim('viewer', state.sessionId, 1);
    release();
  }

  currentSessionId(): string | null {
    const state = this.sessionController.getSnapshot();
    return state.type === 'OutgoingRequest' || state.type === 'IncomingRequest' || state.type === 'Connected' ? state.sessionId : null;
  }

  async waitForPairLifecycle(): Promise<void> {
    await this.pairLifecycle;
  }

  dispose(): void {
    this.closeViewer();
    this.unsubscribeInvariantMedia();
    this.unsubscribeInvariantCapture();
    this.unsubscribeInvariantSession();
    this.unsubscribeMediaRender();
    this.unsubscribeAvailability();
    this.unsubscribePairing();
    this.incomingRequestNotifier.dispose();
    this.mediaSessionController.dispose();
    this.screenCaptureCoordinator.dispose();
    this.availabilityService.dispose();
    this.sessionController.dispose();
    this.controlSession.dispose();
    this.releaseAllClaims();
  }

  private maybeScheduleFirstFrame(): void {
    if (!this.autoRender) return;
    const state = this.mediaSessionController.getSnapshot();
    if (state.type !== 'remote_track_attached') return;
    const key = `${state.sessionId}:${state.trackEpoch}`;
    if (this.firstFrameKeys.has(key)) return;
    this.firstFrameKeys.add(key);
    this.clock.schedule(this.rendererDelayMs, () => {
      const latest = this.mediaSessionController.getSnapshot();
      if (latest.type !== 'remote_track_attached' || latest.sessionId !== state.sessionId || latest.trackEpoch !== state.trackEpoch) return;
      this.firstFrameKeys.add(key);
      void this.mediaSessionController.rendererFirstFrame(state.sessionId, state.trackEpoch).catch(() => undefined);
    });
  }

  assertNotificationInvariantNow(): void {
    const session = this.sessionController.getSnapshot();
    const incoming = session.type === 'IncomingRequest' ? session.sessionId : null;
    this.invariants.assertNotification(incoming, this.notificationPort.shownSessionId);
  }

  private refreshInvariants(): void {
    const session = this.sessionController.getSnapshot();
    const sessionId = session.type === 'Connected' ? session.sessionId : null;
    if (sessionId !== this.claimedSessionId) {
      this.sessionClaim?.();
      this.sessionClaim = sessionId ? this.invariants.activateSession(sessionId) : null;
      this.claimedSessionId = sessionId;
      if (!sessionId) this.closeViewer();
    }

    const capture = this.screenCaptureCoordinator.getSnapshot();
    const captureId = capture.type === 'requesting_consent' || capture.type === 'starting' || capture.type === 'capturing' ? capture.sessionId : null;
    if (captureId !== this.claimedCaptureId) {
      this.captureClaim?.();
      this.captureClaim = captureId ? this.invariants.claim('capture', captureId, 1) : null;
      this.claimedCaptureId = captureId;
    }

    const media = this.mediaSessionController.getSnapshot();
    const mediaId = media.type === 'negotiating' || media.type === 'publishing' || media.type === 'remote_track_attached' || media.type === 'live' || media.type === 'reconnecting' ? media.sessionId : null;
    if (mediaId !== this.claimedPeerId) {
      this.peerClaim?.();
      this.peerClaim = mediaId ? this.invariants.claim('peer_connection', mediaId, 1) : null;
      this.claimedPeerId = mediaId;
    }

    const rendererKey = media.type === 'remote_track_attached' || media.type === 'live' ? `${media.sessionId}:${media.trackEpoch}` : null;
    if (rendererKey !== this.claimedRendererKey) {
      this.rendererClaim?.();
      this.rendererClaim = rendererKey ? this.invariants.claim('renderer', rendererKey, 1) : null;
      this.claimedRendererKey = rendererKey;
    }

    if (media.type === 'live') {
      this.invariants.assertLive(this.firstFrameKeys.has(`${media.sessionId}:${media.trackEpoch}`), media.sessionId);
    }

    // Notification clearing is async (IncomingRequestNotifier uses an operation queue).
    // When a session leaves IncomingRequest, the native notification clear is enqueued
    // and completes on the next microtask. Failing synchronously on every setState would
    // flag a transient as a violation before the clear has run. Instead, assert immediately
    // only while an IncomingRequest is active (where a wrong non-null notification is always
    // a bug), and defer the "stale notification after leaving IncomingRequest" check until
    // the twin has drained microtasks (see PartnerScreenTwin.flush/flushUntil).
    const incoming = session.type === 'IncomingRequest' ? session.sessionId : null;
    const shown = this.notificationPort.shownSessionId;
    if (incoming !== null) {
      this.invariants.assertNotification(incoming, shown);
    } else if (shown === null) {
      // No notification expected and none shown — trivially consistent.
      this.invariants.assertNotification(incoming, shown);
    }
    // Defer stale-notification check (incoming === null && shown !== null) to flush-time
    // validation after the notifier's async clear has had a chance to run.
  }

  private releaseAllClaims(): void {
    this.sessionClaim?.(); this.sessionClaim = null;
    this.captureClaim?.(); this.captureClaim = null;
    this.peerClaim?.(); this.peerClaim = null;
    this.rendererClaim?.(); this.rendererClaim = null;
    this.claimedSessionId = null;
    this.claimedCaptureId = null;
    this.claimedPeerId = null;
    this.claimedRendererKey = null;
  }
}

export class PartnerScreenTwin {
  readonly clock: VirtualClock;
  readonly network: VirtualNetwork;
  readonly pairingFabric: SimulatedPairingFabric;
  readonly controlFabric: SimulatedControlFabric;
  readonly discoveryFabric: SimulatedDiscoveryFabric;
  readonly mediaFabric: SimulatedMediaFabric;
  readonly alice: SimulatedDevice;
  readonly bob: SimulatedDevice;

  constructor(seed = 0x50415254) {
    this.clock = new VirtualClock();
    this.network = new VirtualNetwork(this.clock, seed);
    this.pairingFabric = new SimulatedPairingFabric(this.network);
    this.controlFabric = new SimulatedControlFabric(this.network);
    this.discoveryFabric = new SimulatedDiscoveryFabric(this.network);
    this.mediaFabric = new SimulatedMediaFabric(this.network);
    // P0-A: discovery probe must validate the exact control endpoint; link fabrics so
    // SimulatedDiscovery.probe can check control liveness and so stale control endpoints
    // invalidate their discovery advertisements.
    this.discoveryFabric.controlFabric = this.controlFabric;
    this.controlFabric.discoveryFabric = this.discoveryFabric;
    this.alice = new SimulatedDevice({
      name: 'Alice',
      deviceId: '11111111-1111-4111-8111-111111111111',
      host: '192.168.50.10',
      seed: `${seed}:alice`,
    }, this.clock, this.pairingFabric, this.controlFabric, this.discoveryFabric, this.mediaFabric);
    this.bob = new SimulatedDevice({
      name: 'Bob',
      deviceId: '22222222-2222-4222-8222-222222222222',
      host: '192.168.50.11',
      seed: `${seed}:bob`,
    }, this.clock, this.pairingFabric, this.controlFabric, this.discoveryFabric, this.mediaFabric);
  }

  async initialize(): Promise<void> {
    await Promise.all([this.alice.initialize(), this.bob.initialize()]);
    await this.flush();
  }

  async pair(): Promise<void> {
    await this.alice.pairingService.startCreator();
    const creator = this.alice.pairingService.getSnapshot();
    if (creator.kind !== 'creator_qr') throw new Error('Runtime Lab creator QR was not produced.');

    await this.bob.pairingService.startScanner(creator.qrPayload);
    await this.flushUntil(() => this.bob.pairingService.getSnapshot().kind === 'confirm_partner');
    await this.flushUntil(() => this.alice.pairingService.getSnapshot().kind === 'waiting_partner');
    await this.bob.pairingService.confirmPartner();
    await this.flushUntil(() => this.alice.pairingService.getSnapshot().kind === 'confirm_partner');
    await this.alice.pairingService.confirmPartner();
    await this.flushUntil(() => this.alice.pairingService.getSnapshot().kind === 'paired' && this.bob.pairingService.getSnapshot().kind === 'paired');
    await Promise.all([this.alice.waitForPairLifecycle(), this.bob.waitForPairLifecycle()]);
    await this.flushUntil(() => this.alice.sessionController.getSnapshot().type === 'PairedAvailable' && this.bob.sessionController.getSnapshot().type === 'PairedAvailable');
  }

  async requestScreen(requester: SimulatedDevice): Promise<void> {
    const pending = requester.sessionController.requestScreen();
    await this.flushUntil(() => {
      const type = requester.sessionController.getSnapshot().type;
      return type === 'OutgoingRequest' || type === 'Error';
    });
    await pending;
    await this.flush();
  }

  async acceptAndShare(sharer: SimulatedDevice): Promise<void> {
    await sharer.acceptIncomingAndStartCapture();
    await this.flush();
  }

  async beginAcceptAndShare(sharer: SimulatedDevice): Promise<void> {
    const pending = sharer.beginAcceptIncomingAndStartCapture();
    await this.flush();
    await pending;
    await this.flush();
  }

  async advanceBy(ms: number): Promise<void> {
    await this.clock.advanceBy(ms);
    await this.flush();
  }

  private assertAllNotificationInvariants(): void {
    this.alice.assertNotificationInvariantNow();
    this.bob.assertNotificationInvariantNow();
  }

  /** Drain only work due at the current logical time. Future timers never auto-fire. */
  async flush(maxCycles = 2_000): Promise<void> {
    let idleRounds = 0;
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      await settleMicrotasks();
      const next = this.clock.nextDueMs();
      if (next !== null && next <= this.clock.nowMs()) {
        idleRounds = 0;
        await this.clock.advanceTo(this.clock.nowMs());
        continue;
      }

      await Promise.all([this.alice.waitForPairLifecycle(), this.bob.waitForPairLifecycle()]);
      await settleMicrotasks();
      const after = this.clock.nextDueMs();
      if (after === null || after > this.clock.nowMs()) {
        idleRounds += 1;
        if (idleRounds >= 3) {
          await settleMicrotasks();
          this.assertAllNotificationInvariants();
          return;
        }
      } else {
        idleRounds = 0;
      }
    }
    throw new Error('PartnerScreenTwin did not drain current-time work.');
  }

  /** Deliberately advance future logical time until the requested product condition is true. */
  async flushUntil(predicate: () => boolean, maxCycles = 4_000): Promise<void> {
    let stagnantRounds = 0;
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      if (predicate()) {
        await settleMicrotasks();
        this.assertAllNotificationInvariants();
        return;
      }
      await settleMicrotasks();
      if (predicate()) {
        await settleMicrotasks();
        this.assertAllNotificationInvariants();
        return;
      }

      const next = this.clock.nextDueMs();
      if (next !== null) {
        stagnantRounds = 0;
        await this.clock.advanceTo(next);
        continue;
      }

      await Promise.all([this.alice.waitForPairLifecycle(), this.bob.waitForPairLifecycle()]);
      await settleMicrotasks();
      if (predicate()) {
        await settleMicrotasks();
        this.assertAllNotificationInvariants();
        return;
      }
      if (this.clock.nextDueMs() === null) {
        stagnantRounds += 1;
        if (stagnantRounds >= 8) break;
      } else {
        stagnantRounds = 0;
      }
    }
    throw new Error('PartnerScreenTwin condition did not converge.');
  }

  dispose(): void {
    this.alice.dispose();
    this.bob.dispose();
    this.clock.cancelAll();
  }
}
