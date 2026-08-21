import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewerOwnership } from '../src/presentation/ViewerOwnership';
import { displayedVideoSize } from '../src/platform/pip/videoGeometry';

test('viewer ownership is idempotent for the same session and rejects a second owner', () => {
  const owner = new ViewerOwnership();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  assert.equal(owner.claim(sessionId), true);
  assert.equal(owner.claim(sessionId), false);
  assert.equal(owner.isOwner(sessionId), true);
  assert.equal(owner.claim('88888888-8888-4888-8888-888888888888'), false);
  assert.equal(owner.release(sessionId), false);
  assert.equal(owner.release(sessionId), true);
  assert.equal(owner.isOwner(sessionId), false);
});

test('native frame resolution becomes PiP-eligible geometry', () => {
  const geometry = displayedVideoSize({ width: 1280, height: 720, rotation: 90 });
  assert.deepEqual(geometry, { width: 720, height: 1280 });
  assert.equal(displayedVideoSize({ width: 1, height: 720, rotation: 0 }), null);
});

test('session termination releases viewer ownership exactly once', () => {
  const owner = new ViewerOwnership();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  assert.equal(owner.claim(sessionId), true);
  assert.equal(owner.release(sessionId), true);
  assert.equal(owner.release(sessionId), false);
});
