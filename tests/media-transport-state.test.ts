import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/media/MediaSession.ts', 'utf8');

test('MediaSession delegates combined transport health to peerTransportDisposition', () => {
  assert.equal(source.includes('peerTransportDisposition('), true);
  assert.equal(source.includes('handlePeerTransportState('), true);
  assert.equal(source.includes('onconnectionstatechange = handleTransport'), true);
  assert.equal(source.includes('oniceconnectionstatechange = handleTransport'), true);
});

test('requester first-frame gating remains tied to framesDecoded', () => {
  assert.equal(source.includes('(next.framesDecoded ?? 0) > 0'), true);
  assert.equal(source.includes("await this.record('media_first_frame')"), true);
});

test('MediaSession archives the complete diagnostic snapshot before teardown', () => {
  assert.equal(source.includes('archivedDiagnostic'), true);
  assert.equal(source.includes('archiveCurrentDiagnosticSnapshot();'), true);
  assert.equal(source.includes('cloneDiagnostic(this.currentDiagnosticSnapshot())'), true);
  assert.equal(source.includes('this.archivedDiagnostic = null;'), true, 'new media sessions must clear the prior archive');
});

test('capture consent uses bounded settlement and native-disposes late or partial grants', () => {
  assert.equal(source.includes('settlePromiseWithTimeout(consent, MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS)'), true);
  assert.equal(source.includes("consentResult.status === 'rejected'"), true);
  assert.equal(source.includes("consentResult.status === 'timeout'"), true);
  assert.equal(source.includes('(late) => this.disposeOwnedLocalStream(late)'), true);
  assert.equal(source.includes('this.disposeOwnedLocalStream(stream);'), true);
  assert.equal(source.includes('stream.release()'), true);
});

test('capture adoption revalidates the same Connected sharer session after Android consent', () => {
  assert.equal(source.includes('const currentProduct = this.session.getSnapshot();'), true);
  assert.equal(source.includes("currentProduct.type !== 'Connected'"), true);
  assert.equal(source.includes("currentProduct.role !== 'sharer'"), true);
  assert.equal(source.includes('currentProduct.sessionId !== sessionId'), true);
});

test('deferred stats can mutate and rearm only while the same peer and session still own media', () => {
  assert.equal(source.includes('await this.collectStats(peer, sessionId);'), true);
  assert.equal(source.includes('this.peer !== peer'), true);
  assert.equal(source.includes('this.peerSessionId !== sessionId'), true);
  assert.equal(source.includes("product.type !== 'Connected'"), true);
  assert.equal(source.includes('product.sessionId !== sessionId'), true);
  assert.equal(source.includes('if (this.peer === peer && this.peerSessionId === sessionId)'), true);
});

test('confirmed reconnection cancels delayed ICE recovery and stale queued attempts are rejected', () => {
  assert.equal(source.includes('if (this.restartTimer) clearTimeout(this.restartTimer);'), true);
  assert.equal(source.includes('this.restartTimer = null;'), true);
  assert.equal(source.includes('this.restartAttempt !== attempt'), true);
});

test('signaling operations record operation-specific failures', () => {
  for (const operation of [
    "rtcOperation('createOffer'",
    "rtcOperation('setLocalDescription(offer)'",
    "rtcOperation('send SDP_OFFER'",
    "rtcOperation('setRemoteDescription(offer)'",
    "rtcOperation('createAnswer'",
    "rtcOperation('setLocalDescription(answer)'",
    "rtcOperation('send SDP_ANSWER'",
    "rtcOperation('setRemoteDescription(answer)'",
    "rtcOperation('addIceCandidate'",
  ]) assert.equal(source.includes(operation), true, `missing ${operation}`);
  assert.equal(source.includes("noteFailure('send ICE_CANDIDATE'"), true);
});

test('remote receiver teardown does not stop remote tracks', () => {
  const remoteStopPattern = /remoteStream\s*\?\s*\.getTracks\s*\(\s*\)\s*\.forEach\s*\([^\n]*\.stop\s*\(/;
  assert.equal(remoteStopPattern.test(source), false);
  assert.equal(source.includes('this.remoteStreamURL = null;'), true);
  assert.equal(source.includes('this.remoteStream = null;'), true);
  assert.equal(source.includes('this.closePeer();'), true);
});

test('unsafe application-level keyframe machinery remains absent', () => {
  assert.equal(/\.enabled\s*=\s*false/.test(source), false);
  assert.equal(source.includes('forceKeyframe('), false);
  assert.equal(source.includes('scheduleKeyframeRecovery'), false);
  assert.equal(source.includes("sendMedia(sessionId, 'MEDIA_KEYFRAME_REQUEST'"), false);
});