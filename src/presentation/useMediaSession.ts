import { useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

let cachedPresentation: ReturnType<typeof readPresentation> | null = null;
function readPresentation() {
  return {
    state: appServices.mediaSessionController.getSnapshot(),
    stats: appServices.mediaSessionController.getStatsSnapshot(),
    health: appServices.mediaSessionController.getLiveHealth(),
    transport: appServices.mediaSessionController.getTransportSnapshot(),
  };
}
function getPresentationSnapshot() {
  const next = readPresentation();
  if (
    cachedPresentation
    && cachedPresentation.state === next.state
    && cachedPresentation.stats === next.stats
    && cachedPresentation.health === next.health
    && cachedPresentation.transport === next.transport
  ) return cachedPresentation;
  cachedPresentation = next;
  return cachedPresentation;
}

export function useMediaSession() {
  const snapshot = useSyncExternalStore(appServices.mediaSessionController.subscribe, getPresentationSnapshot, getPresentationSnapshot);
  return {
    state: snapshot.state,
    stats: snapshot.stats,
    health: snapshot.health,
    transport: snapshot.transport,
    rendererFirstFrame: (sessionId: string, rendererEpoch: number) => appServices.mediaSessionController.rendererFirstFrame(sessionId, rendererEpoch),
    reconcile: () => appServices.mediaSessionController.reconcile(),
    clearError: () => appServices.mediaSessionController.clearError(),
  };
}
