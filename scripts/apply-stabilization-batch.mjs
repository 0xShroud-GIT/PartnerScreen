import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content); }
function replaceOnce(path, before, after) {
  const source = read(path);
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Patch target not found in ${path}: ${before.slice(0, 80)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Patch target not unique in ${path}: ${before.slice(0, 80)}`);
  write(path, source.slice(0, first) + after + source.slice(first + before.length));
}

replaceOnce(
  'src/media/MediaSession.ts',
`    if (disposition === 'disconnected') {
      if (!this.disconnectedTimer) {
        void this.record('media_degraded');
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          void this.enqueue(() => this.scheduleRecovery(sessionId, 'peer transport disconnected')).catch(() => undefined);
        }, MEDIA_DISCONNECTED_GRACE_MS);
      }
      this.emit();
      return;
    }`,
`    if (disposition === 'disconnected') {
      if (!this.disconnectedTimer) {
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          void this.enqueue(async () => {
            if (this.peer !== peer || this.peerSessionId !== sessionId) return;
            const currentDisposition = peerTransportDisposition(
              (peer as any).connectionState as string | undefined,
              (peer as any).iceConnectionState as string | undefined,
            );
            if (currentDisposition !== 'disconnected') return;
            await this.record('media_degraded');
            await this.scheduleRecovery(sessionId, 'peer transport disconnected');
          }).catch(() => undefined);
        }, MEDIA_DISCONNECTED_GRACE_MS);
      }
      this.emit();
      return;
    }`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`import type {
  DiscoveryAdvertisementPreparation,
  ChirpDiscovery,
  ChirpDiscoveryEvent,
  ResolvedPartnerService,
} from '../platform/discovery/ChirpDiscovery';`,
`import type {
  DiscoveryAdvertisementPreparation,
  ChirpDiscovery,
  ChirpDiscoveryEvent,
  ResolvedPartnerService,
} from '../platform/discovery/ChirpDiscovery';
import type { RuntimeScheduler, RuntimeTimer } from '../runtime/RuntimeScheduler';`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`const GENERIC_START_MESSAGE = 'Trusted availability could not start. Check that both phones are on the same Wi-Fi, then retry.';`,
`const GENERIC_START_MESSAGE = 'Trusted availability could not start. Check that both phones are on the same Wi-Fi, then retry.';
export const AVAILABILITY_LEASE_REPROBE_MS = 4_000;`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`  private active: ActiveAvailability | null = null;
  private lastPair: PairTrustMetadata | null = null;
  private readonly unsubscribeDiscovery: () => void;`,
`  private active: ActiveAvailability | null = null;
  private lastPair: PairTrustMetadata | null = null;
  private leaseTimer: RuntimeTimer | null = null;
  private readonly unsubscribeDiscovery: () => void;`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`    private readonly discovery: ChirpDiscovery,
    private readonly authenticator: HmacDiscoveryAuthenticator,
    private readonly controlListener: ControlListenerSource,
  ) {`,
`    private readonly discovery: ChirpDiscovery,
    private readonly authenticator: HmacDiscoveryAuthenticator,
    private readonly controlListener: ControlListenerSource,
    private readonly scheduler?: RuntimeScheduler,
  ) {`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`  activate(pair: PairTrustMetadata): Promise<void> { this.lastPair = pair; return this.enqueue(() => this.activateNow(pair)); }
  retry(): Promise<void> { const pair = this.lastPair; return pair ? this.enqueue(() => this.activateNow(pair, true)) : Promise.resolve(); }
  deactivate(): Promise<void> { this.lastPair = null; return this.enqueue(async () => { await this.stopActive(true); this.setState({ kind: 'inactive' }); }); }
  dispose(): void { this.unsubscribeDiscovery(); this.unsubscribeControlListener(); void this.discovery.stop().catch(() => undefined); }`,
`  activate(pair: PairTrustMetadata): Promise<void> { this.lastPair = pair; return this.enqueue(() => this.activateNow(pair)); }
  retry(): Promise<void> { const pair = this.lastPair; return pair ? this.enqueue(() => this.activateNow(pair, true)) : Promise.resolve(); }
  markPartnerUnreachable(endpoint: { host: string; port: number }): Promise<void> {
    return this.enqueue(async () => {
      const active = this.active;
      if (!active || this.state.kind !== 'available') return;
      if (this.state.endpoint.host !== endpoint.host || this.state.endpoint.port !== endpoint.port) return;
      this.clearLeaseTimer();
      this.probeGeneration += 1;
      active.matchedServiceName = null;
      active.provenControl = null;
      this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true });
      await this.record('availability_probe_failed');
    });
  }
  deactivate(): Promise<void> { this.lastPair = null; return this.enqueue(async () => { await this.stopActive(true); this.setState({ kind: 'inactive' }); }); }
  dispose(): void { this.clearLeaseTimer(); this.unsubscribeDiscovery(); this.unsubscribeControlListener(); void this.discovery.stop().catch(() => undefined); }`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`  private async stopActive(recordStop: boolean): Promise<void> {
    const hadActive = this.active !== null;
    this.generation += 1;`,
`  private async stopActive(recordStop: boolean): Promise<void> {
    const hadActive = this.active !== null;
    this.clearLeaseTimer();
    this.generation += 1;`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`      this.probeGeneration += 1;
      active.matchedServiceName = null;
      active.provenControl = null;
      this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true });`,
`      this.clearLeaseTimer();
      this.probeGeneration += 1;
      active.matchedServiceName = null;
      active.provenControl = null;
      this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true });`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`    this.probeGeneration += 1;
    active.matchedServiceName = null;
    active.provenControl = null;
    this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true, message: 'Trusted discovery reported a local network error. Chirp will remain fail-closed until the partner is proven reachable again.' });`,
`    this.clearLeaseTimer();
    this.probeGeneration += 1;
    active.matchedServiceName = null;
    active.provenControl = null;
    this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true, message: 'Trusted discovery reported a local network error. Chirp will remain fail-closed until the partner is proven reachable again.' });`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`      current.provenControl = { host: service.host, port: controlPort };
      this.setState({ kind: 'available', pair: current.pair, endpoint: { host: service.host, port: controlPort }, serviceName: service.serviceName });
      if (changed) await this.record('availability_partner_found');`,
`      current.provenControl = { host: service.host, port: controlPort };
      this.setState({ kind: 'available', pair: current.pair, endpoint: { host: service.host, port: controlPort }, serviceName: service.serviceName });
      this.schedulePartnerLease(current);
      if (changed) await this.record('availability_partner_found');`,
);

replaceOnce(
  'src/availability/AvailabilityService.ts',
`  private async record(kind: DiagnosticEventKind): Promise<void> { try { await this.diagnostics.append(kind); } catch { /* diagnostics never own availability */ } }`,
`  private schedulePartnerLease(active: ActiveAvailability): void {
    if (!this.scheduler || !active.provenControl) return;
    this.clearLeaseTimer();
    const generation = active.generation;
    const endpoint = { ...active.provenControl };
    this.leaseTimer = this.scheduler.schedule(AVAILABILITY_LEASE_REPROBE_MS, () => {
      this.leaseTimer = null;
      void this.enqueue(() => this.reprobePartnerLease(generation, endpoint)).catch(() => undefined);
    });
  }

  private async reprobePartnerLease(generation: number, endpoint: { host: string; port: number }): Promise<void> {
    const active = this.active;
    if (!active || active.generation !== generation || this.state.kind !== 'available') return;
    if (this.state.endpoint.host !== endpoint.host || this.state.endpoint.port !== endpoint.port) return;
    try {
      await this.discovery.probe(endpoint.host, endpoint.port);
    } catch {
      if (!this.active || this.active.generation !== generation || this.state.kind !== 'available') return;
      this.probeGeneration += 1;
      active.matchedServiceName = null;
      active.provenControl = null;
      this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true });
      await this.record('availability_probe_failed');
      return;
    }
    if (!this.active || this.active.generation !== generation || this.state.kind !== 'available') return;
    this.schedulePartnerLease(active);
  }

  private clearLeaseTimer(): void {
    this.leaseTimer?.cancel();
    this.leaseTimer = null;
  }

  private async record(kind: DiagnosticEventKind): Promise<void> { try { await this.diagnostics.append(kind); } catch { /* diagnostics never own availability */ } }`,
);

write('src/presentation/useAvailability.ts', `import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { appServices } from '../application/AppServices';

