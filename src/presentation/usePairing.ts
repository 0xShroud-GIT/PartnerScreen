import { useEffect, useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

export function usePairing() {
  const state = useSyncExternalStore(
    appServices.pairingService.subscribe,
    appServices.pairingService.getSnapshot,
    appServices.pairingService.getSnapshot,
  );

  useEffect(() => {
    void appServices.pairingService.initialize();
  }, []);

  return {
    state,
    startCreator: () => appServices.pairingService.startCreator(),
    startScanner: (rawQr: string) => appServices.pairingService.startScanner(rawQr),
    confirmPartner: () => appServices.pairingService.confirmPartner(),
    cancel: () => appServices.pairingService.cancel(),
    revokePair: () => appServices.pairingService.revokePair(),
    resetError: () => appServices.pairingService.resetError(),
  };
}
