import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { appServices } from '../src/application/AppServices';

export default function RootLayout() {
  useEffect(() => {
    void appServices.diagnosticsRepository.append('app_started').catch(() => undefined);
    void appServices.pairingService.initialize();
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
