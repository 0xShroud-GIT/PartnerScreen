import { existsSync, readFileSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 22 || minor < 13) {
  throw new Error(`Expo SDK 57 baseline requires Node 22.13.x+ on the 22 line; running ${process.versions.node}`);
}

const projectUrl = new URL('../', import.meta.url);
const readJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, projectUrl), 'utf8'));
const pkg = readJson('package.json');

if (pkg.main !== 'expo-router/entry') {
  throw new Error('Expo Router must remain the application entry point.');
}
if (pkg.packageManager !== 'npm@10.9.8') {
  throw new Error('The verified npm baseline must remain npm 10.9.8 and reproducible.');
}
if (!String(pkg.dependencies?.expo ?? '').startsWith('~57.')) {
  throw new Error('Project must remain on Expo SDK 57 baseline until an approved upgrade.');
}
if (pkg.dependencies?.react !== '19.2.3' || pkg.dependencies?.['react-native'] !== '0.86.2') {
  throw new Error('React / React Native baseline drifted from the verified Expo SDK 57 line.');
}
if (!String(pkg.dependencies?.['expo-router'] ?? '').startsWith('~57.')) {
  throw new Error('Expo Router must remain on the SDK 57-compatible line.');
}
if (!String(pkg.dependencies?.['expo-dev-client'] ?? '').startsWith('~57.')) {
  throw new Error('PartnerScreen requires an Expo development build, not Expo Go.');
}

const lockUrl = new URL('package-lock.json', projectUrl);
if (!existsSync(lockUrl)) {
  throw new Error('A committed npm package-lock.json is required.');
}
const lock = readJson('package-lock.json');
if (lock.lockfileVersion !== 3) {
  throw new Error(`Expected npm lockfileVersion 3, found ${lock.lockfileVersion}`);
}
const lockRoot = lock.packages?.[''];
for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
  if (lockRoot?.dependencies?.[name] !== version) {
    throw new Error(`package-lock.json root dependency ${name} is not synchronized with package.json.`);
  }
}
for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
  if (lockRoot?.devDependencies?.[name] !== version) {
    throw new Error(`package-lock.json root devDependency ${name} is not synchronized with package.json.`);
  }
}
if (pkg.dependencies?.['react-dom'] !== '19.2.3' || !String(pkg.dependencies?.['react-native-web'] ?? '').startsWith('~0.21.')) {
  throw new Error('Expo Router peer dependencies must remain aligned with the SDK 57 template without implying a web product target.');
}

for (const generatedDir of ['android', 'ios']) {
  if (existsSync(new URL(generatedDir, projectUrl))) {
    throw new Error(`Generated ${generatedDir}/ directory must not be canonical under CNG.`);
  }
}

if (pkg.dependencies?.['react-native-webrtc'] || pkg.devDependencies?.['react-native-webrtc']) {
  throw new Error('Dependency react-native-webrtc belongs to M6 and must not enter the current M2 scope.');
}

console.log('ARENA static baseline: PASSED');
