import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const requireFile = (relative) => { if (!existsSync(path.join(root, relative))) throw new Error(`M7 requires ${relative}`); };
const requireMarker = (text, marker, label) => { if (!text.includes(marker)) throw new Error(`${label} missing M7 marker: ${marker}`); };
const forbid = (text, marker, label) => { if (text.includes(marker)) throw new Error(`${label} contains forbidden M7 marker: ${marker}`); };

for (const file of [
  'src/media/MediaSessionController.ts',
  'src/capture/ScreenCaptureCoordinator.ts',
  'src/session/SessionController.ts',
  'src/protocol/ControlMessage.ts',
  'src/platform/media/ExpoWebRtcMedia.ts',
  'src/platform/control/ControlTransport.ts',
  'modules/partner-control/android/src/main/java/com/partnerscreen/control/PartnerControlModule.kt',
  'modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/WebRtcEngine.java',
  'modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/PartnerScreenCaptureService.kt',
  'tests/media-session.test.ts',
  'tests/screen-capture-coordinator.test.ts',
  'tsconfig.m7-tests.json',
]) requireFile(file);

const media = read('src/media/MediaSessionController.ts');
for (const marker of [
  'MEDIA_RECONNECT_MAX_ATTEMPTS = 3',
  'MEDIA_RECONNECT_DELAYS_MS',
  "quality: 'reconnecting'",
  "event.state === 'disconnected'",
  "event.state === 'failed'",
  'MEDIA_RESTART_REQUEST',
  'scheduleFrameGrace',
  "state.type !== 'reconnecting' && state.type !== 'remote_track_attached'",
  'media_degraded',
  'media_reconnect_attempt',
  'media_reconnected',
  "type: 'remote_track_attached'",
  "type: 'live'",
  'rendererFirstFrame(sessionId',
  'remoteTrackEpoch',
  'trackEpoch: number',
]) requireMarker(media, marker, 'MediaSessionController.ts');
for (const marker of ['while (true)', 'setInterval(', 'stun:', 'turn:', 'turns:', 'GlobalScope']) forbid(media, marker, 'MediaSessionController.ts');

const engine = read('modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/WebRtcEngine.java');
for (const marker of [
  'private long peerGeneration',
  'peerGeneration += 1',
  'new PeerObserver(sessionId, generation)',
  'isCurrentPeerLocked(sessionId, generation)',
  'private final long generation',
  'removeRendererFromCurrentTrackLocked(false)',
  'attachDesiredRendererLocked(sessionId)',
  'rendererSink = sink',
  'rendererSessionId = sessionId',
  'closingPeer = peerConnection',
  'peerConnection = null',
  'CaptureResources resources',
  'takeCaptureLocked()',
  'disposeCaptureResources(resources)',
  'changeScreenCaptureFormat',
  'SCREEN_SHARE_MIN_BITRATE_BPS = 1_000_000',
  'SCREEN_SHARE_MAX_BITRATE_BPS = 8_000_000',
  'RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION',
  'encoding.minBitrateBps = SCREEN_SHARE_MIN_BITRATE_BPS',
  'encoding.maxBitrateBps = SCREEN_SHARE_MAX_BITRATE_BPS',
  'encoding.scaleResolutionDownBy = 1.0',
  'configureScreenShareSender(localVideoSender)',
]) requireMarker(engine, marker, 'WebRtcEngine.java');
for (const marker of ['detachRendererLocked();', 'synchronized (lock) { disposeCaptureLocked(); }']) forbid(engine, marker, 'WebRtcEngine.java');

const nativeMedia = read('src/platform/media/ExpoWebRtcMedia.ts');
for (const marker of [
  'NATIVE_MEDIA_OPERATION_TIMEOUT_MS = 10_000',
  'NATIVE_MEDIA_CLOSE_TIMEOUT_MS = 3_000',
  'Promise.race',
  'Media offer creation timed out.',
  'Media close timed out.',
]) requireMarker(nativeMedia, marker, 'ExpoWebRtcMedia.ts');

const nativeControl = read('src/platform/control/ControlTransport.ts');
for (const marker of [
  'NATIVE_CONTROL_CONNECT_TIMEOUT_MS = 10_000',
  'NATIVE_CONTROL_IO_TIMEOUT_MS = 5_000',
  'NATIVE_CONTROL_CLEANUP_TIMEOUT_MS = 3_000',
  'Promise.race',
  'Control connection timed out.',
  'Control send timed out.',
  'Control close timed out.',
]) requireMarker(nativeControl, marker, 'ControlTransport.ts');

const nativeControlModule = read('modules/partner-control/android/src/main/java/com/partnerscreen/control/PartnerControlModule.kt');
for (const marker of [
  'SEND_TIMEOUT_MS = 4_000',
  'executor.submit',
  'write.get(SEND_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)',
  'catch (error: TimeoutException)',
  'closeConnection(connectionId, emit = true)',
  'bytes.fill(0)',
]) requireMarker(nativeControlModule, marker, 'PartnerControlModule.kt');

const capture = read('src/capture/ScreenCaptureCoordinator.ts');
for (const marker of [
  "event.type === 'stopped'",
  'await this.session.endSession(',
  "event.type === 'revoked'",
  "captureFailed(event.sessionId, 'capture_revoked')",
  'await this.port.stop().catch(() => undefined)',
]) requireMarker(capture, marker, 'ScreenCaptureCoordinator.ts');

const service = read('modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/PartnerScreenCaptureService.kt');
for (const marker of [
  'ACTION_STOP -> stopInternal("notification"',
  'stopForeground(STOP_FOREGROUND_REMOVE)',
  'stopSelf()',
  'if (stopping) return',
  'addAction(Notification.Action.Builder',
  '"Stop sharing"',
  'Executors.newSingleThreadExecutor',
  'PartnerScreenCaptureEngine',
  'engineExecutor.execute',
  'override fun onConfigurationChanged',
  'CAPTURE_LONG_EDGE_PX = 1600.0',
  'CAPTURE_FPS = 30',
  'changeScreenCaptureFormat(width, height, CAPTURE_FPS)',
  'evenAtLeastTwo(rawWidth * scale)',
  'evenAtLeastTwo(rawHeight * scale)',
]) requireMarker(service, marker, 'PartnerScreenCaptureService.kt');

const protocol = read('src/protocol/ControlMessage.ts');
for (const marker of ['MEDIA_RESTART_REQUEST', "reason: 'connection_lost'"]) requireMarker(protocol, marker, 'ControlMessage.ts');

const mediaTests = read('tests/media-session.test.ts');
for (const marker of [
  'disconnect removes LIVE immediately',
  're-earns LIVE only after a new remote track and new renderer frame',
  'recovered remote track without rendered frame advances bounded recovery',
  'sharer is the only restart offer authority',
  'recovery is capped and fails closed',
  'session teardown cancels recovery',
]) requireMarker(mediaTests, marker, 'media-session.test.ts');

const captureTests = read('tests/screen-capture-coordinator.test.ts');
for (const marker of ['notification Stop ends the connected sharer session', 'system projection revocation becomes a typed session failure', 'tears down native capture']) requireMarker(captureTests, marker, 'screen-capture-coordinator.test.ts');

const pkg = readJson('package.json');
for (const marker of ['tsconfig.m7-tests.json', 'tests/media-session.test.ts', 'tests/screen-capture-coordinator.test.ts']) requireMarker(pkg.scripts?.['test:m7'] ?? '', marker, 'package.json test:m7');

console.log('M7 static contract: PASSED');
