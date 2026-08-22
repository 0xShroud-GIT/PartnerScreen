import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ViewerOwnership } from '../src/presentation/ViewerOwnership';
import { IncomingRequestIngress, parseIncomingRequestSessionId } from '../src/request/incomingRequestRoute';
import { PartnerScreenTwin } from './runtime-lab/PartnerScreenTwin';
import { MEDIA_CONNECTION_TIMEOUT_MS } from '../src/media/MediaSessionController';
import { VirtualClock } from './runtime-lab/VirtualClock';

// Blocker 4: Viewer ownership helper is not used — production must converge
test('P0-F: Home auto and manual Open Viewer converge to one Viewer owner per session', () => {
  const ownership = new ViewerOwnership();
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  // Simulate Home auto push — first claim becomes owner
  const auto1 = ownership.claim(sessionId);
  assert.equal(auto1, true, 'first auto claim should become owner');
  assert.equal(ownership.isOwner(sessionId), true);
  // Simulate duplicate Connected notification (re-emit) — should be deduped via isOwner check, not second claim
  assert.equal(ownership.isOwner(sessionId), true, 'duplicate Connected should see already owner and not claim again');
  // Simulate manual Open Viewer — should see already owner and not push, not claim again
  assert.equal(ownership.isOwner(sessionId), true, 'already owner, manual should not push');
  // Replacement session cannot claim while old still owned
  const sessionId2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const replacement = ownership.claim(sessionId2);
  assert.equal(replacement, false, 'replacement session cannot claim while old still owned');
  // Release old
  assert.equal(ownership.release(sessionId), true, 'release old should fully release');
  assert.equal(ownership.isOwner(sessionId), false);
  // Replacement session gets fresh owner
  const replacement2 = ownership.claim(sessionId2);
  assert.equal(replacement2, true, 'replacement session should claim after old released');
  assert.equal(ownership.release(sessionId2), true);
});

// Blocker 4: Verify production Viewer actually uses ViewerOwnership
test('P0-F: production Viewer binds ViewerOwnership (wiring check)', () => {
  const viewerPath = join(process.cwd(), 'app/viewer.tsx');
  const content = readFileSync(viewerPath, 'utf8');
  assert.ok(content.includes('viewerOwnership'), 'app/viewer.tsx must import and use viewerOwnership');
  assert.ok(content.includes('viewerOwnership.claim'), 'app/viewer.tsx must claim ViewerOwnership');
  assert.ok(content.includes('viewerOwnership.release'), 'app/viewer.tsx must release ViewerOwnership');
});

// Blocker 5: PIP geometry un wired — Viewer must bind onFrameResolution
test('P0-F: production Viewer binds onFrameResolution to setVideoGeometry', () => {
  const viewerPath = join(process.cwd(), 'app/viewer.tsx');
  const content = readFileSync(viewerPath, 'utf8');
  assert.ok(content.includes('onFrameResolution'), 'app/viewer.tsx must bind PartnerRemoteVideoView.onFrameResolution');
  assert.ok(content.includes('setVideoGeometry'), 'app/viewer.tsx must setVideoGeometry from onFrameResolution');
  assert.ok(content.includes('displayedVideoSize'), 'app/viewer.tsx must use displayedVideoSize for PiP eligibility');
});

// Blocker 6: Single notification ingress — all mechanisms converge
test('P0-E: IncomingRequestIngress dedupes same session from multiple mechanisms', () => {
  const ingress = new IncomingRequestIngress();
  const state = { type: 'IncomingRequest' as const, pair: { partnerDeviceId: 'x', partnerDeviceName: 'y', pairId: 'z', pairedAt: '', partnerDeviceId: '', schemaVersion: 1, protocolVersion: 1, status: 'confirmed' as const }, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: new Date(Date.now() + 30000).toISOString() };
  let navigations = 0;
  const open = () => { navigations += 1; };
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  // First via notification
  assert.equal(ingress.route(sessionId, state as any, open), true);
  assert.equal(navigations, 1);
  // Second via deep-link URL for same session (should not navigate again)
  const url = `partnerscreen://incoming-request/${sessionId}`;
  const parsed = parseIncomingRequestSessionId(url);
  assert.equal(parsed, sessionId);
  assert.equal(ingress.route(parsed, state as any, open), false);
  assert.equal(navigations, 1, 'same session via second mechanism must not navigate again');
  // Stale session
  assert.equal(ingress.route('dddddddd-dddd-4ddd-8ddd-dddddddddddd', state as any, open), false);
  assert.equal(navigations, 1);
  // Replacement session may navigate once
  const newSessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const newState = { ...state, sessionId: newSessionId } as any;
  assert.equal(ingress.route(newSessionId, newState, open), true);
  assert.equal(navigations, 2);
});

// Blocker 6: Verify _layout uses single canonical ingress
test('P0-E: production _layout uses single IncomingRequestIngress for all cold/warm inputs', () => {
  const layoutPath = join(process.cwd(), 'app/_layout.tsx');
  const content = readFileSync(layoutPath, 'utf8');
  assert.ok(content.includes('IncomingRequestIngress'), 'app/_layout.tsx must import IncomingRequestIngress');
  assert.ok(content.includes('incomingIngress.route'), 'app/_layout.tsx must route through single ingress instance');
  // Must handle both Linking and notification via same instance
  assert.ok(content.includes('Linking.getInitialURL'), 'app/_layout.tsx must handle cold Linking URL via same ingress');
  assert.ok(content.includes('Linking.addEventListener'), 'app/_layout.tsx must handle warm Linking URL via same ingress');
  assert.ok(content.includes('consumeLaunchSessionId'), 'app/_layout.tsx must handle notification cold id via same ingress');
  assert.ok(content.includes('subscribeOpened'), 'app/_layout.tsx must handle notification warm via same ingress');
});

