import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestViewerNavigation, viewerOwnership } from '../src/presentation/ViewerOwnership';
import { IncomingRequestIngress, parseIncomingRequestSessionId } from '../src/request/incomingRequestRoute';
import { PartnerScreenTwin } from './runtime-lab/PartnerScreenTwin';
import { MEDIA_CONNECTION_TIMEOUT_MS } from '../src/media/MediaSessionController';

const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function validStats(bytes = 1000) {
  return {
    bytesSent: bytes,
    bytesReceived: bytes,
    framesEncoded: 1,
    framesDecoded: 1,
    frameWidth: 1280,
    frameHeight: 720,
    candidatePairState: 'succeeded',
    bitrateParametersState: 'applied',
  };
}

test('P0-F: production viewer navigation reserves before push so auto/manual converge', () => {
  viewerOwnership.release(sessionA);
  viewerOwnership.cancelReservation(sessionA);
  let pushes = 0;
  assert.equal(requestViewerNavigation(sessionA, () => { pushes += 1; }), true);
  assert.equal(viewerOwnership.getPhase(sessionA), 'reserved');
  assert.equal(requestViewerNavigation(sessionA, () => { pushes += 1; }), false);
  assert.equal(pushes, 1, 'duplicate Connected/manual tap before mount must not push again');
  assert.equal(viewerOwnership.mount(sessionA), true);
  assert.equal(requestViewerNavigation(sessionA, () => { pushes += 1; }), false);
  assert.equal(pushes, 1);
  assert.equal(viewerOwnership.release(sessionA), true);
});

test('P0-F: production Home and Viewer use the reservation/mount lifecycle', () => {
  const home = readFileSync(join(process.cwd(), 'app/index.tsx'), 'utf8');
  const viewer = readFileSync(join(process.cwd(), 'app/viewer.tsx'), 'utf8');
  assert.ok(home.includes('requestViewerNavigation('), 'Home must reserve before router.push');
  assert.ok(viewer.includes('viewerOwnership.mount('), 'Viewer must adopt the reservation on mount');
  assert.ok(viewer.includes('viewerOwnership.release('), 'Viewer must release the mounted owner');
});

test('P0-F: Viewer binds and resets frame geometry for replacement epochs', () => {
  const viewer = readFileSync(join(process.cwd(), 'app/viewer.tsx'), 'utf8');
  assert.ok(viewer.includes('onFrameResolution'));
  assert.ok(viewer.includes('setVideoGeometry({ width, height, rotation })'));
  assert.ok(viewer.includes('setVideoGeometry(null)'));
  assert.ok(viewer.includes('[requesterSessionId, rendererEpoch]'));
});

test('P0-E: IncomingRequestIngress dedupes the same current request from multiple mechanisms', () => {
  const ingress = new IncomingRequestIngress();
  const state = { type: 'IncomingRequest' as const, pair: { partnerDeviceId: 'x', partnerDeviceName: 'y', pairId: 'z', pairedAt: '', schemaVersion: 1, protocolVersion: 1, status: 'confirmed' as const } as any, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: new Date(Date.now() + 30000).toISOString() };
  let navigations = 0;
  const open = () => { navigations += 1; };
  const current = state.sessionId;
  assert.equal(ingress.route(current, state as any, open), true);
  assert.equal(ingress.route(parseIncomingRequestSessionId(`partnerscreen://incoming-request/${current}`), state as any, open), false);
  assert.equal(ingress.route('dddddddd-dddd-4ddd-8ddd-dddddddddddd', state as any, open), false);
  const replacement = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  assert.equal(ingress.route(replacement, { ...state, sessionId: replacement } as any, open), true);
  assert.equal(navigations, 2);
});

test('P0-E: production root routes all cold/warm request sources through one ingress', () => {
  const content = readFileSync(join(process.cwd(), 'app/_layout.tsx'), 'utf8');
  assert.ok(content.includes('const incomingIngress = new IncomingRequestIngress()'));
  assert.ok(content.includes('incomingIngress.route'));
  assert.ok(content.includes('Linking.getInitialURL'));
  assert.ok(content.includes('Linking.addEventListener'));
  assert.ok(content.includes('consumeLaunchSessionId'));
  assert.ok(content.includes('subscribeOpened'));
});

test('P0-E: Home keeps hook order invariant and owns notification prompting in foreground UI', () => {
  const content = readFileSync(join(process.cwd(), 'app/index.tsx'), 'utf8');
  const loadingReturn = content.indexOf('if (identityState.loading) return');
  assert.ok(loadingReturn > 0);
  assert.equal(content.indexOf('useEffect(', loadingReturn + 1), -1, 'no hook may appear after the conditional loading return');
  assert.ok(content.includes("AppState.addEventListener('change'"));
  assert.ok(content.includes('requestPermissionFromForeground'));
  assert.ok(content.includes('Linking.openSettings'));

  const appServices = readFileSync(join(process.cwd(), 'src/application/AppServices.ts'), 'utf8');
  assert.ok(!appServices.includes('requestPermissionFromForeground'), 'AppServices must never own permission prompting');
});

