import assert from 'node:assert/strict';
import test from 'node:test';
import { IncomingRequestNotifier } from '../src/request/IncomingRequestNotifier';
import { IncomingRequestIngress, shouldOpenIncomingRequest } from '../src/request/incomingRequestRoute';
import { canPromptNotificationPermission, notificationsAreAvailable, type NotificationPermissionState } from '../src/request/NotificationPermission';
import type { SessionState } from '../src/session/SessionState';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';

const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '44444444-4444-4444-8444-444444444444', partnerDeviceId: '22222222-2222-4222-8222-222222222222', partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };
const sessionId = '33333333-3333-4333-8333-333333333333';
async function settle(): Promise<void> { for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }

test('permission states distinguish requestable, granted, denied and dismissed', () => {
  assert.equal(canPromptNotificationPermission('unknown'), true);
  assert.equal(canPromptNotificationPermission('requestable'), true);
  assert.equal(canPromptNotificationPermission('dismissed'), true);
  assert.equal(canPromptNotificationPermission('granted'), false);
  assert.equal(canPromptNotificationPermission('denied'), false);
  assert.equal(notificationsAreAvailable('granted'), true);
  assert.equal(notificationsAreAvailable('denied'), false);
});

test('incoming notifier never asks for notification permission', async () => {
  let permissionCalls = 0;
  const fakeNotifications = {
    async showRequestNotification(): Promise<boolean> { return false; },
    async clearRequestNotification(): Promise<boolean> { return true; },
    async ensurePermission(): Promise<boolean> { permissionCalls += 1; return false; },
  };
  const fakeSessionState: { value: SessionState } = { value: { type: 'IncomingRequest', pair, sessionId, expiresAt: '2026-08-19T00:01:00.000Z' } };
  const fakeSession = { getSnapshot: () => fakeSessionState.value, subscribe: () => () => undefined };
  const notifier = new IncomingRequestNotifier(fakeSession, fakeNotifications, { async append() {} });
  await settle();
  assert.equal(permissionCalls, 0);
  assert.equal(notifier.getActiveSessionId(), null);
  notifier.dispose();
});

test('stale notification ids are ignored by the single ingress owner', () => {
  const ingress = new IncomingRequestIngress();
  const incoming: SessionState = { type: 'IncomingRequest', pair, sessionId, expiresAt: '2026-08-19T00:01:00.000Z' };
  let opens = 0;
  assert.equal(ingress.route(sessionId, incoming, () => { opens += 1; }), true);
  assert.equal(ingress.route(sessionId, incoming, () => { opens += 1; }), false);
  assert.equal(ingress.route('88888888-8888-4888-8888-888888888888', incoming, () => { opens += 1; }), false);
  assert.equal(shouldOpenIncomingRequest({ type: 'PairedOffline', pair }, sessionId), false);
  assert.equal(opens, 1);
});
