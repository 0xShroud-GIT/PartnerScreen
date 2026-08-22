import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const at = (...parts) => path.join(root, ...parts);
const exists = (...parts) => fs.existsSync(at(...parts));
const rm = (...parts) => fs.rmSync(at(...parts), { recursive: true, force: true });
const mkdir = (dir) => fs.mkdirSync(dir, { recursive: true });
const move = (from, to) => {
  if (!exists(from)) return;
  const dest = at(to);
  mkdir(path.dirname(dest));
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(at(from), dest);
};

const obsolete = [
  'AGENTS.md', 'CHECKPOINT.md', 'STABILIZATION_REPORT.md', 'V2_ROADMAP.md', 'docs', '.maestro',
  'src/capture', 'src/media', 'src/platform/capture', 'src/platform/media', 'src/platform/keepawake',
  'src/platform/lifecycle', 'src/platform/pip', 'src/runtime',
  'src/presentation/ProductPresentation.ts', 'src/presentation/ViewerOwnership.ts', 'src/presentation/useScreenCapture.ts',
  'src/session/ErrorRecovery.ts', 'plugins/withPip.ts',
  'modules/partner-screen-capture', 'modules/partner-keep-awake', 'modules/partner-lifecycle',
  'modules/partner-runtime-lab', 'modules/partner-pip',
  '.github/workflows/m0p-software-qualification.yml', '.github/workflows/runtime-lab-native.yml',
  '.github/workflows/runtime-lab.yml', '.github/workflows/source-gate.yml', '.github/workflows/build-dev-apk.yml',
  'scripts/runtime-lab-two-emulators.sh', 'scripts/build-dev-apk.sh', 'scripts/repo-sanitize.sh',
];
for (const target of obsolete) rm(target);

if (exists('scripts')) {
  for (const name of fs.readdirSync(at('scripts'))) {
    if (/^verify-/.test(name) || /^runtime-lab/.test(name)) rm('scripts', name);
  }
}
for (const name of fs.readdirSync(root)) {
  if (/^tsconfig\.(m\d+|product-tests|runtime-lab-tests)\.json$/.test(name)) rm(name);
}
if (exists('tests/runtime-lab')) rm('tests/runtime-lab');
if (exists('tests')) {
  for (const name of fs.readdirSync(at('tests'))) {
    if (/^(capture-|screen-capture-|media-session|media-protocol|media-observability|product-presentation|stabilization|p0-|p0q2-|error-recovery|viewer-ownership)/.test(name)) rm('tests', name);
  }
}

for (const [from, to] of [
  ['modules/partner-control', 'modules/chirp-control'],
  ['modules/partner-discovery-auth', 'modules/chirp-discovery-auth'],
  ['modules/partner-discovery', 'modules/chirp-discovery'],
  ['modules/partner-pairing-transport', 'modules/chirp-pairing-transport'],
  ['modules/partner-request-notification', 'modules/chirp-request-notification'],
]) move(from, to);

for (const mod of ['chirp-control', 'chirp-discovery-auth', 'chirp-discovery', 'chirp-pairing-transport', 'chirp-request-notification']) {
  move(`modules/${mod}/android/src/main/java/com/partnerscreen`, `modules/${mod}/android/src/main/java/com/chirp`);
}

const replacements = [
  ['PARTNERSCREEN', 'CHIRP'], ['PartnerScreen', 'Chirp'], ['partnerscreen', 'chirp'],
  ['modules/partner-control', 'modules/chirp-control'],
  ['modules/partner-discovery-auth', 'modules/chirp-discovery-auth'],
  ['modules/partner-discovery', 'modules/chirp-discovery'],
  ['modules/partner-pairing-transport', 'modules/chirp-pairing-transport'],
  ['modules/partner-request-notification', 'modules/chirp-request-notification'],
  ['PartnerTrustedPresence', 'ChirpTrustedPresence'],
  ['PartnerPairingTransport', 'ChirpPairingTransport'],
  ['PartnerRequestNotification', 'ChirpRequestNotification'],
  ['PartnerDiscovery', 'ChirpDiscovery'],
  ['PartnerControl', 'ChirpControl'],
  ['onPartnerControlEvent', 'onChirpControlEvent'],
  ['onPartnerDiscoveryEvent', 'onChirpDiscoveryEvent'],
];
const extensions = new Set(['.ts','.tsx','.js','.mjs','.json','.md','.yml','.yaml','.kt','.java','.gradle','.properties','.xml','.sh','.txt']);
function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git','node_modules','.expo','android','dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full)); else files.push(full);
  }
  return files;
}
for (const file of walk(root)) {
  if (!extensions.has(path.extname(file)) && !['.gitignore'].includes(path.basename(file))) continue;
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let next = source;
  for (const [from, to] of replacements) next = next.split(from).join(to);
  if (next !== source) fs.writeFileSync(file, next, 'utf8');
}

function renameRecursively(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) renameRecursively(path.join(dir, entry.name));
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    let name = entry.name;
    for (const [from, to] of replacements.slice(7)) name = name.split(from).join(to);
    if (name !== entry.name) fs.renameSync(path.join(dir, entry.name), path.join(dir, name));
  }
}
renameRecursively(at('modules'));

console.log('Chirp structural cleanup complete.');
