import { useEffect, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { appServices } from '../application/AppServices';

function confirmRevokePair(): Promise<void> {
  return new Promise((resolve) => {
    Alert.alert(
      'Forget trusted phone?',
      'This removes the saved trust on this phone. You will need to pair the two phones again.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => { void appServices.pairingService.revokePair().finally(resolve); },
        },
      ],
      { cancelable: true, onDismiss: () => resolve() },
    );
  });
}

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
    revokePair: confirmRevokePair,
    resetError: () => appServices.pairingService.resetError(),
  };
}
