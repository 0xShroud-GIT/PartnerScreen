import { useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

let cached: ReturnType<typeof read> | null = null;
function read() {
  return {
    state: appServices.mediaSession.getSnapshot(),
    stats: appServices.mediaSession.getStatsSnapshot(),
    remoteStreamURL: appServices.mediaSession.getRemoteStreamURL(),
  };
}
function snapshot() {
  const next = read();
  if (cached && cached.state === next.state && cached.stats === next.stats && cached.remoteStreamURL === next.remoteStreamURL) return cached;
  cached = next;
  return next;
}

export function useMediaSession() {
  const value = useSyncExternalStore(appServices.mediaSession.subscribe, snapshot, snapshot);
  return {
    ...value,
    startSharing: () => appServices.mediaSession.startSharing(),
    stop: () => appServices.mediaSession.stop(),
    reconcile: () => appServices.mediaSession.reconcile(),
  };
}
