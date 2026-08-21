import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { appServices } from '../../src/application/AppServices';
import { shouldOpenIncomingRequest } from '../../src/request/incomingRequestRoute';

export default function IncomingRequestDeepLink() {
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;

  useEffect(() => {
    if (shouldOpenIncomingRequest(appServices.sessionController.getSnapshot(), sessionId)) {
      router.replace('/');
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [sessionId]);

  return null;
}
