import assert from 'node:assert/strict';
import test from 'node:test';
import { peerTransportDisposition, settlePromiseWithTimeout } from '../src/media/MediaRuntimePolicy';

test('transport disposition requires aggregate and ICE connectivity', () => {
  assert.equal(peerTransportDisposition('connected', 'connected'), 'connected');
  assert.equal(peerTransportDisposition('connected', 'completed'), 'connected');
  assert.equal(peerTransportDisposition('connected', 'disconnected'), 'disconnected');
  assert.equal(peerTransportDisposition('disconnected', 'connected'), 'disconnected');
  assert.equal(peerTransportDisposition('failed', 'connected'), 'failed');
  assert.equal(peerTransportDisposition('connected', 'failed'), 'failed');
  assert.equal(peerTransportDisposition('new', 'new'), 'pending');
  assert.equal(peerTransportDisposition('connecting', 'checking'), 'pending');
});

test('settlePromiseWithTimeout returns fulfilled without waiting for timeout', async () => {
  const result = await settlePromiseWithTimeout(Promise.resolve('ok'), 1000);
  assert.deepEqual(result, { status: 'fulfilled', value: 'ok' });
});

test('settlePromiseWithTimeout converts rejection into an explicit result', async () => {
  const denied = new Error('denied');
  const result = await settlePromiseWithTimeout(Promise.reject(denied), 1000);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.error, denied);
});

test('settlePromiseWithTimeout returns timeout for a source that never settles', async () => {
  const source = new Promise<string>(() => undefined);
  const result = await settlePromiseWithTimeout(source, 1);
  assert.deepEqual(result, { status: 'timeout' });
});
