import { useEffect } from 'react';
import { AppState } from 'react-native';
import { Stack, router } from 'expo-router';
import { appServices } from '../src/application/AppServices';
import { shouldOpenIncomingRequest } from '../src/request/incomingRequestRoute';

function routeIncomingRequest(sessionId: string): void {
  if (shouldOpenIncomingRequest(appServices.sessionController.getSnapshot(), sessionId)) {
    router.replace('/');
  }
}

export default function RootLayout() {
  useEffect(() => {
    void appServices.diagnosticsRepository.append('app_started').catch(() => undefined);
    void appServices.pairingService.initialize();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void appServices.diagnosticsRepository.append('app_foregrounded').catch(() => undefined);
      if (state === 'background') void appServices.diagnosticsRepository.append('app_backgrounded').catch(() => undefined);
    });
    void appServices.requestNotificationPort.consumeLaunchSessionId().then((sessionId) => {
      if (sessionId) routeIncomingRequest(sessionId);
    }).catch(() => undefined);
    const unsubOpened = appServices.requestNotificationPort.subscribeOpened((sessionId) => {
      routeIncomingRequest(sessionId);
    });
    return () => {
      sub.remove();
      unsubOpened();
    };
  }, []);

  return (
    <Stack screenOptions={{ headerTitle: 'PartnerScreen' }}>
      <Stack.Screen name="index" options={{ title: 'PartnerScreen' }} />
      <Stack.Screen name="viewer" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
      <Stack.Screen name="pair/create" options={{ title: 'Show pairing QR' }} />
      <Stack.Screen name="pair/scan" options={{ title: 'Scan partner QR' }} />
    </Stack>
  );
}
