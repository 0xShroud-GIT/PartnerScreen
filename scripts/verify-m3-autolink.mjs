import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const executable = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'expo-modules-autolinking.cmd' : 'expo-modules-autolinking');

let output;
try {
  output = execFileSync(executable, ['resolve', '--platform', 'android', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
  throw new Error(`Expo Android autolinking resolution failed.${stderr ? ` ${stderr.trim()}` : ''}`);
}

let resolved;
try {
  resolved = JSON.parse(output);
} catch {
  throw new Error('Expo Android autolinking --json output was not valid JSON.');
}

const serialized = JSON.stringify(resolved);
for (const marker of [
  'PartnerDiscoveryModule',
  'com.partnerscreen.discovery',
  'PartnerDiscoveryAuthModule',
  'com.partnerscreen.discoveryauth',
]) {
  if (!serialized.includes(marker)) throw new Error(`Expo Android autolinking is missing M3 native marker: ${marker}`);
}

console.log('M3 Expo Android autolinking: PASSED');
