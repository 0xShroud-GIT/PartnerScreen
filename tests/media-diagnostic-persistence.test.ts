import assert from 'node:assert/strict';
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
