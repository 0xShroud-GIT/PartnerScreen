/**
 * Protocol-v1 MEDIA_KEYFRAME_REQUEST backward-compatibility tests.
 *
 * Older released Chirp builds sent MEDIA_KEYFRAME_REQUEST with { reason: 'first_frame' }.
 * Current Chirp MUST:
 *   - decode and validate the v1 message (payload bounded, authenticated, sequence-checked)
 *   - treat it as a no-op (never toggle capture, never call track.enabled, never force a keyframe)
 *   - NOT send this command (libwebrtc owns RTCP PLI/FIR/keyframe behavior)
 *   - NOT close the authenticated session when a legacy peer sends it
 *
 * MEDIA_RESTART_REQUEST remains active for ICE recovery.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeControlMessage } from '../src/protocol/ControlCodec';
import { CONTROL_PROTOCOL_VERSION, isMediaControlMessageType } from '../src/protocol/ControlMessage';

const base = {
  version: CONTROL_PROTOCOL_VERSION,
  messageId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  senderDeviceId: '33333333-3333-4333-8333-333333333333',
  sequence: 1,
  timestamp: '2026-08-22T10:00:00.000Z',
};

// ── COMPATIBILITY: legacy v1 message must still decode ────────────────────────

test('MEDIA_KEYFRAME_REQUEST is a recognized authenticated media control type (v1 compat decode)', () => {
  // Old peers send this; it must decode without error so the session stays alive.
  assert.equal(isMediaControlMessageType('MEDIA_KEYFRAME_REQUEST'), true);
  const decoded = decodeControlMessage(JSON.stringify({
    ...base,
    type: 'MEDIA_KEYFRAME_REQUEST',
    payload: { reason: 'first_frame' },
  }));
  assert.equal(decoded.type, 'MEDIA_KEYFRAME_REQUEST');
  if (decoded.type === 'MEDIA_KEYFRAME_REQUEST') assert.equal(decoded.payload.reason, 'first_frame');
});

test('MEDIA_KEYFRAME_REQUEST rejects unsupported reasons and extra fields (v1 compat bounds)', () => {
  // Only { reason: 'first_frame' } was the v1 wire format. Anything else must still be rejected
  // so that a malformed message cannot pass authentication.
  assert.throws(() => decodeControlMessage(JSON.stringify({
    ...base,
    type: 'MEDIA_KEYFRAME_REQUEST',
    payload: { reason: 'connection_lost' },
  })));
  assert.throws(() => decodeControlMessage(JSON.stringify({
    ...base,
    type: 'MEDIA_KEYFRAME_REQUEST',
    payload: { reason: 'first_frame', rawCandidate: '192.168.1.2' },
  })));
});

// ── ACTIVE: MEDIA_RESTART_REQUEST remains operational ────────────────────────

test('MEDIA_RESTART_REQUEST is a recognized authenticated media control type (active)', () => {
  assert.equal(isMediaControlMessageType('MEDIA_RESTART_REQUEST'), true);
  const decoded = decodeControlMessage(JSON.stringify({
    ...base,
    type: 'MEDIA_RESTART_REQUEST',
    payload: { reason: 'connection_lost' },
  }));
  assert.equal(decoded.type, 'MEDIA_RESTART_REQUEST');
  if (decoded.type === 'MEDIA_RESTART_REQUEST') assert.equal(decoded.payload.reason, 'connection_lost');
});

test('MEDIA_RESTART_REQUEST rejects invalid reasons', () => {
  assert.throws(() => decodeControlMessage(JSON.stringify({
    ...base,
    type: 'MEDIA_RESTART_REQUEST',
    payload: { reason: 'first_frame' },
  })));
});

// ── SOURCE GUARD: current Chirp must not contain active keyframe sending code ──

test('MediaSession source must not contain active keyframe forcing or MEDIA_KEYFRAME_REQUEST sending', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/media/MediaSession.ts', 'utf8');

  // No track.enabled toggle — toggling enabled stops the MediaProjection foreground service
  assert.equal(
    source.includes('track.enabled = false'),
    false,
    'track.enabled = false found — this stops MediaProjection and causes capture_revoked',
  );

  // No active MEDIA_KEYFRAME_REQUEST sending
  assert.equal(
    source.includes("sendMedia(sessionId, 'MEDIA_KEYFRAME_REQUEST'"),
    false,
    'active MEDIA_KEYFRAME_REQUEST send found — current Chirp must not send this command',
  );

  // No keyframe timer state (scheduleKeyframeRecovery was the mechanism that sent the commands)
  assert.equal(
    source.includes('keyframeTimer'),
    false,
    'keyframeTimer found — scheduleKeyframeRecovery mechanism must be removed',
  );
  assert.equal(
    source.includes('keyframeAttempt'),
    false,
    'keyframeAttempt found — scheduleKeyframeRecovery mechanism must be removed',
  );

  // No forceKeyframe method (the method that toggled track.enabled)
  assert.equal(
    source.includes('forceKeyframe('),
    false,
    'forceKeyframe() found — keyframe forcing via track.enabled must be removed',
  );

  // No synthetic remote stream construction
  assert.equal(
    source.includes('new MediaStream([event.track])'),
    false,
    'synthetic new MediaStream([event.track]) found — must use event.streams[0] instead',
  );

  // Legacy compat no-op handling IS present for backward compatibility
  assert.equal(
    source.includes('MEDIA_KEYFRAME_REQUEST'),
    true,
    'MEDIA_KEYFRAME_REQUEST compat no-op must be present in handleSignal',
  );
});

test('MediaSession source must contain ICE state monitoring independent of aggregate connection state', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/media/MediaSession.ts', 'utf8');

  // Both aggregate and ICE state must be monitored
  assert.equal(source.includes('onconnectionstatechange'), true, 'onconnectionstatechange handler required');
  assert.equal(source.includes('oniceconnectionstatechange'), true, 'oniceconnectionstatechange handler required for independent ICE failure detection');
});

test('MediaSession source must not call stop() on remote tracks during teardown', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/media/MediaSession.ts', 'utf8');
  // The remoteStream?.getTracks().forEach(track => track.stop()) pattern was removed.
  // Remote tracks are owned by PeerConnection receivers; calling stop() on them violates
  // the receiver lifecycle in react-native-webrtc.
  // Check that the remoteStream?.getTracks().forEach(t => t.stop()) anti-pattern is absent.
  // Use a line-by-line check to avoid false positives from greedy cross-file regex.
  const remoteStopPattern = /remoteStream\s*\?\s*\.getTracks\s*\(\s*\)\s*\.forEach\s*\(.*\bstop\s*\(/;
  assert.equal(
    remoteStopPattern.test(source),
    false,
    'remote track stop() during teardown found — remote tracks are owned by PeerConnection',
  );
});