test('P0-E: native notification production consumes the same tested codec/policy helpers', () => {
  const base = join(process.cwd(), 'modules/partner-request-notification/android/src/main/java/com/partnerscreen/requestnotification');
  const module = readFileSync(join(base, 'PartnerRequestNotificationModule.kt'), 'utf8');
  const codec = readFileSync(join(base, 'IncomingRequestIntentCodec.kt'), 'utf8');
  const policy = readFileSync(join(base, 'NotificationPermissionPolicy.kt'), 'utf8');
  assert.ok(module.includes('IncomingRequestIntentCodec.buildLaunchIntent'));
  assert.ok(module.includes('IncomingRequestIntentCodec.take'));
  assert.ok(module.includes('NotificationPermissionPolicy.capability'));
  assert.ok(module.includes('NotificationPermissionPolicy.isAvailable'));
  assert.ok(!codec.includes('fatal: path'));
  assert.ok(!policy.includes('fatal: path'));
});

test('P0-D: full process death destroys callbacks, endpoint and native-process trusted-presence state', async () => {
  const twin = new PartnerScreenTwin(999);
  try {
    await twin.initialize();
    await twin.pair();
    const endpoint = twin.bob.controlTransport.endpoint;
    assert.ok(endpoint);
    assert.equal(twin.bob.controlTransport.trustedPresenceActive, true);
    assert.ok(twin.bob.controlTransport.callbackCount() > 0);

    twin.bob.controlTransport.killProcess();

    assert.equal(twin.bob.controlTransport.callbackCount(), 0);
    assert.equal(twin.bob.controlTransport.endpoint, null);
    assert.equal(twin.bob.controlTransport.trustedPresenceActive, false);
    assert.equal(twin.controlFabric.hasEndpoint(endpoint!.host, endpoint!.port), false);
  } finally {
    twin.dispose();
  }
});

test('P0-C: sharer publishing without transport triggers bounded connection recovery', async () => {
  const twin = new PartnerScreenTwin(1001);
  try {
    await twin.initialize();
    await twin.pair();
    twin.network.disconnect('media');
    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();
    await twin.flush();
    await twin.advanceBy(MEDIA_CONNECTION_TIMEOUT_MS + 100);
    const after = twin.bob.mediaSessionController.getSnapshot();
    assert.ok(after.type === 'reconnecting' || after.type === 'error', `expected bounded recovery, got ${after.type}`);
    assert.notEqual(twin.bob.sessionController.getSnapshot().type, 'Unpaired');
  } finally {
    twin.dispose();
  }
});

test('P0-G: an unresolved native getStats call blocks stats calls across session replacement until it really settles', async () => {
  const twin = new PartnerScreenTwin(1002);
  try {
    await twin.initialize();
    await twin.pair();
    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();
    await twin.flushUntil(() => twin.alice.mediaSessionController.getSnapshot().type === 'live');

    let callCount = 0;
    const resolvers: Array<(value: any) => void> = [];
    twin.alice.mediaPort.getStats = async () => {
      callCount += 1;
      return new Promise<any>((resolve) => { resolvers.push(resolve); });
    };

    await twin.advanceBy(2_100);
    assert.equal(callCount, 1);
    await twin.advanceBy(6_000);
    assert.equal(callCount, 1, 'timed-out native call is still the single actual flight');

    const firstSession = twin.alice.sessionController.getSnapshot();
    assert.equal(firstSession.type, 'Connected');
    if (firstSession.type === 'Connected') await twin.alice.sessionController.endSession(firstSession.sessionId);
    await twin.flushUntil(() => twin.alice.sessionController.getSnapshot().type === 'PairedAvailable');

    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();
    await twin.flushUntil(() => twin.alice.mediaSessionController.getSnapshot().type === 'live');
    await twin.advanceBy(2_100);
    assert.equal(callCount, 1, 'replacement session must not start B while native A is unresolved');
    assert.equal(twin.alice.mediaSessionController.getStatsSnapshot(), null);

    resolvers[0]?.(validStats(1111));
    await twin.flush();
    assert.equal(twin.alice.mediaSessionController.getStatsSnapshot(), null, 'late old-session sample must not mutate replacement state');

    await twin.advanceBy(2_100);
    assert.equal(callCount, 2, 'new current session may poll only after old native flight settles');
  } finally {
    twin.dispose();
  }
});

test('P0-G: a same-session stats timeout resumes polling after the slow native call settles', async () => {
  const twin = new PartnerScreenTwin(1003);
  try {
    await twin.initialize();
    await twin.pair();
    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();
    await twin.flushUntil(() => twin.alice.mediaSessionController.getSnapshot().type === 'live');

    let callCount = 0;
    const resolvers: Array<(value: any) => void> = [];
    twin.alice.mediaPort.getStats = async () => {
      callCount += 1;
      return new Promise<any>((resolve) => { resolvers.push(resolve); });
    };

    await twin.advanceBy(3_500);
    assert.equal(callCount, 1);
    resolvers[0]?.(validStats(2222));
    await twin.flush();
    await twin.advanceBy(2_100);
    assert.equal(callCount, 2, 'polling resumes after the real native operation settles');
  } finally {
    twin.dispose();
  }
});
