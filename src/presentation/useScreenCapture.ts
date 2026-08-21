import { useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

export function useScreenCapture() {
  const state = useSyncExternalStore(
    appServices.screenCaptureCoordinator.subscribe,
    appServices.screenCaptureCoordinator.getSnapshot,
    appServices.screenCaptureCoordinator.getSnapshot,
  );
  return {
    state,
    requestForConnectedSharer: () => appServices.screenCaptureCoordinator.requestForConnectedSharer(),
    stopSharing: () => appServices.screenCaptureCoordinator.stopSharing(),
    clearError: () => appServices.screenCaptureCoordinator.clearError(),
  };
}
