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

test('MEDIA_RESTART_REQUEST remains an authenticated media recovery command', () => {
  assert.equal(isMediaControlMessageType('MEDIA_RESTART_REQUEST'), true);
  const decoded = decodeControlMessage(JSON.stringify({
    ...base,
    type: 'MEDIA_RESTART_REQUEST',
    payload: { reason: 'connection_lost' },
  }));
  assert.equal(decoded.type, 'MEDIA_RESTART_REQUEST');
});

test('legacy app-level keyframe commands are rejected', () => {
  assert.equal(isMediaControlMessageType('MEDIA_KEYFRAME_REQUEST'), false);
  assert.throws(() => decodeControlMessage(JSON.stringify({
    ...base,
    type: 'MEDIA_KEYFRAME_REQUEST',
    payload: { reason: 'first_frame' },
  })));
});
