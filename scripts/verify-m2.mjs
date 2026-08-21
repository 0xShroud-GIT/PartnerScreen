import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const pkg = JSON.parse(read('package.json'));

const required = {
  'expo-camera': '~57.0.3',
  'react-native-qrcode-svg': '6.3.21',
  'react-native-svg': '15.15.4',
  'expo-secure-store': '~57.0.1',
  'expo-crypto': '~57.0.1',
};
for (const [name, expected] of Object.entries(required)) {
  if (pkg.dependencies?.[name] !== expected) throw new Error(`M2 dependency ${name} must be ${expected}.`);
}
if (!pkg.scripts?.['test:m2']) throw new Error('M2 product test subset script is required.');

const config = read('app.config.ts');
if (!config.includes("'expo-camera'")) throw new Error('M2 must configure expo-camera through CNG.');
if (!config.includes('recordAudioAndroid: false')) throw new Error('M2 camera must not request Android audio recording permission.');
if (!config.includes('barcodeScannerEnabled: true')) throw new Error('M2 camera QR scanning must remain enabled.');
if (!config.includes("platforms: ['android']")) throw new Error('PartnerScreen V1 must remain Android-only.');
if (!config.includes("'android.permission.INTERNET'")) throw new Error('M2 direct LAN sockets require INTERNET through CNG.');
if (!config.includes("'android.permission.ACCESS_NETWORK_STATE'")) throw new Error('M2 Wi-Fi routing requires ACCESS_NETWORK_STATE through CNG.');
if (!config.includes('PARTNERSCREEN_BUILD_COMMIT')) throw new Error('Build diagnostics must prefer the exact verified source commit.');
const requestedPermissions = config.match(/\n\s*permissions\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
if (requestedPermissions.includes('ACCESS_LOCAL_NETWORK') || requestedPermissions.includes('NEARBY_WIFI_DEVICES')) {
  throw new Error('SDK 36 M2 must not request future/opt-in local-network runtime permissions by default.');
}

const kotlinPath = 'modules/partner-pairing-transport/android/src/main/java/com/partnerscreen/pairingtransport/PartnerPairingTransportModule.kt';
if (!exists(kotlinPath)) throw new Error('Canonical Android pairing transport source is missing.');
const kotlin = read(kotlinPath);
for (const marker of [
  'ServerSocket',
  'MAX_FRAME_BYTES = 64 * 1024',
  'READ_TIMEOUT_MS = 130_000',
  'socket.soTimeout = READ_TIMEOUT_MS',
  'Executors.newFixedThreadPool',
  'acceptOne',
  'ConnectivityManager',
  'NetworkCapabilities.TRANSPORT_WIFI',
  'NetworkCapabilities.NET_CAPABILITY_NOT_VPN',
  'NetworkCapabilities.TRANSPORT_VPN',
  'connectivity.getLinkProperties(network)',
  'route.matches(destination)',
  'wifi.network.bindSocket(socket)',
  'socket.bind(InetSocketAddress(wifi.address, 0))',
]) {
  if (!kotlin.includes(marker)) throw new Error(`Pairing transport missing required marker: ${marker}`);
}
if (/NetworkInterface|getNetworkInterfaces|startsWith\("wlan"\)|newCachedThreadPool/.test(kotlin)) {
  throw new Error('M2 transport must use bounded Android Network routing, not interface guessing or unbounded workers.');
}
if (/\bLog\.|println\(|print\(/.test(kotlin)) throw new Error('Native pairing transport must not log frames or secrets.');

const nativeBuild = read('modules/partner-pairing-transport/android/build.gradle');
if (/abortOnError\s+false|abortOnError\s*=\s*false/.test(nativeBuild)) {
  throw new Error('Canonical M2 native module must not suppress Android lint failures.');
}

const gitignore = read('.gitignore');
if (!gitignore.includes('/android/') || !gitignore.includes('/ios/')) throw new Error('Generated native ignores must be scoped to repository root.');
if (/^android\/$/m.test(gitignore) || /^ios\/$/m.test(gitignore)) throw new Error('Unscoped native ignores would hide local Expo Module source.');
if (exists('android') || exists('ios')) throw new Error('Generated root native projects must not be canonical under CNG.');
if (exists('modules/partner-pairing-transport/src/PartnerPairingTransportModule.web.ts')) throw new Error('M2 pairing transport is Android-only; generated web stub must be removed.');

const trust = read('src/domain/pairing/PairTrustRepository.ts');
for (const marker of [
  'PAIR_SECRET_STORAGE_KEY',
  'PAIR_PENDING_SECRET_KEY',
  "status: 'committed'",
  'markConfirmed',
  'discardIncomplete',
  'normalizeDeviceName',
  'discardPendingVerified',
  'deleteDurableVerified',
]) {
  if (!trust.includes(marker)) throw new Error(`Pair trust repository missing ${marker}.`);
}
if (/ordinaryStore\.setString\([^\n]+pairKeyHex/.test(trust)) throw new Error('Durable pair key must never be written to AsyncStorage.');

const secureKeyAssignments = [
  'PAIR_SECRET_STORAGE_KEY',
  'PAIR_PENDING_SECRET_KEY',
].map((constantName) => {
  const match = trust.match(new RegExp(`${constantName}\\s*=\\s*'([^']+)'`));
  if (!match) throw new Error(`M2 SecureStore constant ${constantName} must be statically declared.`);
  return match[1];
});
for (const key of secureKeyAssignments) {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`SecureStore key uses unsupported characters: ${key}`);
}
const secureAdapter = read('src/platform/persistence/ExpoSecureSecretStore.ts');
if (!secureAdapter.includes('EXPO_SECURE_STORE_KEY') || !secureAdapter.includes('requireValidSecureStoreKey')) {
  throw new Error('SecureStore adapter must validate keys before crossing the native boundary.');
}

const crypto = read('src/platform/pairing/ExpoPairingCrypto.ts');
for (const marker of ['AESEncryptionKey', 'AESKeySize.AES256', 'aesEncryptAsync', 'aesDecryptAsync', 'additionalData']) {
  if (!crypto.includes(marker)) throw new Error(`M2 authenticated encryption missing ${marker}.`);
}

const protocol = read('src/domain/pairing/PairingProtocol.ts');
for (const marker of ['requireExactKeys', 'parseHelloPayload', 'parseConfirmPayload', 'parseCancelPayload', 'parseErrorPayload', 'normalizeDeviceName']) {
  if (!protocol.includes(marker)) throw new Error(`Strict pairing protocol validation missing ${marker}.`);
}

const pairingSourcePaths = [
  'src/application/PairingService.ts',
  'src/domain/pairing/PairingProtocol.ts',
];
const allowedPairMessages = new Set([
  'PAIR_HELLO', 'PAIR_IDENTITY', 'PAIR_CONFIRM', 'PAIR_COMMIT', 'PAIR_COMMIT_ACK', 'PAIR_CANCEL', 'PAIR_ERROR',
]);
for (const sourcePath of pairingSourcePaths) {
  const matches = read(sourcePath).match(/PAIR_[A-Z_]+/g) ?? [];
  for (const message of matches) {
    if (!allowedPairMessages.has(message)) throw new Error(`Speculative pairing protocol message found: ${message}`);
  }
}

const pairingService = read('src/application/PairingService.ts');
for (const marker of ['operationQueue', 'enqueueOperation', 'unownedListenerId', 'durableConvergenceReached', 'expectedAttemptId', 'expectedConnectionId']) {
  if (!pairingService.includes(marker)) throw new Error(`Pairing lifecycle hardening missing ${marker}.`);
}
const transportErrorContract = read('src/domain/pairing/PairingTransportError.ts');
if (!transportErrorContract.includes('Product-safe transport failure') || transportErrorContract.includes('expo-')) {
  throw new Error('Pairing transport errors must remain a pure product-safe TypeScript contract.');
}
const transportAdapter = read('src/platform/pairing/ExpoPairingTransport.ts');
if (!transportAdapter.includes('PairingTransportError') || !transportAdapter.includes('partner_unreachable')) {
  throw new Error('Native transport failures must be mapped to sanitized product errors.');
}
if (!transportAdapter.includes("require('../../../modules/partner-pairing-transport')")) {
  throw new Error('Native pairing module evaluation must remain deferred behind the platform adapter for headless tests.');
}
const home = read('app/index.tsx');
if (!home.includes('Resume pairing')) throw new Error('Active M2 pairing must have an explicit resume path from Home.');
if (!read('app/pair/create.tsx').includes('.catch(() => undefined)') || !read('app/pair/scan.tsx').includes('.catch(() => undefined)')) {
  throw new Error('Pairing UI must contain expected async rejections instead of leaking unhandled promises.');
}

// Historical M2 verification protects M2-owned pairing code only. Later milestones are
// allowed to add their own UI, dependencies and protocol vocabulary; their own milestone
// verifiers decide when those capabilities become legal. This prevents M2 regression
// checks from becoming a global future-feature tripwire once the DAG advances.
for (const forbidden of ['partner-discovery', 'MediaProjection', 'REQUEST_SCREEN', 'RTC_OFFER']) {
  const m2OwnedPaths = [
    'src/application/PairingService.ts',
    'src/domain/pairing/PairingProtocol.ts',
    'src/platform/pairing/ExpoPairingTransport.ts',
  ];
  if (m2OwnedPaths.some((p) => read(p).includes(forbidden))) {
    throw new Error(`${forbidden} must not contaminate M2-owned pairing code.`);
  }
}

const diagnostic = read('src/application/DiagnosticsReport.ts');
if (diagnostic.includes('pairKey') || diagnostic.includes('bootstrapKey') || diagnostic.includes('PAIR_SECRET')) {
  throw new Error('Diagnostics must not expose pairing credentials.');
}
const diagnosticEvent = read('src/domain/diagnostics/DiagnosticEvent.ts');
if (!diagnosticEvent.includes("const allowed = new Set(['schemaVersion', 'at', 'kind'])")) {
  throw new Error('Persisted diagnostics must reject unknown fields to stay sanitized by construction.');
}

console.log('M2 static contract: PASSED');
