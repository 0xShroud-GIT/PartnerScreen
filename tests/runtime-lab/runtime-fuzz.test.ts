import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverProductError } from '../../src/session/ErrorRecovery';
import { DeterministicPartnerScreenTwin } from './DeterministicTwin';

type Action =
  | 'request'
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'end'
  | 'open_viewer'
  | 'close_viewer'
  | 'media_disconnect'
  | 'media_reconnect'
  | 'listener_fail'
  | 'notification_tap'
  | 'advance_short'
  | 'advance_long'
  | 'recover';

class Random {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 1; }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }
  pick<T>(values: readonly T[]): T { return values[Math.floor(this.next() * values.length)]!; }
}

const ACTIONS: readonly Action[] = [
  'request', 'accept', 'decline', 'cancel', 'end', 'open_viewer', 'close_viewer',
  'media_disconnect', 'media_reconnect', 'listener_fail', 'notification_tap',
  'advance_short', 'advance_long', 'recover',
];

async function recover(device: DeterministicPartnerScreenTwin['alice']): Promise<void> {
  await recoverProductError({
    session: device.sessionController,
    media: device.mediaSessionController,
    capture: device.screenCaptureCoordinator,
    notifications: device.notificationPort,
    pip: { async exitPip() { return true; } },
    keepAwake: { async disable() { return true; } },
  });
}

async function execute(twin: DeterministicPartnerScreenTwin, action: Action, random: Random): Promise<void> {
  const requester = random.next() < 0.5 ? twin.alice : twin.bob;
  const partner = requester === twin.alice ? twin.bob : twin.alice;
  const requesterState = requester.sessionController.getSnapshot();
  const partnerState = partner.sessionController.getSnapshot();

  switch (action) {
    case 'request':
      if (requesterState.type === 'PairedAvailable' && partnerState.type === 'PairedAvailable') {
        await twin.requestScreen(requester).catch(() => undefined);
      }
      break;
    case 'accept':
      if (requesterState.type === 'IncomingRequest') await requester.acceptIncomingAndStartCapture().catch(() => undefined);
      if (partnerState.type === 'IncomingRequest') await partner.acceptIncomingAndStartCapture().catch(() => undefined);
      break;
    case 'decline':
      if (requesterState.type === 'IncomingRequest') await requester.sessionController.declineRequest().catch(() => undefined);
      else if (partnerState.type === 'IncomingRequest') await partner.sessionController.declineRequest().catch(() => undefined);
      break;
    case 'cancel':
      if (requesterState.type === 'OutgoingRequest') await requester.sessionController.cancelRequest().catch(() => undefined);
      else if (partnerState.type === 'OutgoingRequest') await partner.sessionController.cancelRequest().catch(() => undefined);
      break;
    case 'end':
      if (requesterState.type === 'Connected') await requester.sessionController.endSession(requesterState.sessionId).catch(() => undefined);
      else if (partnerState.type === 'Connected') await partner.sessionController.endSession(partnerState.sessionId).catch(() => undefined);
      break;
    case 'open_viewer':
      requester.openViewer();
      partner.openViewer();
      break;
    case 'close_viewer':
      requester.closeViewer();
      partner.closeViewer();
      break;
    case 'media_disconnect': {
      const sessionId = requester.currentSessionId() ?? partner.currentSessionId();
      if (sessionId) twin.mediaFabric.disconnect(sessionId);
      break;
    }
    case 'media_reconnect':
      twin.network.reconnect('media');
      break;
    case 'listener_fail':
      (random.next() < 0.5 ? twin.alice : twin.bob).controlTransport.failCurrentListener();
      break;
    case 'notification_tap':
      requester.notificationPort.tap();
      partner.notificationPort.tap();
      break;
    case 'advance_short':
      await twin.advanceBy(Math.floor(random.next() * 1_500));
      break;
    case 'advance_long':
      await twin.advanceBy(5_000 + Math.floor(random.next() * 10_000));
      break;
    case 'recover':
      if (requesterState.type === 'Error') await recover(requester);
      if (partnerState.type === 'Error') await recover(partner);
      break;
  }

  await twin.flush();

  const a = twin.alice.sessionController.getSnapshot();
  const b = twin.bob.sessionController.getSnapshot();
  const activeA = a.type === 'OutgoingRequest' || a.type === 'IncomingRequest' || a.type === 'Connected' ? a.sessionId : null;
  const activeB = b.type === 'OutgoingRequest' || b.type === 'IncomingRequest' || b.type === 'Connected' ? b.sessionId : null;
  if (activeA && activeB) assert.equal(activeA, activeB, `two peers disagree on active session after ${action}`);

  if (a.type === 'Connected') assert.ok(a.pair, 'connected Alice must retain pair trust');
  if (b.type === 'Connected') assert.ok(b.pair, 'connected Bob must retain pair trust');

  const incomingA = a.type === 'IncomingRequest' ? a.sessionId : null;
  const incomingB = b.type === 'IncomingRequest' ? b.sessionId : null;
  twin.alice.invariants.assertNotification(incomingA, twin.alice.notificationPort.shownSessionId);
  twin.bob.invariants.assertNotification(incomingB, twin.bob.notificationPort.shownSessionId);
}

test('10,000 seeded lifecycle/fault actions preserve runtime ownership invariants', async () => {
  const twin = new DeterministicPartnerScreenTwin(0x10_000);
  const random = new Random(0x5eed_2026);
  try {
    await twin.initialize();
    await twin.pair();
    for (let index = 0; index < 10_000; index += 1) {
      const action = random.pick(ACTIONS);
      try {
        await execute(twin, action, random);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Runtime Lab fuzz failed at step=${index} action=${action} seed=0x5eed2026: ${detail}`, { cause: error });
      }
    }
  } finally {
    twin.dispose();
  }
});