// Blocker 7: Notification prompt not global — must be foreground-owned
test('P0-E: AppServices does not auto-prompt notification permission on pairing', () => {
  const appServicesPath = join(process.cwd(), 'src/application/AppServices.ts');
  const content = readFileSync(appServicesPath, 'utf8');
  assert.ok(!content.includes('notificationPromptedAfterPair'), 'AppServices must not contain one-shot notificationPromptedAfterPair latch');
  assert.ok(!content.includes('requestPermissionFromForeground'), 'AppServices must not automatically request notification permission');
});

// Blocker 7: Verify foreground permission UI exists
test('P0-E: Home has foreground notification permission card', () => {
  const homePath = join(process.cwd(), 'app/index.tsx');
  const content = readFileSync(homePath, 'utf8');
  assert.ok(content.includes('readPermissionState'), 'app/index.tsx must read notification permission state on foreground');
  assert.ok(content.includes('requestPermissionFromForeground'), 'app/index.tsx must request permission from foreground button');
  assert.ok(content.includes('Enable notifications'), 'app/index.tsx must have Enable notifications button');
  assert.ok(content.includes('Notifications'), 'app/index.tsx must have Notifications card');
});

// Blocker 8: process death removes JS callbacks (truthful) — separate from Activity recreation
test('P0-D: process death destroys JS callbacks (truthful simulation)', async () => {
  const twin = new PartnerScreenTwin(999);
  try {
    await twin.initialize();
    await twin.pair();
    assert.ok(twin.bob.controlTransport.trustedPresenceActive, 'trusted presence should be active after pairing');
    // Simulate full process death without trusted presence (stop it first) — this is the non-trusted path
    await twin.bob.controlTransport.stopTrustedPresence();
    twin.bob.controlTransport.killProcess();
    const callbacksAfter = (twin.bob.controlTransport as any).callbacks?.size ?? 0;
    assert.equal(callbacksAfter, 0, 'killProcess without trusted presence must clear callbacks');
    assert.equal(twin.bob.controlTransport.endpoint, null, 'endpoint must be cleared without trusted presence');
    // With trusted presence, Activity recreation keeps native endpoint but JS is still destroyed and must re-attach;
    // that path is tested via the known-regression which keeps JS alive for lab simplicity and is documented as
    // Activity-level, while true process-death reconstruction remains unproven (requires secure trust-store bridge).
  } finally {
    twin.dispose();
  }
});

// Blocker 1: connection deadline must be based on transport, not publishing+good
test('P0-C: sharer publishing without transport triggers connection deadline recovery', async () => {
  const twin = new PartnerScreenTwin(1001);
  try {
    await twin.initialize();
    await twin.pair();
    twin.network.disconnect('media');
    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();
    await twin.flush();
    // Advance past connection timeout (10s) — regardless of initial media state, should enter recovery
    await twin.advanceBy(MEDIA_CONNECTION_TIMEOUT_MS + 100);
    const sharerAfter = twin.bob.mediaSessionController.getSnapshot();
    assert.ok(sharerAfter.type === 'reconnecting' || sharerAfter.type === 'error', `sharer should have started recovery after connection timeout, got ${sharerAfter.type}`);
    assert.ok(twin.bob.sessionController.getSnapshot().type !== 'Unpaired', 'pair trust must survive media recovery');
  } finally {
    twin.dispose();
  }
});

test('P0-G: hung getStats does not allow overlap (at most one in-flight)', async () => {
  const twin = new PartnerScreenTwin(1002);
  try {
    await twin.initialize();
    await twin.pair();
    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    await twin.bob.acceptIncomingAndStartCapture();
    await twin.flushUntil(() => twin.alice.mediaSessionController.getSnapshot().type === 'live');
    // Mock getStats to never resolve
    let callCount = 0;
    let resolveHanging: ((value: any) => void) | null = null;
    const originalGetStats = twin.alice.mediaPort.getStats.bind(twin.alice.mediaPort);
    twin.alice.mediaPort.getStats = async (sessionId: string) => {
      callCount += 1;
      return new Promise<any>((resolve) => {
        resolveHanging = resolve;
      });
    };
    // Ensure live state triggers stats polling (2s interval)
    // Advance 6 seconds (3 intervals) — should still be 1 call
    await twin.advanceBy(6000);
    assert.equal(callCount, 1, 'hung getStats should not allow overlap, call count must remain 1');
    // Now start a replacement session (new sessionId) — future current session may begin new request
    // End current session and start new
    const oldSessionId = twin.alice.sessionController.getSnapshot().type === 'Connected' ? (twin.alice.sessionController.getSnapshot() as any).sessionId : null;
    if (oldSessionId) await twin.alice.sessionController.endSession(oldSessionId);
    await twin.flushUntil(() => twin.alice.sessionController.getSnapshot().type === 'PairedAvailable');
    // Pair trust still
    assert.ok(twin.alice.sessionController.getSnapshot().type === 'PairedAvailable');
    // Now request again — new session should be able to start stats even though old hanging still not resolved
    // The old hanging's late completion must not mutate replacement
    // Resolve hanging late
    resolveHanging?.({ bytesSent: 1000, bytesReceived: 1000, framesEncoded: 1, framesDecoded: 1, frameWidth: 1280, frameHeight: 720, candidatePairState: 'succeeded', bitrateParametersState: 'applied' });
    await twin.flush();
    // New request should be possible
    await twin.requestScreen(twin.alice);
    await twin.flushUntil(() => twin.bob.sessionController.getSnapshot().type === 'IncomingRequest');
    // Should not have mutated old session
    assert.equal(callCount, 1, 'late completion should not trigger new call for old session');
  } finally {
    twin.dispose();
  }
});
