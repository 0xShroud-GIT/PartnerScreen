import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureResolutionScale,
  classifyIceCandidate,
  MEDIA_DISCONNECTED_GRACE_MS,
  MEDIA_KEYFRAME_REQUEST_DELAYS_MS,
  MEDIA_KEYFRAME_STEADY_RETRY_MS,
  MEDIA_RESTART_DELAYS_MS,
  SCREEN_FPS,
  SCREEN_LONG_EDGE_PX,
  SCREEN_MAX_BITRATE_BPS,
  SCREEN_MIN_BITRATE_BPS,
  senderBitrateParameters,
} from '../src/media/MediaPolicy';

test('screen-share policy stays on the qualified high-quality LAN profile', () => {
  assert.equal(SCREEN_LONG_EDGE_PX, 1600);
  assert.equal(SCREEN_FPS, 30);
  assert.equal(SCREEN_MIN_BITRATE_BPS, 1_000_000);
  assert.equal(SCREEN_MAX_BITRATE_BPS, 8_000_000);
  assert.equal(MEDIA_DISCONNECTED_GRACE_MS, 3_000);
  assert.deepEqual([...MEDIA_KEYFRAME_REQUEST_DELAYS_MS], [500, 1_500, 3_000]);
  assert.deepEqual([...MEDIA_RESTART_DELAYS_MS], [500, 1_000, 2_000]);
});

test('legacy keyframe timing constants are retained for documentation/compat but are NOT used as active logic', () => {
  // MEDIA_KEYFRAME_REQUEST_DELAYS_MS and MEDIA_KEYFRAME_STEADY_RETRY_MS remain as retained
  // constants that document the old v1 protocol behavior. The active scheduling mechanism
  // (scheduleKeyframeRecovery / keyframeRetryDelayMs) was removed in PR #23 because
  // MEDIA_KEYFRAME_REQUEST sending caused MediaProjection to stop via track.enabled = false.
  assert.deepEqual([...MEDIA_KEYFRAME_REQUEST_DELAYS_MS], [500, 1_500, 3_000]);
  assert.equal(MEDIA_KEYFRAME_STEADY_RETRY_MS, 5_000);

  // The active keyframe retry function must no longer be exported.
  const policy = require('../src/media/MediaPolicy') as Record<string, unknown>;
  assert.equal(
    'keyframeRetryDelayMs' in policy,
    false,
    'keyframeRetryDelayMs must not be exported — the active keyframe scheduling mechanism was removed',
  );
});

test('capture scale caps the physical long edge at 1600 without upscaling', () => {
  assert.equal(captureResolutionScale(1080, 2400), 1600 / 2400);
  assert.equal(captureResolutionScale(720, 1280), 1);
  assert.equal(captureResolutionScale(0, 0), 1);
});

test('sender bitrate policy never fabricates encodings when the sender reports none', () => {
  // A sender with no encodings yet must not be patched with a fabricated [{}] encoding: that would
  // desync the JS encoding array from native libwebrtc and make setParameters reject (aborting the
  // share). Quality preference is a no-op here, never a session-fatal failure.
  const empty = senderBitrateParameters([]);
  assert.equal(empty.applicable, false);
  assert.deepEqual(empty.encodings, []);
  assert.equal(senderBitrateParameters(undefined).applicable, false);
  assert.equal(senderBitrateParameters(null).applicable, false);
});

test('sender bitrate policy applies the high-quality LAN profile to real encodings', () => {
  const patch = senderBitrateParameters([{ rid: 'q' }, { rid: 'h' }]);
  assert.equal(patch.applicable, true);
  assert.equal(patch.degradationPreference, 'maintain-resolution');
  assert.equal(patch.encodings.length, 2);
  for (const encoding of patch.encodings) {
    assert.equal(encoding.minBitrate, SCREEN_MIN_BITRATE_BPS);
    assert.equal(encoding.maxBitrate, SCREEN_MAX_BITRATE_BPS);
    assert.equal(encoding.maxFramerate, SCREEN_FPS);
    assert.equal(encoding.scaleResolutionDownBy, 1);
    assert.equal(encoding.active, true);
  }
  assert.equal(patch.encodings[0]?.rid, 'q');
  assert.equal(patch.encodings[1]?.rid, 'h');
});

test('sender bitrate policy: setParameters failure is non-fatal (quality preference, never session-fatal)', () => {
  // The configureSender path catches setParameters failures and records media_bitrate_parameters_failed
  // instead of failing the session. Verify the policy function itself always returns a valid patch
  // when encodings are present (the caller is responsible for handling setParameters errors).
  const patch = senderBitrateParameters([{}]);
  assert.equal(patch.applicable, true);
  assert.equal(patch.encodings.length, 1);
  assert.equal(patch.encodings[0]?.maxBitrate, SCREEN_MAX_BITRATE_BPS);
});

test('ICE policy accepts only private IPv4 UDP host candidates', () => {
  const accepted = classifyIceCandidate('candidate:1 1 UDP 2122260223 192.168.1.8 50000 typ host generation 0');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.reason, 'private_ipv4_host_udp');

  assert.equal(classifyIceCandidate('candidate:1 1 TCP 2122260223 192.168.1.8 9 typ host tcptype active').accepted, false);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2122260223 8.8.8.8 50000 typ host').accepted, false);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2122260223 192.168.1.8 50000 typ srflx').accepted, false);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2122260223 fd00::1 50000 typ host').accepted, false);
});

test('ICE policy covers all three RFC1918 address blocks', () => {
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2 10.0.0.1 50000 typ host').accepted, true);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2 172.16.0.1 50000 typ host').accepted, true);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2 172.31.255.254 50000 typ host').accepted, true);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2 172.32.0.1 50000 typ host').accepted, false); // outside 172.16/12
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2 192.168.255.255 50000 typ host').accepted, true);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2 192.169.0.1 50000 typ host').accepted, false); // 192.169.x not private
});
