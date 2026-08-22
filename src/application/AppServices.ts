import { DiagnosticsRepository } from '../domain/diagnostics/DiagnosticsRepository';
import { HmacDiscoveryAuthenticator } from '../domain/discovery/TrustedDiscoveryAuthenticator';
import { IdentityRepository, type Clock } from '../domain/identity/IdentityRepository';
import { PairTrustRepository } from '../domain/pairing/PairTrustRepository';
import { ExpoDiscoveryHmac } from '../platform/discovery/ExpoDiscoveryHmac';
import { ExpoChirpDiscovery } from '../platform/discovery/ExpoChirpDiscovery';
import { ExpoDeviceIdFactory } from '../platform/identity/ExpoDeviceIdFactory';
import { ExpoPairingCrypto } from '../platform/pairing/ExpoPairingCrypto';
import { ExpoPairingTransport } from '../platform/pairing/ExpoPairingTransport';
import { AsyncStorageKeyValueStore } from '../platform/persistence/AsyncStorageKeyValueStore';
import { ExpoSecureSecretStore } from '../platform/persistence/ExpoSecureSecretStore';
import { ExpoControlTransport } from '../platform/control/ControlTransport';
import { ExpoControlCrypto } from '../platform/control/ExpoControlCrypto';
import { ExpoControlHmac } from '../platform/control/ExpoControlHmac';
import { AvailabilityService } from '../availability/AvailabilityService';
import { ControlSession } from '../control/ControlSession';
import { AuthenticatedSignalingCipher } from '../security/AuthenticatedSignalingCipher';
import { PendingRequestStore } from '../request/PendingRequestStore';
import { SessionController } from '../session/SessionController';
import { MediaSession } from '../media/MediaSession';
import { InstrumentedPairingCrypto } from './InstrumentedPairingCrypto';
import { LocalIdentityService } from './LocalIdentityService';
import { PairingService } from './PairingService';
import { IncomingRequestNotifier } from '../request/IncomingRequestNotifier';
import { ExpoRequestNotification } from '../platform/notifications/ExpoRequestNotification';
import { systemRuntimeScheduler } from '../runtime/RuntimeScheduler';
import { AvailabilityAwareControlChannel } from './AvailabilityAwareControlChannel';
import { MediaDiagnosticPersistence } from './MediaDiagnosticPersistence';

const clock: Clock = { nowIso: () => new Date().toISOString() };
const ordinaryStore = new AsyncStorageKeyValueStore();
const secureStore = new ExpoSecureSecretStore();
const diagnosticsRepository = new DiagnosticsRepository(ordinaryStore, clock);
const identityRepository = new IdentityRepository(ordinaryStore, new ExpoDeviceIdFactory(), clock);
const localIdentityService = new LocalIdentityService(identityRepository, diagnosticsRepository);
const pairTrustRepository = new PairTrustRepository(ordinaryStore, secureStore);
const pairingCrypto = new InstrumentedPairingCrypto(new ExpoPairingCrypto(), diagnosticsRepository);
const pairingService = new PairingService(
  identityRepository,
  pairTrustRepository,
  diagnosticsRepository,
  new ExpoPairingTransport(),
  pairingCrypto,
);

const controlSession = new ControlSession(
  new ExpoControlTransport(),
  new AuthenticatedSignalingCipher(new ExpoControlCrypto(), new ExpoControlHmac()),
);
const pendingRequestStore = new PendingRequestStore(ordinaryStore);
const discoveryAuthenticator = new HmacDiscoveryAuthenticator(new ExpoDiscoveryHmac());
const availabilityService = new AvailabilityService(
  pairTrustRepository,
  diagnosticsRepository,
  new ExpoChirpDiscovery(),
  discoveryAuthenticator,
  controlSession,
  systemRuntimeScheduler,
);
const availabilityAwareControl = new AvailabilityAwareControlChannel(controlSession, availabilityService);
const sessionController = new SessionController(
  identityRepository,
  pairTrustRepository,
  pendingRequestStore,
  availabilityAwareControl,
  diagnosticsRepository,
);
const mediaSession = new MediaSession(sessionController, diagnosticsRepository);
const mediaDiagnosticPersistence = new MediaDiagnosticPersistence(ordinaryStore, mediaSession);
const requestNotificationPort = new ExpoRequestNotification();
const incomingRequestNotifier = new IncomingRequestNotifier(
  sessionController,
  requestNotificationPort,
  diagnosticsRepository,
);

availabilityService.subscribe(() => {
  sessionController.updateAvailability(availabilityService.getSnapshot());
});

let pairedLifecycle: Promise<void> = Promise.resolve();
pairingService.subscribe(() => {
  pairedLifecycle = pairedLifecycle.then(async () => {
    const state = pairingService.getSnapshot();
    if (state.kind === 'paired') {
      await sessionController.activatePair(state.pair);
      await availabilityService.activate(state.pair);
      sessionController.updateAvailability(availabilityService.getSnapshot());
    } else if (state.kind === 'unpaired') {
      await mediaSession.stop();
      await availabilityService.deactivate();
      await sessionController.deactivatePair();
    }
  }).catch(() => undefined);
});

export async function recoverFromError(): Promise<void> {
  await mediaSession.stop();
  await sessionController.recover();
  await mediaSession.reconcile();
}

export const appServices = {
  clock,
  diagnosticsRepository,
  identityRepository,
  localIdentityService,
  pairTrustRepository,
  pairingService,
  availabilityService,
  controlSession,
  sessionController,
  mediaSession,
  mediaDiagnosticPersistence,
  incomingRequestNotifier,
  requestNotificationPort,
  recoverFromError,
};