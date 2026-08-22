import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAvailability } from '../src/presentation/useAvailability';
import { useLocalIdentity } from '../src/presentation/useLocalIdentity';
import { useMediaSession } from '../src/presentation/useMediaSession';
import { useNotificationPermission } from '../src/presentation/useNotificationPermission';
import { usePairing } from '../src/presentation/usePairing';
import { useSession } from '../src/presentation/useSession';

type ButtonProps = {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
};

function Button({ label, onPress, secondary = false, destructive = false, disabled = false }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        destructive && styles.destructiveButton,
        (disabled || pressed) && styles.buttonMuted,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText, destructive && styles.destructiveButtonText]}>{label}</Text>
    </Pressable>
  );
}

function SharerKeepAwake() {
  useKeepAwake('chirp-sharer');
  return null;
}

function availabilityText(kind: ReturnType<typeof useAvailability>['state']['kind']): string {
  if (kind === 'available') return 'Available on this Wi-Fi';
  if (kind === 'starting') return 'Finding trusted phone…';
  if (kind === 'offline') return 'Not currently reachable';
  return 'Starting trusted discovery…';
}

export default function Home() {
  const identity = useLocalIdentity();
  const pairing = usePairing();
  const availability = useAvailability();
  const session = useSession();
  const media = useMediaSession();
  const notifications = useNotificationPermission();
  const [deviceName, setDeviceName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const sessionState = session.state;

  useEffect(() => {
    if (identity.identity?.deviceName && !editingName) setDeviceName(identity.identity.deviceName);
  }, [editingName, identity.identity?.deviceName]);

  useEffect(() => {
    if (sessionState.type === 'Connected' && sessionState.role === 'requester') router.replace('/viewer');
  }, [sessionState]);

  const pair = pairing.state.kind === 'paired' ? pairing.state.pair : null;
  const hasName = Boolean(identity.identity?.deviceName);
  const sharerSessionId = sessionState.type === 'Connected' && sessionState.role === 'sharer' ? sessionState.sessionId : null;

  const saveName = async () => {
    const saved = await identity.saveDeviceName(deviceName);
    if (saved) setEditingName(false);
  };

  const acceptAndStartSharing = async () => {
    const expectedSessionId = sessionState.type === 'IncomingRequest' ? sessionState.sessionId : null;
    setActionError(null);
    try {
      await session.acceptRequest();
    } catch {
      if (expectedSessionId) await session.endSession(expectedSessionId).catch(() => undefined);
      setActionError('Chirp could not start screen sharing. Check Diagnostics and try the request again.');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {sharerSessionId ? <SharerKeepAwake /> : null}
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Chirp</Text>
          <Text style={styles.subtitle}>Private screen sharing over your Wi-Fi.</Text>
        </View>

        {identity.loading ? (
          <View style={styles.cardRow}>
            <ActivityIndicator color="#ffffff" />
            <Text style={styles.body}>Preparing this phone…</Text>
          </View>
        ) : identity.error ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>This phone could not be prepared</Text>
            <Text accessibilityRole="alert" style={styles.error}>{identity.error}</Text>
            <Button label="Try again" onPress={() => { void identity.reload(); }} />
          </View>
        ) : !hasName || editingName ? (
          <View style={styles.card}>
            <Text style={styles.label}>First, name this phone</Text>
            <Text style={styles.sectionTitle}>{hasName ? 'Rename this phone' : 'Make the phones recognizable'}</Text>
            <Text style={styles.body}>This name is shown on the other phone during secure pairing. You can change it before pairing.</Text>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={64}
              onChangeText={setDeviceName}
              onSubmitEditing={() => { if (deviceName.trim()) void saveName(); }}
              placeholder="e.g. My Galaxy"
              placeholderTextColor="#697382"
              returnKeyType="done"
              style={styles.input}
              value={deviceName}
            />
            {identity.error ? <Text accessibilityRole="alert" style={styles.error}>{identity.error}</Text> : null}
            <Button label={identity.saving ? 'Saving…' : 'Save phone name'} disabled={identity.saving || !deviceName.trim()} onPress={() => { void saveName(); }} />
            {hasName ? <Button label="Cancel" secondary onPress={() => { setDeviceName(identity.identity?.deviceName ?? ''); setEditingName(false); }} /> : null}
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>This phone</Text>
              <View style={styles.identityRow}>
                <Text style={styles.value}>{identity.identity?.deviceName}</Text>
                {!pair ? (
                  <Pressable accessibilityRole="button" onPress={() => setEditingName(true)} hitSlop={10}>
                    <Text style={styles.textButton}>Rename</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>

            {pairing.state.kind === 'loading' ? (
              <View style={styles.cardRow}>
                <ActivityIndicator color="#ffffff" />
                <Text style={styles.body}>Loading trusted phone…</Text>
              </View>
            ) : pairing.state.kind === 'error' ? (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Pairing needs attention</Text>
                <Text accessibilityRole="alert" style={styles.error}>{pairing.state.message}</Text>
                <Button label="Reset pairing state" onPress={() => { void pairing.resetError(); }} />
              </View>
            ) : !pair ? (
              <View style={styles.card}>
                <Text style={styles.label}>Trusted phone</Text>
                <Text style={styles.sectionTitle}>Pair two phones</Text>
                <Text style={styles.body}>Do this once. Both phones verify each other before Chirp saves trust.</Text>
                <View style={styles.actions}>
                  <Button label="Show pairing QR" onPress={() => router.push('/pair/create')} />
                  <Button label="Scan pairing QR" secondary onPress={() => router.push('/pair/scan')} />
                </View>
              </View>
            ) : (
              <>
                <View style={styles.card}>
                  <Text style={styles.label}>Trusted phone</Text>
                  <Text style={styles.value}>{pair.partnerDeviceName}</Text>
                  <View style={styles.statusRow}>
                    <View style={[styles.statusDot, availability.state.kind === 'available' && styles.statusDotOnline]} />
                    <Text style={styles.status}>{availabilityText(availability.state.kind)}</Text>
                  </View>
                  {availability.state.kind === 'offline' && availability.state.message ? <Text style={styles.error}>{availability.state.message}</Text> : null}
                  {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}

                  {sessionState.type === 'PairedAvailable' ? <Button label="View their screen" onPress={() => { setActionError(null); void session.requestScreen(); }} /> : null}
                  {sessionState.type === 'PairedOffline' ? <Button label="Retry discovery" secondary onPress={() => { setActionError(null); void availability.retry(); }} /> : null}
                  {sessionState.type === 'OutgoingRequest' ? (
                    <View style={styles.actions}>
                      <Text style={styles.body}>Waiting for {pair.partnerDeviceName} to accept…</Text>
                      <Button label="Cancel request" secondary onPress={() => { void session.cancelRequest(); }} />
                    </View>
                  ) : null}
                  {sessionState.type === 'IncomingRequest' ? (
                    <View style={styles.requestBox}>
                      <Text style={styles.requestTitle}>{pair.partnerDeviceName} wants to view this screen</Text>
                      <Text style={styles.body}>Nothing is shared until you approve this request and Android's screen-capture prompt.</Text>
                      <Button label="Share my screen" onPress={() => { void acceptAndStartSharing(); }} />
                      <Button label="Decline" secondary onPress={() => { void session.declineRequest(); }} />
                    </View>
                  ) : null}
                  {sharerSessionId ? (
                    <View style={styles.actions}>
                      <Text style={styles.body}>
                        {media.state.type === 'awaiting_permission' ? 'Waiting for Android screen-capture permission…'
                          : media.state.type === 'connecting' ? 'Starting private video…'
                            : media.state.type === 'recovering' ? 'Recovering the Wi-Fi video connection…'
                              : media.state.type === 'error' ? media.state.message
                                : 'Your screen is being shared.'}
                      </Text>
                      <Button label="Stop sharing" destructive onPress={() => { void session.endSession(sharerSessionId); }} />
                    </View>
                  ) : null}
                  {sessionState.type === 'Connected' && sessionState.role === 'requester' ? <Button label="Open viewer" onPress={() => router.push('/viewer')} /> : null}
                  {sessionState.type === 'Error' ? (
                    <View style={styles.actions}>
                      <Text accessibilityRole="alert" style={styles.error}>{sessionState.message}</Text>
                      <Button label="Recover" onPress={() => { setActionError(null); void session.recover(); }} />
                    </View>
                  ) : null}

                  <View style={styles.divider} />
                  <Button label="Forget trusted phone" secondary onPress={() => { void pairing.revokePair(); }} />
                </View>

                {!notifications.loading && notifications.state !== 'granted' ? (
                  <View style={styles.noticeCard}>
                    <Text style={styles.label}>Request alerts</Text>
                    <Text style={styles.sectionTitle}>Don't miss a screen request</Text>
                    <Text style={styles.body}>Allow Chirp notifications so this trusted phone can alert you when a request arrives while Chirp is in the background.</Text>
                    {notifications.error ? <Text accessibilityRole="alert" style={styles.error}>{notifications.error}</Text> : null}
                    {notifications.state === 'denied' || notifications.state === 'channel_disabled' ? (
                      <Button label="Open notification settings" secondary onPress={() => { void Linking.openSettings(); }} />
                    ) : (
                      <Button
                        label={notifications.state === 'prompting' ? 'Waiting for permission…' : 'Allow request alerts'}
                        disabled={notifications.state === 'prompting'}
                        onPress={() => { void notifications.request(); }}
                      />
                    )}
                  </View>
                ) : null}
              </>
            )}
          </>
        )}

        <Pressable accessibilityRole="button" onPress={() => router.push('/diagnostics')} style={({ pressed }) => [styles.diagnosticsLink, pressed && styles.buttonMuted]}>
          <Text style={styles.diagnosticsText}>Diagnostics</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0b0d10' },
  page: { flexGrow: 1, padding: 20, paddingTop: 28, paddingBottom: 36, gap: 16, backgroundColor: '#0b0d10' },
  header: { gap: 5, marginBottom: 4 },
  title: { color: '#ffffff', fontSize: 36, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { color: '#aab1bb', fontSize: 16, lineHeight: 22 },
  card: { backgroundColor: '#15191f', borderRadius: 18, padding: 18, gap: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: '#222832' },
  noticeCard: { backgroundColor: '#121820', borderRadius: 18, padding: 18, gap: 13, borderWidth: 1, borderColor: '#273341' },
  cardRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#15191f', borderRadius: 18, padding: 18 },
  label: { color: '#8d97a5', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  value: { flexShrink: 1, color: '#ffffff', fontSize: 23, fontWeight: '700' },
  sectionTitle: { color: '#ffffff', fontSize: 20, fontWeight: '700', lineHeight: 26 },
  body: { color: '#c8ced6', fontSize: 15, lineHeight: 21 },
  error: { color: '#ffaaaa', fontSize: 14, lineHeight: 20 },
  identityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  textButton: { color: '#c8d8ff', fontSize: 14, fontWeight: '700' },
  input: { minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: '#3a4350', backgroundColor: '#0f1216', color: '#ffffff', paddingHorizontal: 14, fontSize: 17 },
  actions: { gap: 10 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#697382' },
  statusDotOnline: { backgroundColor: '#64d98b' },
  status: { color: '#aeb7c3', fontSize: 14 },
  requestBox: { gap: 11, borderRadius: 14, borderWidth: 1, borderColor: '#39495d', backgroundColor: '#111820', padding: 14 },
  requestTitle: { color: '#ffffff', fontSize: 18, fontWeight: '700', lineHeight: 24 },
  button: { minHeight: 50, borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' },
  secondaryButton: { backgroundColor: '#222831' },
  destructiveButton: { backgroundColor: '#5b2528' },
  buttonMuted: { opacity: 0.55 },
  buttonText: { color: '#0b0d10', fontSize: 16, fontWeight: '700' },
  secondaryButtonText: { color: '#ffffff' },
  destructiveButtonText: { color: '#ffffff' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#303741', marginVertical: 2 },
  diagnosticsLink: { alignSelf: 'center', paddingHorizontal: 18, paddingVertical: 12, marginTop: 2 },
  diagnosticsText: { color: '#7f8996', fontSize: 14, fontWeight: '600' },
});