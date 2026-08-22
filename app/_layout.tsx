import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { appServices } from '../src/application/AppServices';
import { IncomingRequestIngress, parseIncomingRequestSessionId } from '../src/request/incomingRequestRoute';

const incomingIngress = new IncomingRequestIngress();
const BACKGROUND = '#0b0d10';
const SURFACE = '#15191f';

function routeIncomingRequest(sessionId: string | null | undefined): void {
  incomingIngress.route(sessionId, appServices.sessionController.getSnapshot(), () => { router.replace('/'); });
}

function routeIncomingRequestUrl(url: string | null | undefined): void {
  routeIncomingRequest(parseIncomingRequestSessionId(url));
}

export default function RootLayout() {
  useEffect(() => {
    void appServices.diagnosticsRepository.append('app_started').catch(() => undefined);
    void appServices.pairingService.initialize();

    void Linking.getInitialURL().then(routeIncomingRequestUrl).catch(() => undefined);
    const linkingSub = Linking.addEventListener('url', (event) => routeIncomingRequestUrl(event.url));
    void appServices.requestNotificationPort.consumeLaunchSessionId()
      .then(routeIncomingRequest)
      .catch(() => undefined);
    const unsubOpened = appServices.requestNotificationPort.subscribeOpened(routeIncomingRequest);

    return () => {
      linkingSub.remove();
      unsubOpened();
    };
  }, []);

  return (
    <>
      <StatusBar style="light" backgroundColor={BACKGROUND} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: SURFACE },
          headerTintColor: '#ffffff',
          headerShadowVisible: false,
          contentStyle: { backgroundColor: BACKGROUND },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="incoming-request/[sessionId]" options={{ headerShown: false, animation: 'none' }} />
        <Stack.Screen name="viewer" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
        <Stack.Screen name="pair/create" options={{ title: 'Pair phones' }} />
        <Stack.Screen name="pair/scan" options={{ title: 'Scan pairing QR' }} />
      </Stack>
    </>
  );
}
