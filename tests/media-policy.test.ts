import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureResolutionScale,
  classifyDisplayMediaError,
  classifyIceCandidate,
  MEDIA_DISCONNECTED_GRACE_MS,
  MEDIA_KEYFRAME_REQUEST_DELAYS_MS,
  MEDIA_RESTART_DELAYS_MS,
  SCREEN_FPS,
  SCREEN_LONG_EDGE_PX,
  SCREEN_MAX_BITRATE_BPS,
  SCREEN_MIN_BITRATE_BPS,
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

test('capture scale caps the physical long edge at 1600 without upscaling', () => {
  assert.equal(captureResolutionScale(1080, 2400), 1600 / 2400);
  assert.equal(captureResolutionScale(720, 1280), 1);
  assert.equal(captureResolutionScale(0, 0), 1);
});

test('display-media failure distinguishes user denial from technical capture failure', () => {
  // react-native-webrtc rejects getDisplayMedia with a DOMException whose name string
  // is `NotAllowedError` for user denial and `AbortError`/arbitrary messages otherwise.
  assert.equal(classifyDisplayMediaError({ name: 'NotAllowedError', message: 'NotAllowedError' }), 'user_denied');
  assert.equal(classifyDisplayMediaError({ message: 'NotAllowedError' }), 'user_denied');
  assert.equal(classifyDisplayMediaError({ code: 'DOMException', message: 'NotAllowedError' }), 'user_denied');

  assert.equal(classifyDisplayMediaError({ name: 'AbortError', message: 'AbortError' }), 'capture_failed');
  assert.equal(classifyDisplayMediaError({ message: 'ScreenTrack is null.' }), 'capture_failed');
  assert.equal(classifyDisplayMediaError(new Error('MediaProjectionManager is null.')), 'capture_failed');
  assert.equal(classifyDisplayMediaError(undefined), 'capture_failed');
  assert.equal(classifyDisplayMediaError(null), 'capture_failed');
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
