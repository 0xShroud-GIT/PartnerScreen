import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const pkg = JSON.parse(read('package.json'));

const requiredDependencies = {
  '@react-native-async-storage/async-storage': '2.2.0',
  'expo-crypto': '~57.',
  'expo-clipboard': '~57.',
  'expo-secure-store': '~57.',
};
for (const [name, expected] of Object.entries(requiredDependencies)) {
  const actual = String(pkg.dependencies?.[name] ?? '');
  if (expected.endsWith('.') ? !actual.startsWith(expected) : actual !== expected) {
    throw new Error(`M1 dependency ${name} is missing or incompatible: ${actual || 'missing'}`);
  }
}

if (pkg.dependencies?.['react-native-webrtc'] || pkg.devDependencies?.['react-native-webrtc']) {
  throw new Error('react-native-webrtc belongs to M6 and must not enter the current M2 scope.');
}

for (const path of [
  'src/domain/security/SecretStore.ts',
  'src/domain/identity/IdentityRepository.ts',
  'src/domain/diagnostics/DiagnosticsRepository.ts',
  'src/platform/persistence/AsyncStorageKeyValueStore.ts',
  'src/platform/persistence/ExpoSecureSecretStore.ts',
  'app/diagnostics.tsx',
]) {
  if (!existsSync(new URL(path, root))) throw new Error(`Missing M1 source: ${path}`);
}

const domainSources = [
  'src/domain/identity/IdentityRepository.ts',
  'src/domain/diagnostics/DiagnosticsRepository.ts',
  'src/domain/security/SecretStore.ts',
].map(read).join('\n');
if (domainSources.includes('@react-native-async-storage/async-storage')) {
  throw new Error('Domain code must not import AsyncStorage directly.');
}
if (read('src/domain/security/SecretStore.ts').includes('AsyncStorage')) {
  throw new Error('Secret storage boundary must never be backed by AsyncStorage.');
}
const secureAdapter = read('src/platform/persistence/ExpoSecureSecretStore.ts');
if (!secureAdapter.includes("from 'expo-secure-store'") || secureAdapter.includes('AsyncStorage')) {
  throw new Error('M1 secure secret boundary must be backed by Expo SecureStore, never AsyncStorage.');
}

for (const generatedDir of ['android', 'ios']) {
  if (existsSync(new URL(generatedDir, root))) {
    throw new Error(`Generated ${generatedDir}/ must remain non-canonical under CNG.`);
  }
}

const config = read('app.config.ts');
if (!config.includes("platforms: ['android']")) {
  throw new Error('M1 must remain Android-only.');
}
if (!config.includes('buildCommit')) {
  throw new Error('M1 diagnostics must expose non-secret build commit metadata.');
}

console.log('M1 static contract: PASSED');
