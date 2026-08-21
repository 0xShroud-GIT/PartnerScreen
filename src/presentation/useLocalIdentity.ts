import { useCallback, useEffect, useState } from 'react';
import type { LocalDeviceIdentity } from '../domain/identity/LocalDeviceIdentity';
import { appServices } from '../application/AppServices';

export interface LocalIdentityState {
  identity: LocalDeviceIdentity | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  saveDeviceName(input: string): Promise<boolean>;
  reload(): Promise<void>;
}

function toPublicError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected local identity error.';
}

export function useLocalIdentity(): LocalIdentityState {
  const [identity, setIdentity] = useState<LocalDeviceIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIdentity(await appServices.localIdentityService.bootstrap());
    } catch (loadError) {
      setError(toPublicError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveDeviceName = useCallback(async (input: string): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      setIdentity(await appServices.localIdentityService.rename(input));
      return true;
    } catch (saveError) {
      setError(toPublicError(saveError));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { identity, loading, saving, error, saveDeviceName, reload };
}
