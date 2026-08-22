import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { appServices } from '../application/AppServices';

export function useAvailability() {
  const state = useSyncExternalStore(
    appServices.availabilityService.subscribe,
    appServices.availabilityService.getSnapshot,
    appServices.availabilityService.getSnapshot,
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void appServices.availabilityService.retry().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  return {
    state,
    retry: () => appServices.availabilityService.retry(),
  };
}
