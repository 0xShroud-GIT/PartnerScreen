import { useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

export function useMediaSession() {
  const state = useSyncExternalStore(appServices.mediaSessionController.subscribe, appServices.mediaSessionController.getSnapshot, appServices.mediaSessionController.getSnapshot);
  const stats = useSyncExternalStore(appServices.mediaSessionController.subscribe, appServices.mediaSessionController.getStatsSnapshot, appServices.mediaSessionController.getStatsSnapshot);
  const health = useSyncExternalStore(appServices.mediaSessionController.subscribe, appServices.mediaSessionController.getLiveHealth, appServices.mediaSessionController.getLiveHealth);
  return {
    state,
    stats,
    health,
    rendererFirstFrame: (sessionId: string, rendererEpoch: number) => appServices.mediaSessionController.rendererFirstFrame(sessionId, rendererEpoch),
    reconcile: () => appServices.mediaSessionController.reconcile(),
    clearError: () => appServices.mediaSessionController.clearError(),
  };
}
