import { useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

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
      if (next.type === 'Connected' && next.role === 'sharer') await appServices.screenCaptureCoordinator.requestForConnectedSharer();
    },
    declineRequest: () => appServices.sessionController.declineRequest(),
    cancelRequest: () => appServices.sessionController.cancelRequest(),
    endSession: (expectedSessionId?: string) => appServices.sessionController.endSession(expectedSessionId),
    clearError: () => appServices.sessionController.clearError(),
    recover: async () => {
      await appServices.sessionController.clearError().catch(() => undefined);
      await appServices.mediaSessionController.clearError().catch(() => undefined);
      await appServices.screenCaptureCoordinator.clearError();
    },
  };
}
