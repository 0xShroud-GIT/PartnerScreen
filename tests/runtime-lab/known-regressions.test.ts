import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicPartnerScreenTwin } from './DeterministicTwin';

const regression = process.env.PARTNERSCREEN_RUN_KNOWN_REGRESSIONS === '1' ? test : test.skip;

/** Desired-product regressions captured from the failed 1d09ae4d APK. */
regression('P0-C: waiting for human MediaProjection consent does not consume a media first-frame deadline', async () => {
  const twin = new DeterministicPartnerScreenTwin(201);
  try {
    await twin.initialize();
    await twin.pair();
    twin.bob.capturePort.consentMode = 'pending';

    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    const accepting = twin.bob.beginAcceptIncomingAndStartCapture();
    await twin.flush();
    assert.equal(twin.alice.sessionController.getSnapshot().type, 'Connected');

    await twin.advanceBy(18_000);
    assert.equal(twin.alice.sessionController.getSnapshot().type, 'Connected');
    assert.notEqual(twin.alice.mediaSessionController.getSnapshot().type, 'error');

    twin.bob.capturePort.approveConsent();
    await accepting;
    await twin.flushUntil(() => twin.alice.mediaSessionController.getSnapshot().type === 'live');
    assert.equal(twin.alice.mediaSessionController.getSnapshot().type, 'live');
  } finally {
    twin.dispose();
  }
});

regression('P0-A: a stale advertised control endpoint cannot leave the partner PairedAvailable', async () => {
  const twin = new DeterministicPartnerScreenTwin(202);
  try {
    await twin.initialize();
    await twin.pair();
    const endpoint = twin.bob.controlTransport.endpoint;
    assert.ok(endpoint);
    twin.controlFabric.makeEndpointStale(endpoint!);
    await twin.flush();
    assert.notEqual(twin.alice.sessionController.getSnapshot().type, 'PairedAvailable');
  } finally {
    twin.dispose();
  }
});

regression('P0-E: denied incoming-notification permission never prevents in-app MediaProjection sharing', async () => {
  const twin = new DeterministicPartnerScreenTwin(203);
  try {
    await twin.initialize();
    await twin.pair();
    twin.bob.notificationPort.permission = 'denied';
    twin.bob.capturePort.notificationPermission = false;

    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();
    await twin.flush();

    assert.notEqual(twin.bob.screenCaptureCoordinator.getSnapshot().type, 'error');
    assert.equal(twin.bob.sessionController.getSnapshot().type, 'Connected');
  } finally {
    twin.dispose();
  }
});

regression('P0-D: trusted listener survives Activity/UI recreation while app process remains alive', async () => {
  const twin = new DeterministicPartnerScreenTwin(204);
  try {
    await twin.initialize();
    await twin.pair();
    twin.bob.controlTransport.recreateActivity();
    await twin.flush();

    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    assert.equal(twin.bob.sessionController.getSnapshot().type, 'IncomingRequest');
  } finally {
    twin.dispose();
  }
});

test.skip('P0-D: full process death reconstructs trusted presence from secure persisted trust', async () => {
  // Intentionally unproven. killProcess() destroys all process-local callbacks/sockets/service state.
  // This becomes executable only after a secure native trust-store -> START_STICKY reconstruction bridge exists.
});
