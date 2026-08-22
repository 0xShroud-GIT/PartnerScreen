import { useEffect } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useLocalIdentity } from '../src/presentation/useLocalIdentity';
import { usePairing } from '../src/presentation/usePairing';
import { useAvailability } from '../src/presentation/useAvailability';
import { useSession } from '../src/presentation/useSession';
import { useMediaSession } from '../src/presentation/useMediaSession';

function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, (disabled || pressed) && styles.buttonMuted]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

export default function Home() {
  const identity = useLocalIdentity();
  const pairing = usePairing();
  const availability = useAvailability();
  const session = useSession();
  const media = useMediaSession();

  useEffect(() => {
    if (session.state.type === 'Connected' && session.state.role === 'requester') router.replace('/viewer');
  }, [session.state]);

  const pair = pairing.state.kind === 'paired' ? pairing.state.pair : null;
  const available = availability.state.kind === 'available';

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>Chirp</Text>
        <Text style={styles.subtitle}>Private screen sharing over your Wi-Fi.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>This phone</Text>
        <Text style={styles.value}>{identity.identity?.deviceName ?? (identity.loading ? 'Loading…' : 'Unknown')}</Text>
      </View>

      {!pair ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Pair two phones</Text>
          <Text style={styles.body}>Pair once. Chirp remembers the trusted phone and only connects to it on the local network.</Text>
          <View style={styles.actions}>
            <Button label="Show pairing QR" onPress={() => router.push('/pair/create')} />
            <Button label="Scan pairing QR" secondary onPress={() => router.push('/pair/scan')} />
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>Trusted phone</Text>
          <Text style={styles.value}>{pair.partnerDeviceName}</Text>
          <Text style={styles.status}>{available ? 'Available on Wi-Fi' : 'Offline'}</Text>

          {session.state.type === 'PairedAvailable' && (
            <Button label="View their screen" onPress={() => void session.requestScreen()} />
          )}
          {session.state.type === 'PairedOffline' && (
            <Button label="Retry discovery" secondary onPress={() => void availability.retry()} />
          )}
          {session.state.type === 'OutgoingRequest' && (
            <>
              <Text style={styles.body}>Waiting for {pair.partnerDeviceName} to accept…</Text>
              <Button label="Cancel" secondary onPress={() => void session.cancelRequest()} />
            </>
          )}
          {session.state.type === 'IncomingRequest' && (
            <>
              <Text style={styles.body}>{pair.partnerDeviceName} wants to view this screen.</Text>
              <View style={styles.actions}>
                <Button label="Share my screen" onPress={() => void session.acceptRequest()} />
                <Button label="Decline" secondary onPress={() => void session.declineRequest()} />
              </View>
            </>
          )}
          {session.state.type === 'Connected' && session.state.role === 'sharer' && (
            <>
              <Text style={styles.body}>{media.state.type === 'awaiting_permission' ? 'Waiting for Android screen permission…' : 'Your screen is being shared.'}</Text>
              <Button label="Stop sharing" onPress={() => void session.endSession(session.state.sessionId)} />
            </>
          )}
          {session.state.type === 'Connected' && session.state.role === 'requester' && (
            <Button label="Open viewer" onPress={() => router.push('/viewer')} />
          )}
          {session.state.type === 'Error' && (
            <>
              <Text style={styles.error}>{session.state.message}</Text>
              <Button label="Recover" onPress={() => void session.recover()} />
            </>
          )}

          <View style={styles.divider} />
          <Button label="Forget trusted phone" secondary onPress={() => void pairing.revokePair()} />
        </View>
      )}

      <Button label="Diagnostics" secondary onPress={() => router.push('/diagnostics')} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 20, gap: 16, backgroundColor: '#0b0d10' },
  header: { gap: 4, paddingTop: 12 },
  title: { color: '#fff', fontSize: 34, fontWeight: '800' },
  subtitle: { color: '#aab1bb', fontSize: 15 },
  card: { backgroundColor: '#15191f', borderRadius: 16, padding: 18, gap: 12 },
  label: { color: '#8d97a5', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8 },
  value: { color: '#fff', fontSize: 21, fontWeight: '700' },
  sectionTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  body: { color: '#c8ced6', fontSize: 15, lineHeight: 21 },
  status: { color: '#9ba7b5', fontSize: 14 },
  error: { color: '#ff9f9f', fontSize: 14, lineHeight: 20 },
  actions: { gap: 10 },
  button: { minHeight: 48, borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  secondaryButton: { backgroundColor: '#222831' },
  buttonMuted: { opacity: 0.6 },
  buttonText: { color: '#0b0d10', fontSize: 16, fontWeight: '700' },
  secondaryButtonText: { color: '#fff' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#303741', marginVertical: 2 },
});
