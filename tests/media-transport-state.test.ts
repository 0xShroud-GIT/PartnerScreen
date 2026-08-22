/**
 * MediaSession transport state machine tests.
 *
 * These tests validate the WebRTC stabilization fixes via source-code inspection
 * (like media-keyframe-protocol.test.ts does for behavioral invariants) because
 * MediaSession imports react-native and react-native-webrtc which require a native
 * runtime. The behavioral tests in media-keyframe-protocol.test.ts handle the
 * live protocol-compat path.
 *
 * Invariants covered:
 * 1. ICE state monitored independently from aggregate connectionState
 * 2. No track.enabled toggle (stops MediaProjection)
 * 3. No forceKeyframe() method
 * 4. No scheduleKeyframeRecovery() / keyframe timer state
 * 5. No synthetic remote stream construction
 * 6. Remote track stop() not called during teardown
 * 7. First-frame gating present (framesDecoded > 0 required for 'live')
 * 8. Diagnostic snapshot preserves lastFailureReason and transport state
 * 9. MEDIA_KEYFRAME_REQUEST compat no-op present
 * 10. MEDIA_RESTART_REQUEST active path present
 * 11. Bounded capture consent timeout (60s)
 * 12. Sender bitrate is quality preference, not session-fatal
 * 13. Recovery scheduling guard prevents concurrent scheduling
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/media/MediaSession.ts', 'utf8');

// ── Track.enabled / Keyframe forcing ─────────────────────────────────────────

test('no track.enabled = false in MediaSession (MediaProjection invariant)', () => {
  assert.equal(
    source.includes('track.enabled = false'),
    false,
    'track.enabled = false must be absent — it stops the MediaProjection foreground service',
  );
});

test('no forceKeyframe() method in MediaSession', () => {
  assert.equal(
    source.includes('forceKeyframe('),
    false,
    'forceKeyframe() must be absent — track.enabled toggling was the implementation and is now removed',
  );
});

test('no MEDIA_KEYFRAME_TOGGLE_MS in MediaSession', () => {
  assert.equal(
    source.includes('MEDIA_KEYFRAME_TOGGLE_MS'),
    false,
    'MEDIA_KEYFRAME_TOGGLE_MS must be absent — keyframe toggle timer is removed',
  );
});

// ── Active keyframe scheduling removed ───────────────────────────────────────

test('no scheduleKeyframeRecovery in MediaSession', () => {
  assert.equal(
    source.includes('scheduleKeyframeRecovery'),
    false,
    'scheduleKeyframeRecovery() must be absent — active MEDIA_KEYFRAME_REQUEST sending is removed',
  );
});

test('no keyframeTimer state in MediaSession', () => {
  assert.equal(
    source.includes('keyframeTimer'),
    false,
    'keyframeTimer must be absent — keyframe scheduling mechanism is removed',
  );
});

test('no keyframeAttempt state in MediaSession', () => {
  assert.equal(
    source.includes('keyframeAttempt'),
    false,
    'keyframeAttempt must be absent — keyframe scheduling mechanism is removed',
  );
});

test('no active MEDIA_KEYFRAME_REQUEST sending in MediaSession', () => {
  assert.equal(
    source.includes("sendMedia(sessionId, 'MEDIA_KEYFRAME_REQUEST'"),
    false,
    'active MEDIA_KEYFRAME_REQUEST sending must be absent — libwebrtc owns keyframes via RTCP PLI/FIR',
  );
});

// ── Synthetic remote stream construction ─────────────────────────────────────

test('no synthetic new MediaStream([event.track]) in MediaSession non-comment code', () => {
  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    assert.equal(
      trimmed.includes('new MediaStream([event.track])'),
      false,
      `synthetic stream construction found in non-comment line: ${trimmed}`,
    );
  }
});

// ── Remote track stop() during teardown ──────────────────────────────────────

test('no remoteStream.getTracks().forEach(stop()) pattern in MediaSession', () => {
  // The remoteStream?.getTracks().forEach(t => t.stop()) anti-pattern was removed.
  // Remote tracks are owned by PeerConnection receivers.
  const remoteStopPattern = /remoteStream\s*\?\s*\.getTracks\s*\(\s*\)\s*\.forEach\s*\(.*\bstop\s*\(/;
  assert.equal(
    remoteStopPattern.test(source),
    false,
    'remote track stop() pattern found — remote tracks are PeerConnection-owned, do not stop them manually',
  );
});

// ── ICE state monitoring ──────────────────────────────────────────────────────

test('oniceconnectionstatechange handler present in MediaSession (independent ICE state monitoring)', () => {
  assert.equal(
    source.includes('oniceconnectionstatechange'),
    true,
    'oniceconnectionstatechange must be present — ICE state must be monitored independently of aggregate connectionState',
  );
});

test('onconnectionstatechange handler present in MediaSession (aggregate state monitoring)', () => {
  assert.equal(
    source.includes('onconnectionstatechange'),
    true,
    'onconnectionstatechange must be present — aggregate connection state must be monitored',
  );
});

// ── First-frame gating ───────────────────────────────────────────────────────

test('firstFrameSeen gating present in MediaSession (requester live only after framesDecoded > 0)', () => {
  assert.equal(
    source.includes('firstFrameSeen'),
    true,
    'firstFrameSeen must be present — requester must not become live until framesDecoded > 0',
  );
});

test('media_first_frame diagnostic event emitted in MediaSession', () => {
  assert.equal(
    source.includes("'media_first_frame'"),
    true,
    'media_first_frame diagnostic must be emitted when first frame is witnessed',
  );
});

test('framesDecoded check present in collectStats for first-frame gating', () => {
  assert.equal(
    source.includes('framesDecoded'),
    true,
    'framesDecoded check must be present in collectStats for first-frame detection',
  );
});

// ── Diagnostic preservation ───────────────────────────────────────────────────

test('lastFailureReason preserved in MediaSession diagnostic snapshot', () => {
  assert.equal(
    source.includes('lastFailureReason'),
    true,
    'lastFailureReason must be preserved for post-mortem analysis across teardown',
  );
});

test('lastTransportSnapshot preserved in MediaSession across teardown', () => {
  assert.equal(
    source.includes('lastTransportSnapshot'),
    true,
    'lastTransportSnapshot must be preserved so failed report retains the last known transport state',
  );
});

test('transport state fields (connectionState, iceConnectionState) captured in getDiagnosticSnapshot', () => {
  assert.equal(
    source.includes('connectionState') && source.includes('iceConnectionState'),
    true,
    'both connectionState and iceConnectionState must be in the diagnostic snapshot',
  );
});

// ── Protocol compat ───────────────────────────────────────────────────────────

test('MEDIA_KEYFRAME_REQUEST compat no-op present in MediaSession.handleSignal', () => {
  // Old peers send this; current Chirp accepts and ignores it (no-op after authentication).
  assert.equal(
    source.includes("'MEDIA_KEYFRAME_REQUEST'"),
    true,
    'MEDIA_KEYFRAME_REQUEST no-op handling must be present in handleSignal for v1 compat',
  );
});

test('MEDIA_RESTART_REQUEST active path present in MediaSession.handleSignal', () => {
  assert.equal(
    source.includes("'MEDIA_RESTART_REQUEST'"),
    true,
    'MEDIA_RESTART_REQUEST active handling must be present in handleSignal',
  );
});

// ── Capture consent timeout ───────────────────────────────────────────────────

test('capture consent timeout uses MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS (60s bound)', () => {
  assert.equal(
    source.includes('MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS'),
    true,
    'MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS must be present — bounded 60s consent timeout',
  );
  // Verify orphaned late consent result is cleaned up
  assert.equal(
    source.includes("late) => late.getTracks().forEach((track) => track.stop())"),
    true,
    'orphaned late consent stream must be cleaned up to prevent MediaProjection leak',
  );
});

// ── Sender bitrate quality preference ─────────────────────────────────────────

test('configureSender failure is non-fatal and records diagnostic (never ends sharing)', () => {
  // setParameters failure must record media_bitrate_parameters_failed, not fail the session.
  assert.equal(
    source.includes("'media_bitrate_parameters_failed'"),
    true,
    'media_bitrate_parameters_failed diagnostic must be emitted on setParameters failure',
  );
  assert.equal(
    source.includes('senderBitrateParameters('),
    true,
    'senderBitrateParameters() must be called from configureSender',
  );
});

// ── Recovery scheduling guard ─────────────────────────────────────────────────

test('scheduleRecovery guards against concurrent scheduling via restartTimer check', () => {
  // The guard `if (...this.restartTimer)` prevents duplicate concurrent recovery scheduling.
  assert.equal(
    source.includes('this.restartTimer') && source.includes('restartTimer = null'),
    true,
    'restartTimer guard must be present to prevent duplicate concurrent recovery scheduling',
  );
});

// ── Trickle ICE ──────────────────────────────────────────────────────────────

test('ICE candidate queue is flushed after setRemoteDescription (Trickle ICE preserved)', () => {
  assert.equal(
    source.includes('flushRemoteCandidates'),
    true,
    'flushRemoteCandidates must be called after setRemoteDescription — Trickle ICE candidate queue',
  );
  assert.equal(
    source.includes('pendingRemoteCandidates'),
    true,
    'pendingRemoteCandidates queue must be present for pre-remote-description candidate buffering',
  );
});

// ── ICE restart via offer ─────────────────────────────────────────────────────

test('ICE restart uses createOffer({ iceRestart: true }) (no manual restart hack)', () => {
  assert.equal(
    source.includes('createOffer(iceRestart ? { iceRestart: true } : undefined)'),
    true,
    'ICE restart must use native createOffer iceRestart option, not manual candidate manipulation',
  );
});