export function useAvailability() {
  const state = useSyncExternalStore(
    appServices.availabilityService.subscribe,
    appServices.availabilityService.getSnapshot,
    appServices.availabilityService.getSnapshot,
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void appServices.availabilityService.retry().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  return {
    state,
    retry: () => appServices.availabilityService.retry(),
  };
}
`);

write('src/presentation/usePairing.ts', `import { useEffect, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { appServices } from '../application/AppServices';

function confirmRevokePair(): Promise<void> {
  return new Promise((resolve) => {
    Alert.alert(
      'Forget trusted phone?',
      'This removes the saved trust on this phone. You will need to pair the two phones again.',
      [
        { text: 'Cancel', style: 'cancel', onPress: resolve },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => { void appServices.pairingService.revokePair().finally(resolve); },
        },
      ],
      { cancelable: true, onDismiss: resolve },
    );
  });
}

export function usePairing() {
  const state = useSyncExternalStore(
    appServices.pairingService.subscribe,
    appServices.pairingService.getSnapshot,
    appServices.pairingService.getSnapshot,
  );

  useEffect(() => {
    void appServices.pairingService.initialize();
  }, []);

  return {
    state,
    startCreator: () => appServices.pairingService.startCreator(),
    startScanner: (rawQr: string) => appServices.pairingService.startScanner(rawQr),
    confirmPartner: () => appServices.pairingService.confirmPartner(),
    cancel: () => appServices.pairingService.cancel(),
    revokePair: confirmRevokePair,
    resetError: () => appServices.pairingService.resetError(),
  };
}
`);

write('src/application/MediaDiagnosticPersistence.ts', `import type { KeyValueStore } from '../domain/persistence/KeyValueStore';
import type { MediaDiagnosticSnapshot, MediaStatsSnapshot } from '../media/MediaSession';

export const LAST_MEDIA_DIAGNOSTIC_STORAGE_KEY = '@chirp/diagnostics/last-media/v1';

const MEDIA_STATES = new Set(['idle', 'awaiting_permission', 'connecting', 'live', 'recovering', 'error']);
const ROLES = new Set(['requester', 'sharer']);
const SNAPSHOT_KEYS = new Set([
  'state', 'role', 'connectionState', 'iceConnectionState', 'iceGatheringState', 'signalingState',
  'remoteTrackSeen', 'firstFrameSeen', 'acceptedLocalCandidates', 'rejectedLocalCandidates',
  'acceptedRemoteCandidates', 'rejectedRemoteCandidates', 'restartAttempts', 'bitrateParametersApplied',
  'lastFailureReason', 'stats',
]);
const STATS_KEYS = new Set([
  'atMs', 'sendBitrateBps', 'receiveBitrateBps', 'framesPerSecond', 'frameWidth', 'frameHeight',
  'framesEncoded', 'framesDecoded', 'framesDropped', 'keyFramesEncoded', 'keyFramesDecoded', 'nackCount',
  'pliCount', 'firCount', 'packetsLost', 'jitterMs', 'roundTripTimeMs', 'candidatePairState', 'codecMimeType',
  'encoderImplementation', 'decoderImplementation', 'qualityLimitationReason',
]);

function finite(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value); }
function optionalFinite(value: unknown): boolean { return value === undefined || finite(value); }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === 'string'; }
function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isPersistableMediaStats(value: unknown): value is MediaStatsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stats = value as Record<string, unknown>;
  if (!exactKeys(stats, STATS_KEYS) || !finite(stats.atMs)) return false;
  for (const key of [
    'sendBitrateBps', 'receiveBitrateBps', 'framesPerSecond', 'frameWidth', 'frameHeight', 'framesEncoded',
    'framesDecoded', 'framesDropped', 'keyFramesEncoded', 'keyFramesDecoded', 'nackCount', 'pliCount', 'firCount',
    'packetsLost', 'jitterMs', 'roundTripTimeMs',
  ]) if (!optionalFinite(stats[key])) return false;
  for (const key of ['candidatePairState', 'codecMimeType', 'encoderImplementation', 'decoderImplementation', 'qualityLimitationReason']) {
    if (!optionalString(stats[key])) return false;
  }
  return true;
}

