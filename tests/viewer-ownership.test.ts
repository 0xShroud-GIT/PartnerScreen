import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewerOwnership } from '../src/presentation/ViewerOwnership';
import { displayedVideoSize } from '../src/platform/pip/videoGeometry';

test('viewer navigation reserves before mount and rejects duplicate routes', () => {
  const owner = new ViewerOwnership();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  assert.equal(owner.reserve(sessionId), true);
  assert.equal(owner.getPhase(sessionId), 'reserved');
  assert.equal(owner.reserve(sessionId), false);
  assert.equal(owner.reserve('88888888-8888-4888-8888-888888888888'), false);
  assert.equal(owner.mount(sessionId), true);
  assert.equal(owner.isOwner(sessionId), true);
  assert.equal(owner.mount(sessionId), false);
  assert.equal(owner.release(sessionId), true);
  assert.equal(owner.release(sessionId), false);
  assert.equal(owner.getPhase(sessionId), 'idle');
});

test('a failed navigation can cancel a reservation without releasing a mounted viewer', () => {
  const owner = new ViewerOwnership();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  assert.equal(owner.reserve(sessionId), true);
  assert.equal(owner.cancelReservation(sessionId), true);
  assert.equal(owner.reserve(sessionId), true);
  assert.equal(owner.mount(sessionId), true);
  assert.equal(owner.cancelReservation(sessionId), false);
  assert.equal(owner.release(sessionId), true);
});

test('native frame resolution becomes PiP-eligible geometry', () => {
  const geometry = displayedVideoSize({ width: 1280, height: 720, rotation: 90 });
  assert.deepEqual(geometry, { width: 720, height: 1280 });
  assert.equal(displayedVideoSize({ width: 1, height: 720, rotation: 0 }), null);
});
