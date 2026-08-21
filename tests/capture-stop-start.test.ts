import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureStopStartCoordinator } from '../src/capture/CaptureStopStartCoordinator';

const sessionA = '33333333-3333-4333-8333-333333333333';
const sessionB = '88888888-8888-4888-8888-888888888888';
const sessionC = '99999999-9999-4999-8999-999999999999';

test('START while stopping queues the latest valid request and restarts only that session', () => {
  const coordinator = new CaptureStopStartCoordinator();
  assert.equal(coordinator.onStart(sessionA), 'start_now');
  assert.equal(coordinator.onStarted(sessionA), true);
  coordinator.onStopBegin();
  assert.equal(coordinator.onStart(sessionA), 'queue');
  assert.equal(coordinator.onStart(sessionB), 'queue');
  assert.equal(coordinator.onStart('not-a-session'), 'ignore');
  const finished = coordinator.onStopFinished();
  assert.deepEqual(finished, { action: 'restart', sessionId: sessionB });
  assert.equal(coordinator.activeSessionId, sessionB);
  assert.equal(coordinator.isOwnedSession(sessionA), false);
  assert.equal(coordinator.isOwnedSession(sessionB), true);
});

test('multiple START intents while stopping keep only the newest valid request', () => {
  const coordinator = new CaptureStopStartCoordinator();
  coordinator.onStart(sessionA);
  coordinator.onStarted(sessionA);
  coordinator.onStopBegin();
  assert.equal(coordinator.onStart(sessionB), 'queue');
  assert.equal(coordinator.onStart(sessionC), 'queue');
  assert.equal(coordinator.pendingSessionId, sessionC);
  const finished = coordinator.onStopFinished();
  assert.deepEqual(finished, { action: 'restart', sessionId: sessionC });
});

test('stop without a queued START becomes idle and does not revive stale ownership', () => {
  const coordinator = new CaptureStopStartCoordinator();
  coordinator.onStart(sessionA);
  coordinator.onStarted(sessionA);
  const stopped = coordinator.onStopBegin();
  assert.equal(stopped.previousSessionId, sessionA);
  assert.deepEqual(coordinator.onStopFinished(), { action: 'idle' });
  assert.equal(coordinator.phase, 'idle');
  assert.equal(coordinator.isOwnedSession(sessionA), false);
});

test('START while already starting or capturing is ignored rather than creating a second projection', () => {
  const coordinator = new CaptureStopStartCoordinator();
  assert.equal(coordinator.onStart(sessionA), 'start_now');
  assert.equal(coordinator.onStart(sessionB), 'ignore');
  coordinator.onStarted(sessionA);
  assert.equal(coordinator.onStart(sessionB), 'ignore');
  assert.equal(coordinator.activeSessionId, sessionA);
});
