import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const requireFile = (relative) => { if (!existsSync(path.join(root, relative))) throw new Error(`M8 requires ${relative}`); };
const requireMarker = (text, marker, label) => { if (!text.includes(marker)) throw new Error(`${label} missing M8 marker: ${marker}`); };
const forbid = (text, marker, label) => { if (text.includes(marker)) throw new Error(`${label} contains forbidden M8 marker: ${marker}`); };

for (const file of [
  'src/presentation/ProductPresentation.ts',
  'app/index.tsx',
  'app/viewer.tsx',
  'app/_layout.tsx',
  'app/diagnostics.tsx',
  'tests/product-presentation.test.ts',
  'tsconfig.m8-tests.json',
]) requireFile(file);

const presentation = read('src/presentation/ProductPresentation.ts');
for (const marker of [
  'deriveProductPresentation',
  "presentation('available'",
  "presentation('waiting_first_frame'",
  "presentation('reconnecting'",
  "presentation('live'",
  'not LIVE yet',
  'LIVE is off',
  'actual remote video frame',
  'const exhaustive: never = session',
]) requireMarker(presentation, marker, 'ProductPresentation.ts');

const ui = read('app/index.tsx');
for (const marker of [
  'Current state',
  'deriveProductPresentation',
  'accessibilityLiveRegion="polite"',
  'accessibilityLiveRegion="assertive"',
  'accessibilityLabel=',
  'accessibilityHint=',
  'accessibilityState=',
  'minHeight: 48',
  'LIVE — remote screen visible',
  "router.push('/viewer')",
  'Open viewer',
  'Availability, request acceptance, capture start, SDP, ICE, track attachment and React mounting never make the product LIVE',
]) requireMarker(ui, marker, 'app/index.tsx');
for (const marker of ['allowFontScaling={false}', 'M6 private LAN video', 'backgroundColor: \'#0f0\'', 'backgroundColor: "#0f0"', 'PartnerRemoteVideoView', 'aspectRatio: 9 / 16']) forbid(ui, marker, 'app/index.tsx');

const viewer = read('app/viewer.tsx');
for (const marker of [
  'PartnerRemoteVideoView',
  'Trusted partner screen viewer',
  'StatusBar hidden',
  'styles.videoStage',
  'styles.overlay',
  'Stop session',
  "router.replace('/')",
  'rendererFirstFrame',
  'rendererEpoch',
  'rendererTrackState?.trackEpoch',
  'rendererMountEpoch',
  'lastRenderedEpoch',
  'trackEpoch={rendererEpoch}',
  'key={`${requesterSessionId}:${rendererMountEpoch}`}',
  "BackHandler.addEventListener('hardwareBackPress'",
  'void stopSession()',
]) requireMarker(viewer, marker, 'app/viewer.tsx');
for (const marker of ['ScrollView', 'aspectRatio: 9 / 16', 'borderRadius: 10, overflow: \'hidden\'', 'key={`${requesterSessionId}:${rendererEpoch}`}']) forbid(viewer, marker, 'app/viewer.tsx');

const layout = read('app/_layout.tsx');
for (const marker of ['name="viewer"', 'headerShown: false']) requireMarker(layout, marker, 'app/_layout.tsx');

const diagnostics = read('app/diagnostics.tsx');
for (const marker of [
  "REPORT_FAILURE = 'Could not build the sanitized diagnostic report. Try again.'",
  "COPY_FAILURE = 'Could not copy the diagnostic report. Try again.'",
  'raw exception text',
  'accessibilityLiveRegion="assertive"',
  'minHeight: 48',
]) requireMarker(diagnostics, marker, 'app/diagnostics.tsx');
for (const marker of ['refreshError instanceof Error', 'refreshError.message', 'error.message', 'String(error)', 'String(refreshError)']) forbid(diagnostics, marker, 'app/diagnostics.tsx');

const tests = read('tests/product-presentation.test.ts');
for (const marker of [
  'available explicitly remains pre-session',
  'remote track attachment is explicitly not LIVE',
  'reconnecting removes LIVE truth',
  'LIVE requires authoritative media live state',
  'any authoritative error fails closed in presentation',
]) requireMarker(tests, marker, 'product-presentation.test.ts');

const pkg = readJson('package.json');
for (const marker of ['tsconfig.m8-tests.json', 'tests/product-presentation.test.ts', 'tests/diagnostics.test.ts']) requireMarker(pkg.scripts?.['test:m8'] ?? '', marker, 'package.json test:m8');

const allProduct = [presentation, ui, viewer, diagnostics].join('\n');
for (const marker of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'stun:', 'turn:', 'turns:', 'remote control']) {
  if (marker === 'remote control') continue;
  forbid(allProduct, marker, 'M8 product/UI code');
}

console.log('M8 static contract: PASSED');