export function isPersistableMediaDiagnostic(value: unknown): value is MediaDiagnosticSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (!exactKeys(snapshot, SNAPSHOT_KEYS)) return false;
  if (typeof snapshot.state !== 'string' || !MEDIA_STATES.has(snapshot.state)) return false;
  if (snapshot.role !== undefined && (typeof snapshot.role !== 'string' || !ROLES.has(snapshot.role))) return false;
  for (const key of ['connectionState', 'iceConnectionState', 'iceGatheringState', 'signalingState', 'lastFailureReason']) {
    if (!optionalString(snapshot[key])) return false;
  }
  for (const key of ['remoteTrackSeen', 'firstFrameSeen', 'bitrateParametersApplied']) {
    if (typeof snapshot[key] !== 'boolean') return false;
  }
  for (const key of ['acceptedLocalCandidates', 'rejectedLocalCandidates', 'acceptedRemoteCandidates', 'rejectedRemoteCandidates', 'restartAttempts']) {
    if (!finite(snapshot[key]) || (snapshot[key] as number) < 0) return false;
  }
  return snapshot.stats === null || isPersistableMediaStats(snapshot.stats);
}

function clone(snapshot: MediaDiagnosticSnapshot): MediaDiagnosticSnapshot {
  return { ...snapshot, stats: snapshot.stats ? { ...snapshot.stats } : null };
}

