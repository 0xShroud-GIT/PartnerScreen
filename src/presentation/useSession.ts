import { useSyncExternalStore } from 'react';
import { appServices, recoverFromError } from '../application/AppServices';

export function useSession() {
  const state = useSyncExternalStore(
    appServices.sessionController.subscribe,
    appServices.sessionController.getSnapshot,
    appServices.sessionController.getSnapshot,
  );

  return {
    state,
    requestScreen: () => appServices.sessionController.requestScreen(),
    acceptRequest: async () => {
      await appServices.sessionController.acceptRequest();
      const next = appServices.sessionController.getSnapshot();
      if (next.type === 'Connected' && next.role === 'sharer') await appServices.mediaSession.startSharing();
    },
    declineRequest: () => appServices.sessionController.declineRequest(),
    cancelRequest: () => appServices.sessionController.cancelRequest(),
    endSession: async (expectedSessionId?: string) => {
      await appServices.mediaSession.stop();
      await appServices.sessionController.endSession(expectedSessionId);
    },
    recover: () => recoverFromError(),
  };
}