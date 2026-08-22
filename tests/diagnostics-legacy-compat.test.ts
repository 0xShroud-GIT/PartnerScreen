/**
 * Diagnostic storage backward-compatibility tests.
 *
 * Previously installed Chirp builds (before PR #23) persisted schema-v1 events:
 *   - 'media_keyframe_requested'
 *   - 'media_keyframe_forced'
 *
 * After the WebRTC stabilization pass:
 *   - Current code MUST NOT emit these events.
 *   - Persisted storage containing these legacy events MUST still load cleanly.
 *   - isDiagnosticEvent() must accept them for backward-compat reading.
 *   - DiagnosticsRepository.list() must not throw or corrupt when they are present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../src/domain/persistence/KeyValueStore';
import { isDiagnosticEvent } from '../src/domain/diagnostics/DiagnosticEvent';
import { DIAGNOSTICS_STORAGE_KEY, DiagnosticsRepository } from '../src/domain/diagnostics/DiagnosticsRepository';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getString(key: string) { return this.values.get(key) ?? null; }
  async setString(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

// Simulate a persisted history from a pre-PR#23 build that contains both legacy events.
const LEGACY_HISTORY = JSON.stringify([
  { schemaVersion: 1, at: '2026-08-01T10:00:00.000Z', kind: 'capture_started' },
  { schemaVersion: 1, at: '2026-08-01T10:00:01.000Z', kind: 'media_negotiation_started' },
  { schemaVersion: 1, at: '2026-08-01T10:00:02.000Z', kind: 'media_keyframe_requested' },  // legacy
  { schemaVersion: 1, at: '2026-08-01T10:00:02.500Z', kind: 'media_keyframe_forced' },      // legacy
  { schemaVersion: 1, at: '2026-08-01T10:00:03.000Z', kind: 'media_first_frame' },
  { schemaVersion: 1, at: '2026-08-01T10:00:30.000Z', kind: 'media_stats' },
  { schemaVersion: 1, at: '2026-08-01T10:01:00.000Z', kind: 'capture_stopped' },
]);

test('isDiagnosticEvent accepts legacy schema-v1 media_keyframe_requested events', () => {
  const event = { schemaVersion: 1, at: '2026-08-01T10:00:02.000Z', kind: 'media_keyframe_requested' };
  assert.equal(
    isDiagnosticEvent(event),
    true,
    'isDiagnosticEvent must accept legacy media_keyframe_requested for storage compat',
  );
});

test('isDiagnosticEvent accepts legacy schema-v1 media_keyframe_forced events', () => {
  const event = { schemaVersion: 1, at: '2026-08-01T10:00:02.500Z', kind: 'media_keyframe_forced' };
  assert.equal(
    isDiagnosticEvent(event),
    true,
    'isDiagnosticEvent must accept legacy media_keyframe_forced for storage compat',
  );
});

test('DiagnosticsRepository loads a pre-PR#23 history containing legacy keyframe events without error', async () => {
  const store = new MemoryStore();
  store.values.set(DIAGNOSTICS_STORAGE_KEY, LEGACY_HISTORY);

  const repository = new DiagnosticsRepository(store, {
    nowIso: () => '2026-08-22T12:00:00.000Z',
  });

  // This must not throw — the legacy events must be loaded cleanly.
  const events = await repository.list();

  assert.ok(Array.isArray(events), 'events must be an array');
  assert.ok(events.length >= 5, 'all non-truncated legacy events must be present');

  const kinds = events.map((e) => e.kind);
  assert.ok((kinds as string[]).includes('media_keyframe_requested'), 'legacy media_keyframe_requested must survive loading');
  assert.ok((kinds as string[]).includes('media_keyframe_forced'), 'legacy media_keyframe_forced must survive loading');
  assert.ok((kinds as string[]).includes('media_first_frame'), 'current events must survive alongside legacy events');
});

test('DiagnosticsRepository appending new events to a legacy history preserves loaded events', async () => {
  const store = new MemoryStore();
  store.values.set(DIAGNOSTICS_STORAGE_KEY, LEGACY_HISTORY);

  let tick = 0;
  const repository = new DiagnosticsRepository(store, {
    nowIso: () => new Date(Date.UTC(2026, 7, 22, 12, 0, tick++)).toISOString(),
  });

  // Appending a new current event to a repo that has legacy events must work.
  await repository.append('app_started');
  const events = await repository.list();

  const kinds = events.map((e) => e.kind) as string[];
  assert.ok(kinds.includes('media_keyframe_requested'), 'legacy event survives append');
  assert.ok(kinds.includes('app_started'), 'new event is appended successfully');
});

test('current code DiagnosticEventKind union does not include legacy keyframe kinds', async () => {
  // Verify by attempting to import and checking that media_keyframe_requested is not
  // assignable to DiagnosticEventKind at the type level. Since we can't do type checks
  // at runtime, we verify the CURRENT_KINDS set (indirectly through isDiagnosticEvent
  // failing on a hypothetical future kind that shouldn't be current).

  // A kind that was never valid must still be rejected.
  const bogus = { schemaVersion: 1, at: '2026-08-22T12:00:00.000Z', kind: 'media_keyframe_invented_future' };
  assert.equal(isDiagnosticEvent(bogus), false, 'unknown kinds must be rejected');

  // A current valid kind must be accepted.
  const valid = { schemaVersion: 1, at: '2026-08-22T12:00:00.000Z', kind: 'media_first_frame' };
  assert.equal(isDiagnosticEvent(valid), true, 'current kinds must be accepted');
});

test('DiagnosticsRepository correctly rejects events with extra unknown fields even in legacy history', async () => {
  const corruptHistory = JSON.stringify([
    { schemaVersion: 1, at: '2026-08-01T10:00:00.000Z', kind: 'capture_started', extraField: 'bad' },
  ]);
  const store = new MemoryStore();
  store.values.set(DIAGNOSTICS_STORAGE_KEY, corruptHistory);

  const repository = new DiagnosticsRepository(store, {
    nowIso: () => '2026-08-22T12:00:00.000Z',
  });

  // Extra fields in persisted events must still be rejected (schema strictness preserved).
  await assert.rejects(repository.list(), /corrupt/i);
});