function meaningful(snapshot: MediaDiagnosticSnapshot): boolean {
  return snapshot.state !== 'idle'
    || snapshot.role !== undefined
    || snapshot.remoteTrackSeen
    || snapshot.firstFrameSeen
    || snapshot.stats !== null
    || snapshot.acceptedLocalCandidates > 0
    || snapshot.rejectedLocalCandidates > 0
    || snapshot.acceptedRemoteCandidates > 0
    || snapshot.rejectedRemoteCandidates > 0
    || snapshot.restartAttempts > 0
    || snapshot.bitrateParametersApplied
    || Boolean(snapshot.lastFailureReason);
}

export interface MediaDiagnosticSource {
  subscribe(listener: () => void): () => void;
  getDiagnosticSnapshot(): MediaDiagnosticSnapshot;
}

export class MediaDiagnosticPersistence {
  private readonly unsubscribe: () => void;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: KeyValueStore, private readonly media: MediaDiagnosticSource) {
    this.unsubscribe = media.subscribe(() => this.capture());
  }

  dispose(): void { this.unsubscribe(); }

  async load(): Promise<MediaDiagnosticSnapshot | null> {
    try {
      const raw = await this.store.getString(LAST_MEDIA_DIAGNOSTIC_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return isPersistableMediaDiagnostic(parsed) ? clone(parsed) : null;
    } catch {
      return null;
    }
  }

  async snapshotForReport(current: MediaDiagnosticSnapshot): Promise<MediaDiagnosticSnapshot> {
    if (meaningful(current)) return clone(current);
    return (await this.load()) ?? clone(current);
  }

  private capture(): void {
    const snapshot = this.media.getDiagnosticSnapshot();
    if (!meaningful(snapshot) || !isPersistableMediaDiagnostic(snapshot)) return;
    const serialized = JSON.stringify(snapshot);
    this.writeQueue = this.writeQueue
      .then(() => this.store.setString(LAST_MEDIA_DIAGNOSTIC_STORAGE_KEY, serialized))
      .catch(() => undefined);
  }
}
`);

write('src/application/AvailabilityAwareControlChannel.ts', `import type { ControlSessionEvent, ControlTrustContext } from '../control/ControlSession';
import type { AnyControlMessage, ControlMessageType, ControlPayloadMap } from '../protocol/ControlMessage';
import type { SessionControlChannel } from '../session/SessionController';

export interface AvailabilityInvalidator {
  markPartnerUnreachable(endpoint: { host: string; port: number }): Promise<void>;
}

