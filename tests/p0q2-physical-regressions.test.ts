import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PartnerScreenTwin } from './runtime-lab/PartnerScreenTwin';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

test('P0Q2: production bridge forwards sanitized ICE and renderer observability', () => {
  const bridge = source('src/platform/media/ExpoWebRtcMedia.ts');
  assert.ok(bridge.includes("event.type === 'ice_state'"));
  assert.ok(bridge.includes("event.type === 'ice_classified'"));
  assert.ok(bridge.includes("event.type === 'renderer'"));
  assert.ok(bridge.includes('sanitizeIceClassification(event.classification)'));
  assert.ok(bridge.includes('getPhysicalDiagnosticSnapshot'));

  const report = source('src/application/DiagnosticsReport.ts');
  assert.ok(report.includes('lastMedia:'));
  assert.ok(report.includes('iceConnectionState='));
  assert.ok(report.includes('localCandidatesRejected='));
  assert.ok(report.includes('lastCandidateRejection='));
  assert.ok(report.includes('rendererEverAttached='));
  assert.ok(!report.includes('candidate='), 'diagnostic report must not expose raw ICE candidates');
});

test('P0Q2: requester renderer binding never performs add/remove sink work synchronously on the UI view callbacks', () => {
  const nativeView = source('modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/PartnerRemoteVideoView.kt');
  assert.ok(nativeView.includes('PartnerScreenRendererBinding'));
  assert.ok(nativeView.includes('bindingExecutor.execute'));
  assert.ok(nativeView.includes('private fun queueAttach'));
  assert.ok(nativeView.includes('private fun queueDetach'));

  const bindBody = nativeView.slice(nativeView.indexOf('fun bindSession'), nativeView.indexOf('fun bindTrackEpoch'));
  assert.ok(!bindBody.includes('WebRtcEngine.getInstance().attachRenderer'));
  assert.ok(!bindBody.includes('WebRtcEngine.getInstance().detachRenderer'));

  const viewer = source('app/viewer.tsx');
  assert.ok(viewer.includes('rendererMountEpoch'));
  assert.ok(viewer.includes('lastRenderedEpoch'));
  assert.ok(viewer.includes('trackEpoch={rendererEpoch}'));
  assert.ok(!viewer.includes('key={`${requesterSessionId}:${rendererEpoch}`}'), 'pre-LIVE track changes must not force direct renderer remounts');
});

test('P0Q2: pairing releases temporary QR sockets before normal paired networking takes ownership', async () => {
  const twin = new PartnerScreenTwin(0x50414952);
  try {
    await twin.initialize();
    await twin.pair();

    assert.equal(twin.alice.pairingService.getSnapshot().kind, 'paired');
    assert.equal(twin.bob.pairingService.getSnapshot().kind, 'paired');
    assert.equal(twin.alice.pairingTransport.endpoint, null, 'creator temporary pairing listener must be gone');
    assert.equal(twin.bob.pairingTransport.endpoint, null, 'scanner must not retain a pairing listener');
    assert.equal(twin.alice.pairingTransport.links.size, 0, 'creator temporary pairing connection must be closed');
    assert.equal(twin.bob.pairingTransport.links.size, 0, 'scanner temporary pairing connection must be closed');
    assert.ok(twin.alice.controlTransport.endpoint, 'normal trusted control listener should be active after cleanup');
    assert.ok(twin.bob.controlTransport.endpoint, 'normal trusted control listener should be active after cleanup');
  } finally {
    twin.dispose();
  }
});

test('P0Q2: terminal media failure ends Connected session and cannot restart recovery', async () => {
  const twin = new PartnerScreenTwin(0x50305132);
  try {
    await twin.initialize();
    await twin.pair();
    twin.network.disconnect('media');

    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();

    await twin.flushUntil(() => {
      return twin.alice.sessionController.getSnapshot().type === 'Error'
        || twin.bob.sessionController.getSnapshot().type === 'Error';
    });
    await twin.flush();

    assert.notEqual(twin.alice.sessionController.getSnapshot().type, 'Connected');
    assert.notEqual(twin.bob.sessionController.getSnapshot().type, 'Connected');
    assert.ok(twin.alice.diagnostics.count('media_failed') + twin.bob.diagnostics.count('media_failed') >= 1);

    const reconnectsBefore = twin.alice.diagnostics.count('media_reconnect_attempt')
      + twin.bob.diagnostics.count('media_reconnect_attempt');
    await twin.advanceBy(60_000);
    const reconnectsAfter = twin.alice.diagnostics.count('media_reconnect_attempt')
      + twin.bob.diagnostics.count('media_reconnect_attempt');
    assert.equal(reconnectsAfter, reconnectsBefore, 'no recovery attempt may occur after terminal media failure');
  } finally {
    twin.dispose();
  }
});
