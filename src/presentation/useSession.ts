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
    // Accept only moves the product session to Connected(sharer). Capture/media start
    // is owned by the Home screen's accept flow, so it is invoked exactly once there.
    acceptRequest: () => appServices.sessionController.acceptRequest(),
    declineRequest: () => appServices.sessionController.declineRequest(),
    cancelRequest: () => appServices.sessionController.cancelRequest(),
    endSession: async (expectedSessionId?: string) => {
      await appServices.mediaSession.stop();
      await appServices.sessionController.endSession(expectedSessionId);
    },
    clearError: () => appServices.sessionController.clearError(),
    recover: () => recoverFromError(),
  };
}
