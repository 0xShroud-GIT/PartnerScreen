import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const requireFile = (relative) => { if (!existsSync(path.join(root, relative))) throw new Error(`M4 requires ${relative}`); };
const requireMarker = (text, marker, label) => { if (!text.includes(marker)) throw new Error(`${label} missing M4 marker: ${marker}`); };
const forbidMarker = (text, marker, label) => { if (text.includes(marker)) throw new Error(`${label} contains forbidden M4 marker: ${marker}`); };

for (const file of [
  'src/protocol/ControlMessage.ts', 'src/protocol/ControlCodec.ts',
  'src/security/SignalingCipher.ts', 'src/security/AuthenticatedSignalingCipher.ts',
  'src/platform/control/ControlTransport.ts', 'src/platform/control/ExpoControlCrypto.ts', 'src/platform/control/ExpoControlHmac.ts',
  'src/control/ControlSession.ts', 'src/control/MessageValidator.ts', 'src/control/ReplayGuard.ts',
  'src/session/SessionState.ts', 'src/session/SessionController.ts', 'src/request/PendingRequestStore.ts',
  'src/presentation/useSession.ts',
  'modules/partner-control/expo-module.config.json', 'modules/partner-control/index.ts',
  'modules/partner-control/src/PartnerControl.types.ts', 'modules/partner-control/src/PartnerControlModule.ts',
  'modules/partner-control/android/build.gradle', 'modules/partner-control/android/src/main/AndroidManifest.xml',
  'modules/partner-control/android/src/main/java/com/partnerscreen/control/PartnerControlModule.kt',
  'tests/control-protocol.test.ts', 'tests/control-session.test.ts', 'tests/session-controller.test.ts', 'tests/pending-request.test.ts',
]) requireFile(file);

const pkg = readJson('package.json');
for (const marker of ['tests/control-protocol.test.ts', 'tests/control-session.test.ts', 'tests/session-controller.test.ts', 'tests/pending-request.test.ts']) requireMarker(pkg.scripts?.['test:m4'] ?? '', marker, 'package.json test:m4');
if (pkg.dependencies?.['react-native-webrtc'] || pkg.devDependencies?.['react-native-webrtc']) throw new Error('react-native-webrtc belongs to M6 and must remain absent.');

const protocol = read('src/protocol/ControlMessage.ts');
for (const marker of ['REQUEST_SCREEN', 'REQUEST_CANCEL', 'ACCEPT_SCREEN', 'DECLINE_SCREEN', 'SESSION_END', 'SESSION_ERROR', 'messageId', 'sessionId', 'senderDeviceId', 'sequence', 'timestamp']) requireMarker(protocol, marker, 'ControlMessage.ts');
const codec = read('src/protocol/ControlCodec.ts');
for (const marker of ['exactKeys', 'MAX_CONTROL_FRAME_BYTES', 'canonical UTC ISO-8601', 'decodeHandshakeFrame', 'decodeSealedControlFrame', 'decodeControlMessage']) requireMarker(codec, marker, 'ControlCodec.ts');
const cipher = read('src/security/AuthenticatedSignalingCipher.ts');
for (const marker of ['control-hello1', 'control-hello2', 'control-session-key', 'control-message', 'deriveSessionKey', 'verifyHello1', 'verifyHello2', 'sealMessage', 'openMessage', 'constantTimeHexEqual']) requireMarker(cipher, marker, 'AuthenticatedSignalingCipher.ts');
for (const marker of ['Math.random', 'console.log', 'AsyncStorage', 'SecureStore']) forbidMarker(cipher, marker, 'AuthenticatedSignalingCipher.ts');
const expoCrypto = read('src/platform/control/ExpoControlCrypto.ts');
for (const marker of ['AESKeySize.AES256', 'aesEncryptAsync', 'aesDecryptAsync', 'AESSealedData.fromCombined', 'getRandomBytesAsync', 'SELF_TEST_COMBINED']) requireMarker(expoCrypto, marker, 'ExpoControlCrypto.ts');
const sharedHmac = read('modules/partner-discovery-auth/android/src/main/java/com/partnerscreen/discoveryauth/PartnerDiscoveryAuthModule.kt');
for (const marker of ['MAX_MESSAGE_BYTES = 512', 'javax.crypto.Mac', 'HmacSHA256', 'keyBytes.fill(0)', 'messageBytes.fill(0)', 'output.fill(0)']) requireMarker(sharedHmac, marker, 'PartnerDiscoveryAuthModule.kt');
const session = read('src/control/ControlSession.ts');
for (const marker of ['verifyHello1', 'verifyHello2', 'deriveSessionKey', 'MessageValidator', 'decodeSealedControlFrame', 'openMessage', 'HANDSHAKE_TIMEOUT_MS', 'ensureListening']) requireMarker(session, marker, 'ControlSession.ts');
const validator = read('src/control/MessageValidator.ts');
for (const marker of ['expectedPartnerDeviceId', 'sessionId', 'CONTROL_TIMESTAMP_TOLERANCE_MS', 'ReplayGuard']) requireMarker(validator, marker, 'MessageValidator.ts');
const nativeControl = read('modules/partner-control/android/src/main/java/com/partnerscreen/control/PartnerControlModule.kt');
for (const marker of ['ServerSocket()', 'activeWifiEndpoint', 'val active = connectivity.activeNetwork', 'endpointFor(active)?.let { return it }', 'connectivity.allNetworks', 'mapNotNull { endpointFor(it) }', 'wifi.network.bindSocket(socket)', 'socket.bind(InetSocketAddress(wifi.address, 0))', 'socket.connect(InetSocketAddress(address, port), CONNECT_TIMEOUT_MS)', 'MAX_FRAME_BYTES', 'readInt()', 'writeInt(bytes.size)', 'shutdownAll()']) requireMarker(nativeControl, marker, 'PartnerControlModule.kt');
for (const marker of ['NetworkInterface', 'getNetworkInterfaces', 'Log.', 'println(', 'pairSecret', 'partnerDeviceId', 'partnerDeviceName', 'SharedPreferences', 'AsyncStorage']) forbidMarker(nativeControl, marker, 'PartnerControlModule.kt');
if (nativeControl.indexOf('wifi.network.bindSocket(socket)') > nativeControl.indexOf('socket.connect(InetSocketAddress(address, port), CONNECT_TIMEOUT_MS)')) throw new Error('M4 outbound control socket must be bound to Wi-Fi before connect.');
const availability = read('src/availability/AvailabilityService.ts');
for (const marker of ['ControlListenerSource', 'ensureListening(preparation.host)', 'extractControlPort', 'controlPort', 'endpoint: { host: service.host, port: controlPort }']) requireMarker(availability, marker, 'AvailabilityService.ts');
const discoveryAuth = read('src/domain/discovery/TrustedDiscoveryAuthenticator.ts');
for (const marker of ['controlPort', 'extractControlPort', 'discovery-proof|v2|']) requireMarker(discoveryAuth, marker, 'TrustedDiscoveryAuthenticator.ts');
const controller = read('src/session/SessionController.ts');
for (const marker of ['SessionControlChannel', 'OutgoingRequest', 'IncomingRequest', "type: 'Connected'", 'requestScreen()', 'acceptRequest()', 'declineRequest()', 'cancelRequest()', 'endSession(expectedSessionId?: string)', 'session_timeout']) requireMarker(controller, marker, 'SessionController.ts');
for (const marker of ['MediaProjection', 'RTCPeerConnection', 'react-native-webrtc', "type: 'Live'", "type: 'Sharing'"]) forbidMarker(controller, marker, 'SessionController.ts');

console.log('M4 static contract: PASSED');
