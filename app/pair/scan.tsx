import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { usePairing } from '../../src/presentation/usePairing';

export default function ScanPairScreen() {
  const pairing = usePairing();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanLocked, setScanLocked] = useState(false);

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

  const retry = async () => {
    await pairing.resetError();
    setScanLocked(false);
  };

  const scanning = pairing.state.kind === 'unpaired' && !scanLocked;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>Scan partner QR</Text>
      <Text style={styles.help}>Only scan a QR shown inside Chirp on the phone you intend to trust.</Text>

      {!permission ? <ActivityIndicator color="#ffffff" /> : null}
      {permission && !permission.granted ? (
        <View style={styles.card}>
          <Text style={styles.label}>Camera access is needed only to scan the temporary pairing QR.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => { if (permission.canAskAgain) void requestPermission(); else void Linking.openSettings(); }}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          >
            <Text style={styles.primaryText}>{permission.canAskAgain ? 'Allow camera' : 'Open camera settings'}</Text>
          </Pressable>
        </View>
      ) : null}

      {permission?.granted && scanning ? (
        <View style={styles.cameraFrame}>
          <CameraView
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            facing="back"
            onBarcodeScanned={({ data }) => {
              if (scanLocked) return;
              setScanLocked(true);
              void pairing.startScanner(data).catch(() => undefined);
            }}
            style={styles.camera}
          />
          <View pointerEvents="none" style={styles.scanGuide} />
        </View>
      ) : null}

      {pairing.state.kind === 'waiting_partner' && pairing.state.role === 'scanner' ? (
        <View style={styles.card}>
          <ActivityIndicator color="#ffffff" />
          {pairing.state.peer ? <Peer peer={pairing.state.peer} /> : null}
          <Text style={styles.help}>{pairing.state.message}</Text>
        </View>
      ) : null}

      {pairing.state.kind === 'confirm_partner' && pairing.state.role === 'scanner' ? (
        <View style={styles.card}>
          <Text style={styles.label}>Authenticated phone</Text>
          <Peer peer={pairing.state.peer} />
          <Text style={styles.help}>Check that this name matches the phone showing the QR. Both phones must confirm independently.</Text>
          <Pressable accessibilityRole="button" onPress={() => { void pairing.confirmPartner().catch(() => undefined); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>Confirm this phone</Text>
          </Pressable>
        </View>
      ) : null}

      {pairing.state.kind === 'finalizing' && pairing.state.role === 'scanner' ? (
        <View style={styles.card}>
          <ActivityIndicator color="#ffffff" />
          <Text style={styles.label}>Saving trust on both phones…</Text>
          <Text style={styles.help}>Keep both phones in Chirp until pairing finishes.</Text>
        </View>
      ) : null}

      {pairing.state.kind === 'error' ? (
        <View style={styles.errorBox}>
          <Text accessibilityRole="alert" style={styles.error}>{pairing.state.message}</Text>
          <Pressable accessibilityRole="button" onPress={() => { void retry().catch(() => undefined); }}>
            <Text style={styles.link}>Scan a new QR</Text>
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
  card: { backgroundColor: '#15191f', borderWidth: StyleSheet.hairlineWidth, borderColor: '#303741', borderRadius: 16, gap: 14, padding: 16 },
  label: { color: '#ffffff', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  cameraFrame: { height: 360, overflow: 'hidden', borderRadius: 18, borderWidth: 1, borderColor: '#3a4350', backgroundColor: '#11151a' },
  camera: { flex: 1 },
  scanGuide: { position: 'absolute', left: '14%', right: '14%', top: '20%', bottom: '20%', borderWidth: 2, borderColor: '#ffffff', borderRadius: 18, opacity: 0.9 },
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
