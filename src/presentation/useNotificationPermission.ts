import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { appServices } from '../application/AppServices';
import type { NotificationPermissionState } from '../request/NotificationPermission';

const PERMISSION_ERROR = 'Chirp could not read Android notification settings.';

export function useNotificationPermission() {
  const [state, setState] = useState<NotificationPermissionState>('unknown');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await appServices.requestNotificationPort.readPermissionState());
      setError(null);
    } catch {
      setState('unknown');
      setError(PERMISSION_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  const request = useCallback(async () => {
    setState('prompting');
    setError(null);
    setLoading(true);
    try {
      const next = await appServices.requestNotificationPort.requestPermissionFromForeground();
      setState(next);
      return next;
    } catch {
      setState('unknown');
      setError(PERMISSION_ERROR);
      return 'unknown' as const;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  return { state, loading, error, refresh, request };
}
