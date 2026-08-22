import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { usePairing } from '../../src/presentation/usePairing';

export default function CreatePairScreen() {
  const pairing = usePairing();
  const started = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!started.current && pairing.state.kind === 'unpaired') {
      started.current = true;
      void pairing.startCreator().catch(() => undefined);
    }
  }, [pairing]);

  useEffect(() => {
    if (pairing.state.kind !== 'creator_qr') {
      setSecondsLeft(null);
      return;
    }
    const expires = Date.parse(pairing.state.expiresAt);
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((expires - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing.state]);

  useEffect(() => {
    if (pairing.state.kind === 'paired') router.replace('/');
  }, [pairing.state.kind]);

  const cancel = async () => {
    try {
      await pairing.cancel();
    } catch {
      // PairingService owns the safe product error state.
    } finally {
      router.replace('/');
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>Pair this phone</Text>
      <Text style={styles.help}>Keep both phones on the same Wi-Fi. The QR is temporary and does not pair the phones by itself.</Text>

      {pairing.state.kind === 'loading' ? <ActivityIndicator color="#ffffff" /> : null}

      {pairing.state.kind === 'creator_qr' ? (
        <View style={styles.card}>
          <Text style={styles.label}>Scan this QR on the other phone</Text>
          <View style={styles.qrBox} accessibilityLabel="Temporary Chirp pairing QR code">
            <QRCode value={pairing.state.qrPayload} size={240} quietZone={8} />
          </View>
          <Text style={styles.help}>Expires in {secondsLeft ?? '…'} seconds. The one-time credential inside this QR is not saved as partner trust.</Text>
          <ActivityIndicator color="#ffffff" />
          <Text style={styles.status}>Waiting for the other phone…</Text>
        </View>
      ) : null}

      {pairing.state.kind === 'waiting_partner' && pairing.state.role === 'creator' ? (
        <View style={styles.card}>
          <Text style={styles.label}>{pairing.state.peer ? 'Authenticated phone' : 'Connecting…'}</Text>
          {pairing.state.peer ? <Peer peer={pairing.state.peer} /> : <ActivityIndicator color="#ffffff" />}
          <Text style={styles.help}>{pairing.state.message}</Text>
        </View>
      ) : null}

      {pairing.state.kind === 'confirm_partner' && pairing.state.role === 'creator' ? (
        <View style={styles.card}>
          <Text style={styles.label}>The other phone confirmed you</Text>
          <Peer peer={pairing.state.peer} />
          <Text style={styles.help}>Check the name on the other phone. Confirm only if this is the device you expect.</Text>
          <Pressable accessibilityRole="button" onPress={() => { void pairing.confirmPartner().catch(() => undefined); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>Confirm trusted partner</Text>
          </Pressable>
        </View>
      ) : null}

      {pairing.state.kind === 'finalizing' && pairing.state.role === 'creator' ? (
        <View style={styles.card}>
          <ActivityIndicator color="#ffffff" />
          <Text style={styles.label}>Saving trust on both phones…</Text>
          <Text style={styles.help}>Keep both phones in Chirp until pairing finishes.</Text>
        </View>
      ) : null}

      {pairing.state.kind === 'error' ? (
        <View style={styles.errorBox}>
          <Text accessibilityRole="alert" style={styles.error}>{pairing.state.message}</Text>
          <Pressable accessibilityRole="button" onPress={() => { started.current = false; void pairing.resetError(); }}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable accessibilityRole="button" onPress={() => { void cancel(); }} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
        <Text style={styles.cancelText}>Cancel pairing</Text>
      </Pressable>
    </ScrollView>
  );
}

function Peer({ peer }: { peer: { deviceName: string; deviceId: string } }) {
  return (
    <View style={styles.peer}>
      <Text style={styles.peerName}>{peer.deviceName}</Text>
      <Text style={styles.peerId}>ID …{peer.deviceId.slice(-8)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0d10' },
  container: { flexGrow: 1, gap: 18, padding: 24, paddingBottom: 40 },
  title: { color: '#ffffff', fontSize: 28, fontWeight: '800' },
  help: { color: '#b8c0cb', fontSize: 14, lineHeight: 20 },
  card: { alignItems: 'stretch', backgroundColor: '#15191f', borderWidth: StyleSheet.hairlineWidth, borderColor: '#303741', borderRadius: 16, gap: 14, padding: 16 },
  label: { color: '#ffffff', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  qrBox: { alignSelf: 'center', backgroundColor: '#ffffff', borderRadius: 12, padding: 8 },
  status: { color: '#d9dee5', textAlign: 'center', fontWeight: '600' },
  peer: { gap: 4, alignItems: 'center' },
  peerName: { color: '#ffffff', fontSize: 24, fontWeight: '800' },
  peerId: { color: '#9da7b4', fontFamily: 'monospace' },
  primary: { minHeight: 50, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff', borderRadius: 12, padding: 14 },
  primaryText: { color: '#0b0d10', fontSize: 16, fontWeight: '700' },
  cancel: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#754044', backgroundColor: '#241517', borderRadius: 12, padding: 13 },
  cancelText: { color: '#ffb5ba', fontWeight: '700' },
  pressed: { opacity: 0.65 },
  errorBox: { borderWidth: 1, borderColor: '#754044', backgroundColor: '#241517', borderRadius: 12, gap: 10, padding: 14 },
  error: { color: '#ffb5ba', lineHeight: 20 },
  link: { color: '#ffffff', fontWeight: '700', textDecorationLine: 'underline' },
});
