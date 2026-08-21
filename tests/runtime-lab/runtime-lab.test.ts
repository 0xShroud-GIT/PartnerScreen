import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicPartnerScreenTwin } from './DeterministicTwin';
import { RuntimeInvariantMonitor } from '../../src/runtime/RuntimeInvariantMonitor';
import { VirtualClock } from './VirtualClock';
import { VirtualNetwork } from './VirtualNetwork';

test('Runtime Lab pairs two real PairingService instances and reaches actual first-frame LIVE through production controllers', async () => {
  const twin = new DeterministicPartnerScreenTwin(101);
  try {
    await twin.initialize();
    await twin.pair();

    assert.equal(twin.alice.sessionController.getSnapshot().type, 'PairedAvailable');
    assert.equal(twin.bob.sessionController.getSnapshot().type, 'PairedAvailable');

    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    const incoming = twin.bob.sessionController.getSnapshot();
    assert.equal(incoming.type, 'IncomingRequest');
    if (incoming.type !== 'IncomingRequest') throw new Error('Incoming request missing.');
    assert.equal(twin.bob.notificationPort.shownSessionId, incoming.sessionId);

    await twin.acceptAndShare(twin.bob);
    await twin.flushUntil(() => twin.alice.mediaSessionController.getSnapshot().type === 'live');

    const aliceMedia = twin.alice.mediaSessionController.getSnapshot();
    const bobCapture = twin.bob.screenCaptureCoordinator.getSnapshot();
    assert.equal(aliceMedia.type, 'live');
    assert.equal(bobCapture.type, 'capturing');
    assert.ok(twin.alice.diagnostics.events.includes('media_first_frame'));
    assert.ok(twin.bob.diagnostics.events.includes('capture_started'));
    assert.ok(twin.alice.mediaPort.addedCandidates.length > 0);
    assert.ok(twin.bob.mediaPort.addedCandidates.length > 0);

    assert.equal(twin.alice.openViewer(), true);
    assert.equal(twin.alice.openViewer(), false, 'viewer navigation must be idempotent in the lab owner registry');
    assert.throws(() => twin.alice.forceDuplicateViewerForInvariantTest(), /INVARIANT VIOLATION.*viewer/i);
  } finally {
    twin.dispose();
  }
});

test('VirtualClock advances long timeout/reconnect windows without sleeping', async () => {
  const clock = new VirtualClock(1_000);
  const fired: number[] = [];
  clock.schedule(15_000, () => fired.push(clock.nowMs()));
  clock.schedule(5_000, () => fired.push(clock.nowMs()));
  await clock.advanceBy(4_999);
  assert.deepEqual(fired, []);
  await clock.advanceBy(1);
  assert.deepEqual(fired, [6_000]);
  await clock.advanceBy(10_000);
  assert.deepEqual(fired, [6_000, 16_000]);
});

test('VirtualNetwork provides deterministic latency/loss/outage controls without wall-clock waits', async () => {
  const clock = new VirtualClock(0);
  const network = new VirtualNetwork(clock, 7);
  network.setProfile('control', { latencyMs: 250, jitterMs: 0, loss: 0, bandwidthBps: null });
  let delivered = false;
  assert.equal(network.transmit('control', 100, () => { delivered = true; }), true);
  await clock.advanceBy(249);
  assert.equal(delivered, false);
  await clock.advanceBy(1);
  assert.equal(delivered, true);

  network.dropNext('control');
  assert.equal(network.transmit('control', 100, () => { throw new Error('must be dropped'); }), false);
  network.disconnect('control');
  assert.equal(network.transmit('control', 100, () => { throw new Error('must be disconnected'); }), false);
  network.reconnect('control');
  assert.equal(network.isConnected('control'), true);
});

test('RuntimeInvariantMonitor fails immediately on impossible ownership and LIVE claims', () => {
  const monitor = new RuntimeInvariantMonitor(true);
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const releaseSession = monitor.activateSession(sessionId);
  const releaseViewer = monitor.claim('viewer', sessionId);
  assert.throws(() => monitor.claim('viewer', sessionId), /INVARIANT VIOLATION.*viewer/i);
  assert.throws(() => monitor.assertLive(false, sessionId), /INVARIANT VIOLATION.*LIVE/i);
  releaseViewer();
  releaseSession();
  monitor.assertClean();
});
