import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import {
  isDiagnosticEvent,
  type DiagnosticEventKind,
  type StoredDiagnosticEventKind,
} from '../src/domain/diagnostics/DiagnosticEvent';
import { DIAGNOSTICS_STORAGE_KEY, DiagnosticsRepository } from '../src/domain/diagnostics/DiagnosticsRepository';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

const LEGACY_HISTORY = JSON.stringify([
  { schemaVersion: 1, at: '2026-08-01T10:00:00.000Z', kind: 'capture_started' },
  { schemaVersion: 1, at: '2026-08-01T10:00:01.000Z', kind: 'media_negotiation_started' },
  { schemaVersion: 1, at: '2026-08-01T10:00:02.000Z', kind: 'media_keyframe_requested' },
  { schemaVersion: 1, at: '2026-08-01T10:00:02.500Z', kind: 'media_keyframe_forced' },
  { schemaVersion: 1, at: '2026-08-01T10:00:03.000Z', kind: 'media_first_frame' },
  { schemaVersion: 1, at: '2026-08-01T10:00:30.000Z', kind: 'media_stats' },
  { schemaVersion: 1, at: '2026-08-01T10:01:00.000Z', kind: 'capture_stopped' },
]);

const legacyStoredKind: StoredDiagnosticEventKind = 'media_keyframe_requested';
const currentKind: DiagnosticEventKind = 'media_first_frame';
void legacyStoredKind;
void currentKind;
// @ts-expect-error legacy stored events are intentionally not emittable by current code
const legacyEmitKind: DiagnosticEventKind = 'media_keyframe_requested';
void legacyEmitKind;

test('legacy schema-v1 keyframe events remain readable', () => {
  assert.equal(isDiagnosticEvent({ schemaVersion: 1, at: '2026-08-01T10:00:02.000Z', kind: 'media_keyframe_requested' }), true);
  assert.equal(isDiagnosticEvent({ schemaVersion: 1, at: '2026-08-01T10:00:02.500Z', kind: 'media_keyframe_forced' }), true);
});

test('DiagnosticsRepository loads legacy history without corrupting it', async () => {
  const store = new MemoryStore();
  store.values.set(DIAGNOSTICS_STORAGE_KEY, LEGACY_HISTORY);
  const repository = new DiagnosticsRepository(store, { nowIso: () => '2026-08-22T12:00:00.000Z' });
  const events = await repository.list();
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes('media_keyframe_requested'));
  assert.ok(kinds.includes('media_keyframe_forced'));
  assert.ok(kinds.includes('media_first_frame'));
});

test('current append works after loading legacy history', async () => {
  const store = new MemoryStore();
  store.values.set(DIAGNOSTICS_STORAGE_KEY, LEGACY_HISTORY);
  const repository = new DiagnosticsRepository(store, { nowIso: () => '2026-08-22T12:00:00.000Z' });
  await repository.append('app_started');
  const kinds = (await repository.list()).map((event) => event.kind);
  assert.ok(kinds.includes('media_keyframe_requested'));
  assert.ok(kinds.includes('app_started'));
});

test('unknown kinds and extra fields remain invalid', () => {
  assert.equal(isDiagnosticEvent({ schemaVersion: 1, at: '2026-08-22T12:00:00.000Z', kind: 'media_keyframe_invented_future' }), false);
  assert.equal(isDiagnosticEvent({ schemaVersion: 1, at: '2026-08-22T12:00:00.000Z', kind: 'capture_started', extra: true }), false);
});
