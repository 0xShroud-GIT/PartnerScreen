import type { KeyValueStore } from '../domain/persistence/KeyValueStore';
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
