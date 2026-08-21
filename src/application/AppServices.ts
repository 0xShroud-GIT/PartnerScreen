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
import { IncomingRequestNotifier } from '../request/IncomingRequestNotifier';
import { ExpoRequestNotification } from '../platform/notifications/ExpoRequestNotification';
import { ExpoLifecycle } from '../platform/lifecycle/ExpoLifecycle';
import { ExpoKeepAwake } from '../platform/keepawake/ExpoKeepAwake';
import { ExpoPip } from '../platform/pip/ExpoPip';
import { recoverProductError } from '../session/ErrorRecovery';

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
const requestNotificationPort = new ExpoRequestNotification();
const incomingRequestNotifier = new IncomingRequestNotifier(sessionController, requestNotificationPort, diagnosticsRepository);
const lifecyclePort = new ExpoLifecycle();
const keepAwakePort = new ExpoKeepAwake();
const pipPort = new ExpoPip();

availabilityService.subscribe(() => sessionController.updateAvailability(availabilityService.getSnapshot()));

// Lifecycle diagnostics: activity lifecycle + app background/foreground instrumentation
try {
  lifecyclePort.subscribe((event) => {
    void diagnosticsRepository.append(event.type as any).catch(() => undefined);
  });
  // AppState background/foreground is handled in React layer via AppState listener (see _layout)
  // Native pip events are also observed there; keep this native subscription lightweight.
  pipPort.subscribe((event) => {
    const kind = event.isInPictureInPictureMode ? 'pip_entered' : 'pip_exited';
    void diagnosticsRepository.append(kind as any).catch(() => undefined);
  });
} catch {
  // diagnostics never break product flow
}

let pairedLifecycle: Promise<void> = Promise.resolve();
let notificationPromptedAfterPair = false;
pairingService.subscribe(() => {
  pairedLifecycle = pairedLifecycle.then(async () => {
    const state = pairingService.getSnapshot();
    if (state.kind === 'paired') {
      await sessionController.activatePair(state.pair);
      await availabilityService.activate(state.pair);
      sessionController.updateAvailability(availabilityService.getSnapshot());
      if (!notificationPromptedAfterPair) {
        notificationPromptedAfterPair = true;
        await requestNotificationPort.requestPermissionFromForeground().catch(() => 'unknown');
      }
    } else if (state.kind === 'unpaired') {
      await availabilityService.deactivate();
      await sessionController.deactivatePair();
    }
  }).catch(() => undefined);
});
void pairingService.initialize().catch(() => undefined);

export async function recoverFromError(): Promise<void> {
  await recoverProductError({
    session: sessionController,
    media: mediaSessionController,
    capture: screenCaptureCoordinator,
    notifications: requestNotificationPort,
    pip: pipPort,
    keepAwake: keepAwakePort,
  });
}

export const appServices = {
  clock, diagnosticsRepository, identityRepository, localIdentityService, pairTrustRepository, pairingService,
  availabilityService, controlSession, sessionController, screenCaptureCoordinator, mediaSessionController,
  incomingRequestNotifier, requestNotificationPort, lifecyclePort, keepAwakePort, pipPort, recoverFromError,
};
