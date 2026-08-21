import { useSyncExternalStore } from 'react';
import { appServices } from '../application/AppServices';

export function useAvailability() {
  const state = useSyncExternalStore(
    appServices.availabilityService.subscribe,
    appServices.availabilityService.getSnapshot,
    appServices.availabilityService.getSnapshot,
  );

  return {
    state,
    retry: () => appServices.availabilityService.retry(),
  };
}
