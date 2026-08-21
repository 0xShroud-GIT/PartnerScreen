import { useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

export function useMediaSession() {
  const state = useSyncExternalStore(appServices.mediaSessionController.subscribe, appServices.mediaSessionController.getSnapshot, appServices.mediaSessionController.getSnapshot);
  return {
    state,
    rendererFirstFrame: (sessionId: string, rendererEpoch: number) => appServices.mediaSessionController.rendererFirstFrame(sessionId, rendererEpoch),
    reconcile: () => appServices.mediaSessionController.reconcile(),
    clearError: () => appServices.mediaSessionController.clearError(),
  };
}
