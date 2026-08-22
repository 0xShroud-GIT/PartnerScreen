import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const fail = (message) => { console.error(`HYGIENE: ${message}`); process.exitCode = 1; };
const exists = (target) => fs.existsSync(path.join(root, target));
const read = (target) => fs.readFileSync(path.join(root, target), 'utf8');

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.kt', '.java', '.gradle', '.properties', '.xml', '.sh', '.txt']);
const legacyMediaPattern = /org\.jitsi:webrtc|WebRtcEngine|PartnerRemoteVideoView|ScreenCaptureCoordinator|MediaSessionController|ExpoWebRtcMedia|SurfaceViewRenderer|ScreenCapturerAndroid|PeerConnectionFactory|\.addSink\(|\.removeSink\(/;
for (const file of tracked) {
  if (file === 'scripts/check-hygiene.mjs') continue;
  if (!textExtensions.has(path.extname(file)) && path.basename(file) !== '.gitignore') continue;
  let text;
  try { text = read(file); } catch { continue; }
  if (/partnerscreen/i.test(text) || /partnerscreen/i.test(file)) fail(`legacy product branding remains in ${file}`);
  if (legacyMediaPattern.test(text + file)) fail(`deleted custom WebRTC architecture remains in ${file}`);
  if (/armeabi-v7a/.test(text) || /['"]x86['"]/.test(text)) fail(`32-bit ABI remains in ${file}`);
  if (/^tsconfig\.m\d+-tests\.json$/.test(file)) fail(`historical milestone test config remains: ${file}`);
  if (/^scripts\/verify-m\d+\.mjs$/.test(file)) fail(`historical milestone verifier remains: ${file}`);
}

const forbiddenPaths = [
  'docs', '.maestro', 'CHECKPOINT.md', 'STABILIZATION_REPORT.md', 'V2_ROADMAP.md',
  'modules/partner-screen-capture', 'modules/partner-keep-awake', 'modules/partner-lifecycle',
  'modules/partner-runtime-lab', 'modules/partner-pip', 'src/capture', 'src/platform/capture',
  'src/platform/media', 'src/platform/keepawake', 'src/platform/lifecycle', 'src/platform/pip',
  'src/platform/discovery/ExpoPartnerDiscovery.ts', 'tests/runtime-lab',
];
for (const target of forbiddenPaths) if (exists(target)) fail(`forbidden path exists: ${target}`);

const expectedModules = ['chirp-control', 'chirp-discovery', 'chirp-discovery-auth', 'chirp-pairing-transport', 'chirp-request-notification'];
const modules = fs.readdirSync(path.join(root, 'modules'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (JSON.stringify(modules) !== JSON.stringify([...expectedModules].sort())) fail(`native modules must be exactly: ${expectedModules.join(', ')}`);

const pkg = JSON.parse(read('package.json'));
if (pkg.name !== 'chirp') fail('package name must be chirp');
if (pkg.packageManager !== 'npm@10.9.8') fail('packageManager must pin npm@10.9.8');
if (pkg.dependencies?.['react-native-webrtc'] !== '124.0.8') fail('react-native-webrtc must be pinned to 124.0.8');
if (pkg.dependencies?.['expo-keep-awake'] !== '~57.0.1') fail('expo-keep-awake must remain the maintained keep-awake implementation');
if ('react-dom' in (pkg.dependencies ?? {}) || 'react-native-web' in (pkg.dependencies ?? {}) || 'expo-dev-client' in (pkg.dependencies ?? {})) fail('web/dev-client dependencies are not allowed');

const lock = JSON.parse(read('package-lock.json'));
const lockRoot = lock.packages?.[''];
if (lock.name !== pkg.name || lock.version !== pkg.version || lockRoot?.name !== pkg.name || lockRoot?.version !== pkg.version) fail('package-lock root metadata must match package.json');
for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
  if (lockRoot?.dependencies?.[name] !== version) fail(`package-lock is missing direct dependency ${name}@${version}`);
}
for (const name of Object.keys(lockRoot?.dependencies ?? {})) {
  if (!(name in (pkg.dependencies ?? {}))) fail(`package-lock has stale direct dependency ${name}`);
}

const config = read('app.config.ts');
for (const required of ["name: 'Chirp'", "package: 'com.chirp.app'", "'arm64-v8a'", "'x86_64'", "'@config-plugins/react-native-webrtc'"]) {
  if (!config.includes(required)) fail(`app.config.ts missing ${required}`);
}
for (const blocked of ["'android.permission.RECORD_AUDIO'", "'android.permission.SYSTEM_ALERT_WINDOW'"]) {
  if (!config.includes(blocked)) fail(`app.config.ts must block ${blocked}`);
}

const mediaPolicy = read('src/media/MediaPolicy.ts');
for (const invariant of [
  'SCREEN_LONG_EDGE_PX = 1600',
  'SCREEN_FPS = 30',
  'SCREEN_MIN_BITRATE_BPS = 1_000_000',
  'SCREEN_MAX_BITRATE_BPS = 8_000_000',
  'MEDIA_DISCONNECTED_GRACE_MS = 3_000',
  'MEDIA_KEYFRAME_REQUEST_DELAYS_MS',
  'MEDIA_KEYFRAME_STEADY_RETRY_MS = 5_000',
  'MEDIA_SIGNAL_RETRY_MS = 1_000',
]) {
  if (!mediaPolicy.includes(invariant)) fail(`media policy invariant missing: ${invariant}`);
}

const mediaSession = read('src/media/MediaSession.ts');
for (const invariant of [
  "sendMedia(sessionId, 'MEDIA_KEYFRAME_REQUEST'",
  'MEDIA_KEYFRAME_STEADY_RETRY_MS',
  'createOffer(iceRestart ? { iceRestart: true } : undefined)',
  "parameters.degradationPreference = 'maintain-resolution'",
  'await this.forceKeyframe(sessionId);',
  "(track as unknown as EndedAwareTrack).onended = null",
  "this.peer?.connectionState === 'connected'",
  'getStatsSnapshot',
]) {
  if (!mediaSession.includes(invariant)) fail(`media recovery/observability invariant missing: ${invariant}`);
}
if (mediaSession.includes('if (this.keyframeAttempt >= MEDIA_KEYFRAME_REQUEST_DELAYS_MS.length)')) {
  fail('first-frame keyframe exhaustion must not escalate into ICE recovery');
}

const home = read('app/index.tsx');
const layout = read('app/_layout.tsx');
const viewer = read('app/viewer.tsx');
for (const invariant of ['TextInput', 'saveDeviceName', 'useNotificationPermission', "useKeepAwake('chirp-sharer')"]) {
  if (!home.includes(invariant)) fail(`home release UX invariant missing: ${invariant}`);
}
if (/\bUnknown\b/.test(home)) fail('home must not silently render an unnamed fresh install as Unknown');
if (!layout.includes('<Stack.Screen name="index" options={{ headerShown: false }}')) fail('home must not render a duplicate Stack header');
if (!viewer.includes("useKeepAwake('chirp-viewer')")) fail('active viewer must hold bounded Expo keep-awake ownership');

const plugin = read('plugins/withChirpWebRtc.js');
for (const invariant of ['withDangerousMod', 'android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW', 'enableMediaProjectionService = true']) {
  if (!plugin.includes(invariant)) fail(`Android WebRTC/privacy plugin missing invariant: ${invariant}`);
}

const ciWorkflow = read('.github/workflows/ci.yml');
const apkWorkflow = read('.github/workflows/build-apk.yml');
for (const [name, workflow] of [['CI', ciWorkflow], ['APK', apkWorkflow]]) {
  if (!workflow.includes('npm install --global npm@10.9.8')) fail(`${name} workflow must pin npm@10.9.8`);
  if (!workflow.includes('npm ci --no-audit --no-fund')) fail(`${name} workflow must use npm ci`);
  if (/run:\s+npm install --no-audit --no-fund/.test(workflow)) fail(`${name} workflow must not repair the dependency graph with npm install`);
}
for (const invariant of [
  'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
  'CHIRP_BUILD_COMMIT: ${{ github.event.pull_request.head.sha || github.sha }}',
  'name: chirp-qualification-apk',
]) {
  if (!apkWorkflow.includes(invariant)) fail(`APK workflow source/artifact invariant missing: ${invariant}`);
}

const buildApk = read('scripts/build-apk.sh');
for (const invariant of [
  ':app:assembleRelease',
  'app/build/outputs/apk/release/app-release.apk',
  'chirp-qualification-arm64-v8a-x86_64.apk',
  'assets/index.android.bundle',
  'assets/app.config',
  'CHIRP_BUILD_COMMIT',
  'libjingle_peerconnection_so.so',
  'SYSTEM_ALERT_WINDOW',
  'RECORD_AUDIO',
  'BUILD_INFO.txt',
]) {
  if (!buildApk.includes(invariant)) fail(`standalone APK verification invariant missing: ${invariant}`);
}
if (buildApk.includes(':app:assembleDebug')) fail('qualification APK must never use the Metro-dependent debug build type');

if (process.exitCode) process.exit(process.exitCode);
console.log(`Hygiene OK: ${tracked.length} tracked files checked.`);
