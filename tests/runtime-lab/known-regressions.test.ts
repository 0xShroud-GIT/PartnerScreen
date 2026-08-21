import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicPartnerScreenTwin } from './DeterministicTwin';

const regression = process.env.PARTNERSCREEN_RUN_KNOWN_REGRESSIONS === '1' ? test : test.skip;

/**
 * These are desired-product regressions captured from the failed 1d09ae4d APK.
 * They are intentionally quarantined during Mission 0R because 0R builds the
 * laboratory before changing runtime behavior. P0 remediation turns them green
 * one by one; do not rewrite expectations to match the broken implementation.
 */

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
    // Desired behavior: human consent wait is not a media failure.
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

    // Desired behavior: availability is tied to the exact reachable control endpoint generation.
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

    // Desired behavior: POST_NOTIFICATIONS affects notification UX, not MediaProjection eligibility.
    assert.notEqual(twin.bob.screenCaptureCoordinator.getSnapshot().type, 'error');
    assert.equal(twin.bob.sessionController.getSnapshot().type, 'Connected');
  } finally {
    twin.dispose();
  }
});

regression('P0-D: background trusted-listener ownership survives UI/process recreation contract', async () => {
  const twin = new DeterministicPartnerScreenTwin(204);
  try {
    await twin.initialize();
    await twin.pair();
    twin.bob.controlTransport.killProcess();
    await twin.flush();

    await twin.requestScreen(twin.alice);
    await twin.flush();

    // Desired post-P0-D contract: the native trusted listener outlives the React/UI process.
    assert.equal(twin.bob.sessionController.getSnapshot().type, 'IncomingRequest');
  } finally {
    twin.dispose();
  }
});
