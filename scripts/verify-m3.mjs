import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const requireFile = (relative) => { if (!existsSync(path.join(root, relative))) throw new Error(`M3 requires ${relative}`); };
const requireMarker = (text, marker, label) => { if (!text.includes(marker)) throw new Error(`${label} missing marker: ${marker}`); };
const forbidMarker = (text, marker, label) => { if (text.includes(marker)) throw new Error(`${label} contains forbidden marker: ${marker}`); };

for (const file of [
  'src/domain/discovery/TrustedDiscoveryAuthenticator.ts', 'src/platform/discovery/PartnerDiscovery.ts',
  'src/platform/discovery/ExpoPartnerDiscovery.ts', 'src/platform/discovery/ExpoDiscoveryHmac.ts',
  'src/availability/AvailabilityService.ts', 'src/presentation/useAvailability.ts',
  'modules/partner-discovery/android/src/main/java/com/partnerscreen/discovery/PartnerDiscoveryModule.kt',
  'modules/partner-discovery-auth/android/src/main/java/com/partnerscreen/discoveryauth/PartnerDiscoveryAuthModule.kt',
  'tests/discovery-auth.test.ts', 'tests/availability.test.ts',
]) requireFile(file);
if (existsSync(path.join(root, 'src/platform/discovery/ExpoSha256Digest.ts'))) throw new Error('Obsolete ExpoSha256Digest must remain absent.');

const pkg = readJson('package.json');
requireMarker(pkg.scripts?.['test:m3'] ?? '', 'tests/discovery-auth.test.ts', 'package.json test:m3');
requireMarker(pkg.scripts?.['test:m3'] ?? '', 'tests/availability.test.ts', 'package.json test:m3');
if (pkg.dependencies?.['react-native-webrtc'] || pkg.devDependencies?.['react-native-webrtc']) throw new Error('WebRTC belongs to M6 and must remain absent before M6.');

const appConfig = read('app.config.ts');
const requestedPermissions = appConfig.match(/\n\s*permissions\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
const blockedPermissions = appConfig.match(/blockedPermissions\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
requireMarker(requestedPermissions, 'android.permission.CHANGE_WIFI_MULTICAST_STATE', 'app.config.ts requested permissions');
for (const permission of ['android.permission.RECORD_AUDIO', 'android.permission.ACCESS_LOCAL_NETWORK', 'android.permission.NEARBY_WIFI_DEVICES']) {
  forbidMarker(requestedPermissions, permission, 'app.config.ts requested permissions');
}
for (const permission of ['android.permission.RECORD_AUDIO', 'android.permission.ACCESS_LOCAL_NETWORK']) {
  requireMarker(blockedPermissions, permission, 'app.config.ts blocked permissions');
}

const auth = read('src/domain/discovery/TrustedDiscoveryAuthenticator.ts');
for (const marker of ['export interface HmacSha256', 'macHex(keyHex: string, message: string)', 'PartnerScreen|discovery-hint|v1|', 'PartnerScreen|discovery-proof|v', 'constantTimeHexEqual', 'verifyPeerHint', 'verifyProof']) requireMarker(auth, marker, 'TrustedDiscoveryAuthenticator.ts');
for (const marker of ['HMAC_BLOCK_BYTES', '0x36', '0x5c', 'Sha256Digest', 'Crypto.digest']) forbidMarker(auth, marker, 'TrustedDiscoveryAuthenticator.ts');

const hmacKotlin = read('modules/partner-discovery-auth/android/src/main/java/com/partnerscreen/discoveryauth/PartnerDiscoveryAuthModule.kt');
for (const marker of ['javax.crypto.Mac', 'HmacSHA256', 'Mac.getInstance(HMAC_ALGORITHM)', 'keyBytes.fill(0)', 'output.fill(0)']) requireMarker(hmacKotlin, marker, 'PartnerDiscoveryAuthModule.kt');
for (const marker of ['Log.', 'println(', 'SharedPreferences', 'AsyncStorage']) forbidMarker(hmacKotlin, marker, 'PartnerDiscoveryAuthModule.kt');

const availability = read('src/availability/AvailabilityService.ts');
for (const marker of ['safeAvailabilityStartMessage', 'this.authenticator.verifyPeerHint', 'this.authenticator.verifyProof', 'await this.discovery.probe', "kind: 'available'", 'availability_partner_found', 'availability_partner_lost']) requireMarker(availability, marker, 'AvailabilityService.ts');
if (availability.includes('const message = error instanceof Error ? error.message')) throw new Error('Availability UI must not receive arbitrary native exception text.');
const hintIndex = availability.indexOf('this.authenticator.verifyPeerHint');
const proofIndex = availability.indexOf('this.authenticator.verifyProof');
const probeIndex = availability.indexOf('await this.discovery.probe');
const availableIndex = availability.indexOf("kind: 'available'", probeIndex);
if (!(hintIndex >= 0 && proofIndex > hintIndex && probeIndex > proofIndex && availableIndex > probeIndex)) throw new Error('Available must follow hint verification, proof verification and reachability probe.');

const kotlin = read('modules/partner-discovery/android/src/main/java/com/partnerscreen/discovery/PartnerDiscoveryModule.kt');
for (const marker of ['NsdManager', '_partnerscreen._tcp.', 'callbackExecutor', 'MulticastLock', 'activeWifiEndpoint', 'val active = connectivity.activeNetwork ?: return null', 'wifi.network.bindSocket(socket)', 'socket.connect(InetSocketAddress(address, port), PROBE_TIMEOUT_MS)', '@Volatile private var registeredServiceName', 'val acceptedRegistration = synchronized(stateLock)']) requireMarker(kotlin, marker, 'PartnerDiscoveryModule.kt');
for (const marker of ['CountDownLatch', 'Thread.sleep', 'connectivity.allNetworks', 'NetworkInterface', 'Log.', 'println(']) forbidMarker(kotlin, marker, 'PartnerDiscoveryModule.kt');
if (kotlin.indexOf('wifi.network.bindSocket(socket)') > kotlin.indexOf('socket.connect(InetSocketAddress(address, port), PROBE_TIMEOUT_MS)')) throw new Error('Probe socket must bind to Wi-Fi before connect.');

const ui = read('app/index.tsx');
requireMarker(ui, 'Available on Wi-Fi', 'app/index.tsx');
console.log('M3 static contract: PASSED');
