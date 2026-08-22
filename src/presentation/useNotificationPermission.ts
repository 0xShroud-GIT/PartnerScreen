import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { appServices } from '../application/AppServices';
import type { NotificationPermissionState } from '../request/NotificationPermission';

export function useNotificationPermission() {
  const [state, setState] = useState<NotificationPermissionState>('unknown');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await appServices.requestNotificationPort.readPermissionState());
    } finally {
      setLoading(false);
    }
  }, []);

  const request = useCallback(async () => {
    setState('prompting');
    try {
      const next = await appServices.requestNotificationPort.requestPermissionFromForeground();
      setState(next);
      return next;
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

  return { state, loading, refresh, request };
}