export class AvailabilityAwareControlChannel implements SessionControlChannel {
  constructor(private readonly control: SessionControlChannel, private readonly availability: AvailabilityInvalidator) {}
  subscribe(listener: (event: ControlSessionEvent) => void): () => void { return this.control.subscribe(listener); }
  activate(context: ControlTrustContext): Promise<void> { return this.control.activate(context); }
  deactivate(): Promise<void> { return this.control.deactivate(); }
  async connect(endpoint: { host: string; port: number }): Promise<string> {
    try {
      return await this.control.connect(endpoint);
    } catch (error) {
      await this.availability.markPartnerUnreachable(endpoint).catch(() => undefined);
      throw error;
    }
  }
  updateReconnectEndpoint(endpoint: { host: string; port: number }): void { this.control.updateReconnectEndpoint?.(endpoint); }
  send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> { return this.control.send(type, payload); }
  close(): Promise<void> { return this.control.close(); }
}
`);

replaceOnce(
  'src/application/AppServices.ts',
`import { IncomingRequestNotifier } from '../request/IncomingRequestNotifier';
import { ExpoRequestNotification } from '../platform/notifications/ExpoRequestNotification';`,
`import { IncomingRequestNotifier } from '../request/IncomingRequestNotifier';
import { ExpoRequestNotification } from '../platform/notifications/ExpoRequestNotification';
import { systemRuntimeScheduler } from '../runtime/RuntimeScheduler';
import { AvailabilityAwareControlChannel } from './AvailabilityAwareControlChannel';
import { MediaDiagnosticPersistence } from './MediaDiagnosticPersistence';`,
);

replaceOnce(
  'src/application/AppServices.ts',
`const pendingRequestStore = new PendingRequestStore(ordinaryStore);
const sessionController = new SessionController(
  identityRepository,
  pairTrustRepository,
  pendingRequestStore,
  controlSession,
  diagnosticsRepository,
);
const mediaSession = new MediaSession(sessionController, diagnosticsRepository);
const discoveryAuthenticator = new HmacDiscoveryAuthenticator(new ExpoDiscoveryHmac());
const availabilityService = new AvailabilityService(
  pairTrustRepository,
  diagnosticsRepository,
  new ExpoChirpDiscovery(),
  discoveryAuthenticator,
  controlSession,
);`,
`const pendingRequestStore = new PendingRequestStore(ordinaryStore);
const discoveryAuthenticator = new HmacDiscoveryAuthenticator(new ExpoDiscoveryHmac());
const availabilityService = new AvailabilityService(
  pairTrustRepository,
  diagnosticsRepository,
  new ExpoChirpDiscovery(),
  discoveryAuthenticator,
  controlSession,
  systemRuntimeScheduler,
);
const availabilityAwareControl = new AvailabilityAwareControlChannel(controlSession, availabilityService);
const sessionController = new SessionController(
  identityRepository,
  pairTrustRepository,
  pendingRequestStore,
  availabilityAwareControl,
  diagnosticsRepository,
);
const mediaSession = new MediaSession(sessionController, diagnosticsRepository);
const mediaDiagnosticPersistence = new MediaDiagnosticPersistence(ordinaryStore, mediaSession);`,
);

replaceOnce(
  'src/application/AppServices.ts',
`  mediaSession,
  incomingRequestNotifier,`,
`  mediaSession,
  mediaDiagnosticPersistence,
  incomingRequestNotifier,`,
);

replaceOnce(
  'app/diagnostics.tsx',
`      const events = await appServices.diagnosticsRepository.list();
      setReport(buildDiagnosticReport({
        generatedAt: appServices.clock.nowIso(),
        identity,
        events,
        build: getDiagnosticBuildMetadata(),
        media: appServices.mediaSession.getDiagnosticSnapshot(),
      }));`,
`      const events = await appServices.diagnosticsRepository.list();
      const media = await appServices.mediaDiagnosticPersistence.snapshotForReport(
        appServices.mediaSession.getDiagnosticSnapshot(),
      );
      setReport(buildDiagnosticReport({
        generatedAt: appServices.clock.nowIso(),
        identity,
        events,
        build: getDiagnosticBuildMetadata(),
        media,
      }));`,
);

write('tests/media-diagnostic-persistence.test.ts', `import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import {
  LAST_MEDIA_DIAGNOSTIC_STORAGE_KEY,
  MediaDiagnosticPersistence,
  isPersistableMediaDiagnostic,
} from '../src/application/MediaDiagnosticPersistence';
import type { MediaDiagnosticSnapshot } from '../src/media/MediaSession';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}
class FakeMedia {
  private readonly listeners = new Set<() => void>();
  snapshot: MediaDiagnosticSnapshot;
  constructor(snapshot: MediaDiagnosticSnapshot) { this.snapshot = snapshot; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getDiagnosticSnapshot(): MediaDiagnosticSnapshot { return this.snapshot; }
  emit() { for (const listener of this.listeners) listener(); }
}
const empty: MediaDiagnosticSnapshot = {
  state: 'idle', remoteTrackSeen: false, firstFrameSeen: false,
  acceptedLocalCandidates: 0, rejectedLocalCandidates: 0, acceptedRemoteCandidates: 0, rejectedRemoteCandidates: 0,
  restartAttempts: 0, bitrateParametersApplied: false, stats: null,
};
const live: MediaDiagnosticSnapshot = {
  state: 'live', role: 'requester', connectionState: 'connected', iceConnectionState: 'connected',
  iceGatheringState: 'complete', signalingState: 'stable', remoteTrackSeen: true, firstFrameSeen: true,
  acceptedLocalCandidates: 1, rejectedLocalCandidates: 2, acceptedRemoteCandidates: 1, rejectedRemoteCandidates: 1,
  restartAttempts: 0, bitrateParametersApplied: false, stats: { atMs: 1000, framesDecoded: 42, receiveBitrateBps: 1_500_000, codecMimeType: 'video/VP8' },
};
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); }

