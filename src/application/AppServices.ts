import { DiagnosticsRepository } from '../domain/diagnostics/DiagnosticsRepository';
import { HmacDiscoveryAuthenticator } from '../domain/discovery/TrustedDiscoveryAuthenticator';
import { IdentityRepository, type Clock } from '../domain/identity/IdentityRepository';
import { PairTrustRepository } from '../domain/pairing/PairTrustRepository';
import { ExpoDiscoveryHmac } from '../platform/discovery/ExpoDiscoveryHmac';
import { ExpoPartnerDiscovery } from '../platform/discovery/ExpoPartnerDiscovery';
import { ExpoDeviceIdFactory } from '../platform/identity/ExpoDeviceIdFactory';
import { ExpoPairingCrypto } from '../platform/pairing/ExpoPairingCrypto';
import { ExpoPairingTransport } from '../platform/pairing/ExpoPairingTransport';
import { AsyncStorageKeyValueStore } from '../platform/persistence/AsyncStorageKeyValueStore';
import { ExpoSecureSecretStore } from '../platform/persistence/ExpoSecureSecretStore';
import { ExpoControlTransport } from '../platform/control/ControlTransport';
import { ExpoControlCrypto } from '../platform/control/ExpoControlCrypto';
import { ExpoControlHmac } from '../platform/control/ExpoControlHmac';
import { ExpoScreenCapture } from '../platform/capture/ExpoScreenCapture';
import { ExpoWebRtcMedia } from '../platform/media/ExpoWebRtcMedia';
import { AvailabilityService } from '../availability/AvailabilityService';
import { ControlSession } from '../control/ControlSession';
import { AuthenticatedSignalingCipher } from '../security/AuthenticatedSignalingCipher';
import { PendingRequestStore } from '../request/PendingRequestStore';
import { SessionController } from '../session/SessionController';
import { ScreenCaptureCoordinator } from '../capture/ScreenCaptureCoordinator';
import { MediaSessionController } from '../media/MediaSessionController';
import { InstrumentedPairingCrypto } from './InstrumentedPairingCrypto';
import { LocalIdentityService } from './LocalIdentityService';
import { PairingService } from './PairingService';

const clock: Clock = { nowIso: () => new Date().toISOString() };
const ordinaryStore = new AsyncStorageKeyValueStore();
const secureStore = new ExpoSecureSecretStore();
const diagnosticsRepository = new DiagnosticsRepository(ordinaryStore, clock);
const identityRepository = new IdentityRepository(ordinaryStore, new ExpoDeviceIdFactory(), clock);
const localIdentityService = new LocalIdentityService(identityRepository, diagnosticsRepository);
const pairTrustRepository = new PairTrustRepository(ordinaryStore, secureStore);
const pairingCrypto = new InstrumentedPairingCrypto(new ExpoPairingCrypto(), diagnosticsRepository);
const pairingService = new PairingService(identityRepository, pairTrustRepository, diagnosticsRepository, new ExpoPairingTransport(), pairingCrypto);

const controlSession = new ControlSession(new ExpoControlTransport(), new AuthenticatedSignalingCipher(new ExpoControlCrypto(), new ExpoControlHmac()));
const pendingRequestStore = new PendingRequestStore(ordinaryStore);
const sessionController = new SessionController(identityRepository, pairTrustRepository, pendingRequestStore, controlSession, diagnosticsRepository);
const screenCapturePort = new ExpoScreenCapture();
const screenCaptureCoordinator = new ScreenCaptureCoordinator(screenCapturePort, sessionController, diagnosticsRepository);
const webRtcMediaPort = new ExpoWebRtcMedia();
const mediaSessionController = new MediaSessionController(webRtcMediaPort, sessionController, screenCaptureCoordinator, diagnosticsRepository);
const discoveryAuthenticator = new HmacDiscoveryAuthenticator(new ExpoDiscoveryHmac());
const availabilityService = new AvailabilityService(pairTrustRepository, diagnosticsRepository, new ExpoPartnerDiscovery(), discoveryAuthenticator, controlSession);

availabilityService.subscribe(() => sessionController.updateAvailability(availabilityService.getSnapshot()));
let pairedLifecycle: Promise<void> = Promise.resolve();
pairingService.subscribe(() => {
  pairedLifecycle = pairedLifecycle.then(async () => {
    const state = pairingService.getSnapshot();
    if (state.kind === 'paired') {
      await sessionController.activatePair(state.pair);
      await availabilityService.activate(state.pair);
      sessionController.updateAvailability(availabilityService.getSnapshot());
    } else if (state.kind === 'unpaired') {
      await availabilityService.deactivate();
      await sessionController.deactivatePair();
    }
  }).catch(() => undefined);
});
void pairingService.initialize().catch(() => undefined);

export const appServices = {
  clock, diagnosticsRepository, identityRepository, localIdentityService, pairTrustRepository, pairingService,
  availabilityService, controlSession, sessionController, screenCaptureCoordinator, mediaSessionController,
};
