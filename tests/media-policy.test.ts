import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureResolutionScale,
  classifyIceCandidate,
  MEDIA_DISCONNECTED_GRACE_MS,
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
  assert.deepEqual([...MEDIA_RESTART_DELAYS_MS], [500, 1_000, 2_000]);
});

test('capture scale caps the physical long edge at 1600 without upscaling', () => {
  assert.equal(captureResolutionScale(1080, 2400), 1600 / 2400);
  assert.equal(captureResolutionScale(720, 1280), 1);
  assert.equal(captureResolutionScale(0, 0), 1);
});

test('sender bitrate policy never fabricates encodings when the sender reports none', () => {
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

test('ICE policy accepts only private IPv4 UDP host candidates', () => {
  const accepted = classifyIceCandidate('candidate:1 1 UDP 2122260223 192.168.1.8 50000 typ host generation 0');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.reason, 'private_ipv4_host_udp');

  assert.equal(classifyIceCandidate('candidate:1 1 TCP 2122260223 192.168.1.8 9 typ host tcptype active').accepted, false);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2122260223 8.8.8.8 50000 typ host').accepted, false);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2122260223 192.168.1.8 50000 typ srflx').accepted, false);
  assert.equal(classifyIceCandidate('candidate:1 1 UDP 2122260223 fd00::1 50000 typ host').accepted, false);
});