test('last media snapshot is persisted and can be used after a process-style fresh idle session', async () => {
  const store = new MemoryStore();
  const media = new FakeMedia(empty);
  const persistence = new MediaDiagnosticPersistence(store, media);
  media.snapshot = live; media.emit(); await settle();
  assert.ok(store.values.has(LAST_MEDIA_DIAGNOSTIC_STORAGE_KEY));
  const restored = await persistence.snapshotForReport(empty);
  assert.equal(restored.state, 'live');
  assert.equal(restored.firstFrameSeen, true);
  assert.equal(restored.stats?.framesDecoded, 42);
  persistence.dispose();
});

test('a new active media attempt replaces the previous persisted session', async () => {
  const store = new MemoryStore();
  const media = new FakeMedia(live);
  const persistence = new MediaDiagnosticPersistence(store, media);
  media.emit(); await settle();
  media.snapshot = { ...empty, state: 'awaiting_permission', role: 'sharer' };
  media.emit(); await settle();
  const restored = await persistence.load();
  assert.equal(restored?.state, 'awaiting_permission');
  assert.equal(restored?.role, 'sharer');
  persistence.dispose();
});

test('persisted diagnostics reject unknown fields and malformed numbers', () => {
  assert.equal(isPersistableMediaDiagnostic({ ...live, rawCandidate: 'candidate:private' }), false);
  assert.equal(isPersistableMediaDiagnostic({ ...live, acceptedLocalCandidates: -1 }), false);
});
`);

write('tests/availability-lease.test.ts', `import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AvailabilityService, AVAILABILITY_LEASE_REPROBE_MS } from '../src/availability/AvailabilityService';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';
import { HmacDiscoveryAuthenticator, type HmacSha256 } from '../src/domain/discovery/TrustedDiscoveryAuthenticator';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { ChirpDiscovery, ChirpDiscoveryEvent, DiscoveryAdvertisementPreparation, DiscoveryRegistration } from '../src/platform/discovery/ChirpDiscovery';
import type { RuntimeScheduler, RuntimeTimer } from '../src/runtime/RuntimeScheduler';

