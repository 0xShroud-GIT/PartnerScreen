import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const fail = (message) => { console.error(`HYGIENE: ${message}`); process.exitCode = 1; };
const exists = (target) => fs.existsSync(path.join(root, target));
const read = (target) => fs.readFileSync(path.join(root, target), 'utf8');

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.kt', '.java', '.gradle', '.properties', '.xml', '.sh', '.txt']);
for (const file of tracked) {
  if (file === 'scripts/check-hygiene.mjs') continue;
  if (!textExtensions.has(path.extname(file)) && path.basename(file) !== '.gitignore') continue;
  let text;
  try { text = read(file); } catch { continue; }
  if (/partnerscreen/i.test(text) || /partnerscreen/i.test(file)) fail(`legacy product branding remains in ${file}`);
  if (/org\.jitsi:webrtc|WebRtcEngine|PartnerRemoteVideoView|ScreenCaptureCoordinator|MediaSessionController|ExpoWebRtcMedia/.test(text + file)) fail(`deleted custom WebRTC architecture remains in ${file}`);
  if (/armeabi-v7a/.test(text) || /['"]x86['"]/.test(text)) fail(`32-bit ABI remains in ${file}`);
  if (/^tsconfig\.m\d+-tests\.json$/.test(file)) fail(`historical milestone test config remains: ${file}`);
}

const forbiddenPaths = [
  'docs', '.maestro', 'CHECKPOINT.md', 'STABILIZATION_REPORT.md', 'V2_ROADMAP.md',
  'modules/partner-screen-capture', 'modules/partner-keep-awake', 'modules/partner-lifecycle',
  'modules/partner-runtime-lab', 'modules/partner-pip', 'src/capture', 'src/platform/capture',
  'src/platform/media', 'src/platform/keepawake', 'src/platform/lifecycle', 'src/platform/pip',
  'src/platform/discovery/ExpoPartnerDiscovery.ts',
];
for (const target of forbiddenPaths) if (exists(target)) fail(`forbidden path exists: ${target}`);

const expectedModules = ['chirp-control', 'chirp-discovery', 'chirp-discovery-auth', 'chirp-pairing-transport', 'chirp-request-notification'];
const modules = fs.readdirSync(path.join(root, 'modules'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (JSON.stringify(modules) !== JSON.stringify([...expectedModules].sort())) fail(`native modules must be exactly: ${expectedModules.join(', ')}`);

const pkg = JSON.parse(read('package.json'));
if (pkg.name !== 'chirp') fail('package name must be chirp');
if (pkg.dependencies?.['react-native-webrtc'] !== '124.0.8') fail('react-native-webrtc must be pinned to 124.0.8');
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

if (process.exitCode) process.exit(process.exitCode);
console.log(`Hygiene OK: ${tracked.length} tracked files checked.`);
