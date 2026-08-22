import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MAX_DEVICE_NAME_LENGTH } from '../src/domain/identity/LocalDeviceIdentity';
import { useAvailability } from '../src/presentation/useAvailability';
import { useLocalIdentity } from '../src/presentation/useLocalIdentity';
import { useMediaSession } from '../src/presentation/useMediaSession';
import { usePairing } from '../src/presentation/usePairing';
import { deriveProductPresentation } from '../src/presentation/ProductPresentation';
import { useScreenCapture } from '../src/presentation/useScreenCapture';
import { useSession } from '../src/presentation/useSession';
import { appServices } from '../src/application/AppServices';
import { requestViewerNavigation, viewerOwnership } from '../src/presentation/ViewerOwnership';
import type { NotificationPermissionState } from '../src/request/NotificationPermission';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const identityState = useLocalIdentity();
  const pairing = usePairing();
  const availability = useAvailability();
  const session = useSession();
  const capture = useScreenCapture();
  const media = useMediaSession();
  const [draftName, setDraftName] = useState('');
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>('unknown');
  const requesterSessionId = session.state.type === 'Connected' && session.state.role === 'requester'
    ? session.state.sessionId
    : null;
  const paired = pairing.state.kind === 'paired' ? pairing.state.pair : null;

  useEffect(() => { setDraftName(identityState.identity?.deviceName ?? ''); }, [identityState.identity?.deviceName]);

  // Reserve the route before push so auto/manual/repeated Connected events cannot stack Viewer routes.
  useEffect(() => {
    if (!requesterSessionId) return;
    requestViewerNavigation(requesterSessionId, () => router.push('/viewer'));
    return () => {
      // If navigation never mounted, do not leave a stale reservation blocking the next session.
      viewerOwnership.cancelReservation(requesterSessionId);
    };
  }, [requesterSessionId]);

  // Notification permission is foreground UI state. Refresh when Home is active or returns from Android settings.
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (!paired) {
        if (!disposed) setNotificationPermission('unknown');
        return;
      }
      void appServices.requestNotificationPort.readPermissionState()
        .then((state) => { if (!disposed) setNotificationPermission(state); })
        .catch(() => { if (!disposed) setNotificationPermission('unknown'); });
    };
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      disposed = true;
      sub.remove();
    };
  }, [paired?.pairId]);

  // All hooks stay above this conditional return. React hook order must never depend on identity loading.
  if (identityState.loading) return <View style={styles.center}><ActivityIndicator accessibilityLabel="Loading PartnerScreen" /><Text>Preparing this device…</Text></View>;

  const available = paired && availability.state.kind === 'available' && availability.state.pair.pairId === paired.pairId;
  const notificationPromptable = notificationPermission === 'unknown' || notificationPermission === 'requestable' || notificationPermission === 'dismissed';
  let resumeRoute: '/pair/create' | '/pair/scan' | null = null;
  if (pairing.state.kind === 'creator_qr') resumeRoute = '/pair/create';
  else if (pairing.state.kind === 'waiting_partner' || pairing.state.kind === 'confirm_partner' || pairing.state.kind === 'finalizing') resumeRoute = pairing.state.role === 'creator' ? '/pair/create' : '/pair/scan';

  const product = deriveProductPresentation({ session: session.state, capture: capture.state, media: media.state, mediaHealth: media.health, mediaStats: media.stats });
  const productToneStyle = product.tone === 'positive' ? styles.statusPositive : product.tone === 'attention' ? styles.statusAttention : product.tone === 'danger' ? styles.statusDanger : styles.statusNeutral;

  const forgetPartner = () => Alert.alert('Forget trusted partner?', 'This ends any active request, capture and private video session, then removes saved trust.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Forget partner', style: 'destructive', onPress: () => { void pairing.revokePair().catch(() => undefined); } },
  ]);

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(22, insets.top + 12), paddingBottom: Math.max(44, insets.bottom + 20), paddingLeft: Math.max(22, insets.left + 12), paddingRight: Math.max(22, insets.right + 12) } ]} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>PartnerScreen</Text>
      <Text style={styles.subtitle}>Private trusted-partner screen sharing</Text>

      <View accessibilityLabel={`Current state: ${product.label}. ${product.detail}`} style={[styles.statusCard, productToneStyle]}>
        <Text accessibilityRole="header" style={styles.statusHeading}>Current state</Text>
        <Text accessibilityLiveRegion="polite" style={styles.statusLabel}>{product.label}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.statusDetail}>{product.detail}</Text>
      </View>

      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.label}>This device</Text>
        <TextInput
          accessibilityLabel="This device's name"
          accessibilityHint="Used only to identify this phone to its trusted partner."
          accessibilityState={{ disabled: Boolean(paired || resumeRoute) }}
          editable={!paired && !resumeRoute}
          maxLength={MAX_DEVICE_NAME_LENGTH}
          value={draftName}
          onChangeText={setDraftName}
          placeholder="Device name"
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save device name"
          accessibilityState={{ disabled: Boolean(paired || resumeRoute || identityState.saving) }}
          disabled={Boolean(paired || resumeRoute || identityState.saving)}
          onPress={() => { void identityState.saveDeviceName(draftName); }}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed, (paired || resumeRoute || identityState.saving) && styles.disabled]}
        ><Text style={styles.primaryText}>{identityState.saving ? 'Saving…' : 'Save device name'}</Text></Pressable>
        {identityState.error ? <Text accessibilityRole="alert" style={styles.error}>{identityState.error}</Text> : null}
        <Text style={styles.mono}>{identityState.identity ? `ID …${identityState.identity.deviceId.slice(-8)}` : 'Identity unavailable'}</Text>
      </View>

      {!paired && !resumeRoute ? <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.label}>Pair one trusted phone</Text>
        <Text style={styles.help}>Both phones must be on the same Wi-Fi. Pairing remains explicit and authenticated.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Show pairing QR" accessibilityHint="Creates a short-lived QR code for your trusted partner." accessibilityState={{ disabled: !identityState.identity?.deviceName }} disabled={!identityState.identity?.deviceName} onPress={() => router.push('/pair/create')} style={({ pressed }) => [styles.primary, pressed && styles.pressed, !identityState.identity?.deviceName && styles.disabled]}><Text style={styles.primaryText}>Show pairing QR</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Scan partner QR" accessibilityHint="Opens the QR scanner to pair this phone with one trusted partner." accessibilityState={{ disabled: !identityState.identity?.deviceName }} disabled={!identityState.identity?.deviceName} onPress={() => router.push('/pair/scan')} style={({ pressed }) => [styles.secondary, pressed && styles.pressed, !identityState.identity?.deviceName && styles.disabled]}><Text style={styles.secondaryText}>Scan partner QR</Text></Pressable>
      </View> : null}

      {resumeRoute ? <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.label}>Pairing in progress</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Resume pairing" onPress={() => router.push(resumeRoute)} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><Text style={styles.primaryText}>Resume pairing</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel pairing" accessibilityHint="Cancels the incomplete pairing attempt without creating trust." onPress={() => { void pairing.cancel(); }} style={({ pressed }) => [styles.danger, pressed && styles.pressed]}><Text style={styles.dangerText}>Cancel pairing</Text></Pressable>
      </View> : null}

      {paired ? <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.label}>Trusted partner</Text>
        <Text style={styles.partner}>{paired.partnerDeviceName}</Text>
        <Text>Trusted partner saved.</Text>
        <Text accessibilityLiveRegion="polite" style={available ? styles.available : styles.offline}>{available ? 'Available on Wi-Fi' : 'Offline'}</Text>
        <Text style={styles.help}>Availability means authenticated LAN discovery + reachability. It is not a session or video state.</Text>
        {availability.state.kind === 'offline' && availability.state.message ? <Text accessibilityRole="alert" style={styles.error}>{availability.state.message}</Text> : null}

        {session.state.type === 'PairedAvailable' ? <Pressable accessibilityRole="button" accessibilityLabel="Request partner screen" accessibilityHint="Sends an authenticated screen-sharing request. This does not start capture automatically." onPress={() => { void session.requestScreen(); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><Text style={styles.primaryText}>Request Screen</Text></Pressable> : null}
        {session.state.type === 'OutgoingRequest' ? <><Text accessibilityLiveRegion="polite" style={styles.label}>Request pending</Text><Pressable accessibilityRole="button" accessibilityLabel="Cancel screen request" onPress={() => { void session.cancelRequest(); }} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Cancel request</Text></Pressable></> : null}
        {session.state.type === 'IncomingRequest' ? <><Text accessibilityRole="alert" style={styles.partner}>Screen request received</Text><Text style={styles.help}>Accepting opens Android's own screen-sharing permission UI. PartnerScreen cannot bypass it.</Text><Pressable accessibilityRole="button" accessibilityLabel="Accept screen request and choose screen" accessibilityHint="Accepts the trusted request, then opens Android system screen-capture consent." onPress={() => { void session.acceptRequest(); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><Text style={styles.primaryText}>Accept and choose screen</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Decline screen request" onPress={() => { void session.declineRequest(); }} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Decline</Text></Pressable></> : null}

        {session.state.type === 'Connected' && session.state.role === 'sharer' ? <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.label}>Sharing phone</Text>
          <Text accessibilityLiveRegion="polite" style={capture.state.type === 'capturing' ? styles.available : styles.help}>{capture.state.type === 'capturing' ? 'Android screen capture active' : capture.state.type === 'requesting_consent' ? 'Waiting for Android consent…' : capture.state.type === 'starting' ? 'Starting screen capture…' : 'Capture not active'}</Text>
          <Text accessibilityLiveRegion="polite" style={styles.help}>{(media.state as any).type === 'reconnecting' && (media.state as any).sessionId === (session.state as any).sessionId ? `Private video reconnecting — attempt ${(media.state as any).attempt}/3. LIVE is off.` : (media.state as any).type === 'publishing' ? 'Private WebRTC video offer sent over the authenticated control session.' : (media.state as any).type === 'negotiating' ? 'Negotiating private LAN video…' : ((media.state as any).type === 'publishing' || (media.state as any).type === 'remote_track_attached') && (media.state as any).quality === 'degraded' ? 'Connection degraded — reducing quality to preserve latency.' : 'No audio, recording, remote control, TURN or cloud relay.'}</Text>
          {capture.state.type === 'idle' ? <Pressable accessibilityRole="button" accessibilityLabel="Choose screen to share" accessibilityHint="Opens Android system screen-capture consent." onPress={() => { void capture.requestForConnectedSharer(); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><Text style={styles.primaryText}>Choose screen to share</Text></Pressable> : null}
          {capture.state.type === 'error' ? <Pressable accessibilityRole="button" accessibilityLabel="Retry screen sharing" onPress={() => { void session.recover().catch(() => undefined); }} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Retry</Text></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Stop sharing" accessibilityHint="Stops capture, private video and the active session." onPress={() => { void capture.stopSharing(); }} style={({ pressed }) => [styles.danger, pressed && styles.pressed]}><Text style={styles.dangerText}>Stop sharing</Text></Pressable>
        </View> : null}

        {session.state.type === 'Connected' && session.state.role === 'requester' ? <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.label}>Viewing phone</Text>
          <Text accessibilityLiveRegion="polite" style={styles.help}>{media.state.type === 'reconnecting' && media.state.sessionId === session.state.sessionId ? `Private video interrupted. Reconnecting — attempt ${media.state.attempt}/3; not LIVE.` : media.state.type === 'negotiating' ? 'Negotiating private LAN video…' : media.state.type === 'remote_track_attached' ? 'Remote video track attached. Open the dedicated viewer.' : media.state.type === 'live' && media.state.sessionId === session.state.sessionId ? 'The remote screen is LIVE in the dedicated viewer.' : media.state.type === 'error' ? 'Video connection failed — use Retry below.' : 'Waiting for the sharing phone.'}</Text>
          {media.state.type === 'live' && media.state.sessionId === session.state.sessionId ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.live}>LIVE — remote screen visible</Text> : null}
          {media.state.type === 'reconnecting' && media.state.sessionId === session.state.sessionId ? <Text accessibilityLiveRegion="polite" style={styles.help}>LIVE is off while bounded LAN recovery runs. Attempt {media.state.attempt}/3.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Open remote screen viewer" accessibilityHint="Opens the remote screen on its own full-screen view." onPress={() => { if (!requesterSessionId) return; requestViewerNavigation(requesterSessionId, () => router.push('/viewer')); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><Text style={styles.primaryText}>Open viewer</Text></Pressable>
          {media.state.type === 'error' ? <Pressable accessibilityRole="button" accessibilityLabel="Retry video connection" onPress={() => { void session.recover().catch(() => undefined); }} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Retry</Text></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Stop screen session" accessibilityHint="Ends the authenticated screen-sharing session." onPress={() => { void session.endSession(); }} style={({ pressed }) => [styles.danger, pressed && styles.pressed]}><Text style={styles.dangerText}>Stop session</Text></Pressable>
        </View> : null}

        {capture.state.type === 'error' ? <Text accessibilityRole="alert" style={styles.error}>{capture.state.message}</Text> : null}
        {media.state.type === 'error' ? <Text accessibilityRole="alert" style={styles.error}>{media.state.message}</Text> : null}
        {session.state.type === 'Error' ? <>
          <Text accessibilityRole="alert" style={styles.error}>{session.state.message}</Text>
          <Text style={styles.help}>A failed session has been torn down safely. Pairing is preserved. If the partner is still available, you can request again without restarting the app.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry after session error" accessibilityHint="Clears the failed session and returns to the accurate paired state (available or offline)." onPress={() => { void session.recover().catch(() => undefined); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><Text style={styles.primaryText}>Retry — clear error</Text></Pressable>
          {available ? <Pressable accessibilityRole="button" accessibilityLabel="Request partner screen again" onPress={() => { void (async () => { await session.recover().catch(() => undefined); await session.requestScreen().catch(() => undefined); })(); }} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Request Screen again</Text></Pressable> : <Text style={styles.help}>Partner is currently offline. Retry will return to offline paired state.</Text>}
        </> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Forget trusted partner" accessibilityHint="Ends active sharing and permanently removes the saved trusted relationship." onPress={forgetPartner} style={({ pressed }) => [styles.danger, pressed && styles.pressed]}><Text style={styles.dangerText}>Forget partner</Text></Pressable>
      </View> : null}

      {paired ? <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.label}>Notifications</Text>
        <Text style={styles.help}>Allow notifications to receive screen requests while the app is in background. Notification permission never controls MediaProjection sharing.</Text>
        <Text accessibilityLiveRegion="polite" style={styles.help}>Status: {notificationPermission}</Text>
        {notificationPermission === 'granted' ? <Text style={styles.help}>Notifications enabled.</Text> : null}
        {notificationPromptable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Enable notifications"
            accessibilityHint="Requests notification permission from Android while PartnerScreen is visible."
            onPress={async () => {
              const result = await appServices.requestNotificationPort.requestPermissionFromForeground().catch(() => 'unknown' as NotificationPermissionState);
              setNotificationPermission(result);
            }}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          ><Text style={styles.secondaryText}>Enable notifications</Text></Pressable>
        ) : null}
        {notificationPermission === 'denied' || notificationPermission === 'channel_disabled' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Android notification settings"
            accessibilityHint="Opens Android app settings so notifications can be enabled manually."
            onPress={() => { void Linking.openSettings().catch(() => undefined); }}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          ><Text style={styles.secondaryText}>Open notification settings</Text></Pressable>
        ) : null}
        {notificationPermission === 'denied' ? <Text style={styles.help}>Notifications are disabled — in-app requests and screen sharing still work.</Text> : null}
        {notificationPermission === 'channel_disabled' ? <Text style={styles.help}>The incoming-request notification channel is disabled. Re-enable it in Android settings.</Text> : null}
      </View> : null}

      {pairing.state.kind === 'error' ? <Text accessibilityRole="alert" style={styles.error}>{pairing.state.message}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Open diagnostics" accessibilityHint="Shows a local sanitized diagnostic report with no full device ID or device name." onPress={() => router.push('/diagnostics')} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Open diagnostics</Text></Pressable>
      <Text style={styles.scope}>LIVE means the trusted partner's actual remote frame has rendered. Availability, request acceptance, capture start, SDP, ICE, track attachment and React mounting never make the product LIVE by themselves.</Text>
      <StatusBar style="auto" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, gap: 16, padding: 22, paddingBottom: 44 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, padding: 24 },
  title: { fontSize: 30, fontWeight: '800' },
  subtitle: { fontSize: 16, opacity: 0.78 },
  statusCard: { gap: 6, borderWidth: 2, borderRadius: 14, padding: 16 },
  statusNeutral: { borderColor: '#646b72' },
  statusPositive: { borderColor: '#176b3a' },
  statusAttention: { borderColor: '#8a5a00' },
  statusDanger: { borderColor: '#a00' },
  statusHeading: { fontSize: 14, fontWeight: '700' },
  statusLabel: { fontSize: 20, fontWeight: '900' },
  statusDetail: { fontSize: 14, lineHeight: 20 },
  card: { gap: 10, borderWidth: 1, borderColor: '#9aa0a6', borderRadius: 14, padding: 16 },
  section: { gap: 10, borderTopWidth: 1, borderTopColor: '#c4c7c5', paddingTop: 14 },
  label: { fontSize: 16, fontWeight: '700' },
  partner: { fontSize: 22, fontWeight: '800' },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#777', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 10, fontSize: 17 },
  help: { fontSize: 14, lineHeight: 20, opacity: 0.78 },
  mono: { fontFamily: 'monospace' },
  available: { fontSize: 17, fontWeight: '800' },
  offline: { fontSize: 17, fontWeight: '800', opacity: 0.72 },
  live: { fontSize: 24, fontWeight: '900', textAlign: 'center' },
  error: { fontWeight: '700' },
  primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, paddingHorizontal: 13, backgroundColor: '#111' },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  secondary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, paddingHorizontal: 13, borderWidth: 1, borderColor: '#555' },
  secondaryText: { fontWeight: '800', fontSize: 16 },
  danger: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, paddingHorizontal: 13, borderWidth: 1, borderColor: '#a00' },
  dangerText: { color: '#a00', fontWeight: '800', fontSize: 16 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  scope: { fontSize: 13, lineHeight: 19, opacity: 0.72, textAlign: 'center' },
});