class Hmac implements HmacSha256 { async macHex(keyHex: string, message: string) { return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex'); } }
class Scheduler implements RuntimeScheduler {
  tasks: Array<{ delay: number; task: () => void; cancelled: boolean }> = [];
  schedule(delay: number, task: () => void): RuntimeTimer {
    const entry = { delay, task, cancelled: false }; this.tasks.push(entry); return { cancel: () => { entry.cancelled = true; } };
  }
  runNext() { const entry = this.tasks.find((task) => !task.cancelled); if (!entry) throw new Error('no scheduled task'); entry.cancelled = true; entry.task(); }
}
class Discovery implements ChirpDiscovery {
  listeners = new Set<(event: ChirpDiscoveryEvent) => void>(); failProbe = false; probes: Array<{host:string;port:number}> = [];
  async prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation> { return { advertisementId: 'local', host: '192.168.1.10', port: 41000, nonce: '10'.repeat(16) }; }
  async start(): Promise<DiscoveryRegistration> { return { serviceName: 'Chirp-local' }; }
  async stop() {}
  async probe(host: string, port: number) { this.probes.push({ host, port }); if (this.failProbe) throw new Error('offline'); }
  subscribe(listener: (event: ChirpDiscoveryEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: ChirpDiscoveryEvent) { for (const listener of this.listeners) listener(event); }
}
const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '11111111-1111-4111-8111-111111111111', partnerDeviceId: '22222222-2222-4222-8222-222222222222', partnerDeviceName: 'Claire', pairedAt: '2026-08-22T00:00:00.000Z' };
const secret = 'ab'.repeat(32);
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); }
async function harness() {
  const discovery = new Discovery(); const scheduler = new Scheduler(); const diagnostics: DiagnosticEventKind[] = [];
  const auth = new HmacDiscoveryAuthenticator(new Hmac());
  const service = new AvailabilityService(
    { loadPairSecret: async () => secret },
    { append: async (kind) => { diagnostics.push(kind); } },
    discovery,
    auth,
    { ensureListening: async () => ({ host: '192.168.1.10', port: 44000 }) },
    scheduler,
  );
  await service.activate(pair);
  const nonce = '20'.repeat(16); const host = '192.168.1.11'; const port = 42000; const controlPort = 45000;
  discovery.emit({ type: 'service_resolved', service: { serviceName: 'Chirp-remote', host, port, nonce, peerHint: await auth.derivePeerHint(secret, nonce), proof: await auth.createProof(secret, { nonce, host, port, controlPort }) } });
  await settle();
  return { discovery, scheduler, diagnostics, service, endpoint: { host, port: controlPort } };
}

test('available partner is re-probed on a short lease and demoted when endpoint dies', async () => {
  const { discovery, scheduler, diagnostics, service } = await harness();
  assert.equal(service.getSnapshot().kind, 'available');
  assert.equal(scheduler.tasks.some((task) => task.delay === AVAILABILITY_LEASE_REPROBE_MS), true);
  discovery.failProbe = true; scheduler.runNext(); await settle();
  assert.equal(service.getSnapshot().kind, 'offline');
  assert.ok(diagnostics.includes('availability_probe_failed'));
  service.dispose();
});

test('failed request endpoint can invalidate availability immediately', async () => {
  const { service, endpoint } = await harness();
  assert.equal(service.getSnapshot().kind, 'available');
  await service.markPartnerUnreachable(endpoint);
  assert.equal(service.getSnapshot().kind, 'offline');
  service.dispose();
});
`);

write('tests/stabilization-guards.test.ts', `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('media_degraded is only emitted after the disconnected grace timer survives', () => {
  const source = readFileSync('src/media/MediaSession.ts', 'utf8');
  const timer = source.indexOf('this.disconnectedTimer = setTimeout');
  const degraded = source.indexOf("await this.record('media_degraded')", timer);
  assert.ok(timer >= 0 && degraded > timer);
});

test('foreground revalidates availability and trust revocation requires destructive confirmation', () => {
  const availability = readFileSync('src/presentation/useAvailability.ts', 'utf8');
  const pairing = readFileSync('src/presentation/usePairing.ts', 'utf8');
  assert.equal(availability.includes("next === 'active'"), true);
  assert.equal(availability.includes('availabilityService.retry()'), true);
  assert.equal(pairing.includes("Alert.alert("), true);
  assert.equal(pairing.includes("style: 'destructive'"), true);
  assert.equal(pairing.includes('pairingService.revokePair().finally(resolve)'), true);
});
`);

console.log('stabilization batch applied');
