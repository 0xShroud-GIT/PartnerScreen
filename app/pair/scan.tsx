import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { usePairing } from '../../src/presentation/usePairing';
import { consumeRuntimeLabPairingQr } from '../../src/runtime/RuntimeLabPairingInput';
import { runtimeLabPairingCameraSubstituteEnabled } from '../../src/runtime/RuntimeLabFlags';

export default function ScanPairScreen() {
  const pairing = usePairing();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanLocked, setScanLocked] = useState(false);
  const runtimeLabInput = runtimeLabPairingCameraSubstituteEnabled();

  useEffect(() => {
    if (pairing.state.kind === 'paired') router.replace('/');
  }, [pairing.state.kind]);

  useEffect(() => {
    if (!runtimeLabInput || pairing.state.kind !== 'unpaired' || scanLocked) return;
    let cancelled = false;
    void consumeRuntimeLabPairingQr().then((payload) => {
      if (cancelled || !payload) return;
      setScanLocked(true);
      void pairing.startScanner(payload).catch(() => undefined);
    });
    return () => { cancelled = true; };
  }, [runtimeLabInput, pairing.state.kind, scanLocked]);

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
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>Scan partner QR</Text>
      <Text style={styles.help}>Only scan a QR shown inside Chirp on the phone you intend to trust.</Text>

      {runtimeLabInput && scanning ? (
        <View style={styles.card}>
          <ActivityIndicator />
          <Text style={styles.label}>Runtime Lab pairing input ready</Text>
          <Text style={styles.help}>Waiting for the emulator runner to provide the creator's real one-time QR payload. Normal Chirp authentication and confirmation still apply.</Text>
        </View>
      ) : null}

      {!runtimeLabInput && !permission ? <ActivityIndicator /> : null}
      {!runtimeLabInput && permission && !permission.granted ? (
        <View style={styles.card}>
          <Text style={styles.label}>Camera permission is needed only to scan the pairing QR.</Text>
          <Pressable accessibilityRole="button" onPress={() => { void requestPermission(); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>Allow camera</Text>
          </Pressable>
        </View>
      ) : null}

      {!runtimeLabInput && permission?.granted && scanning ? (
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
        </View>
      ) : null}

      {pairing.state.kind === 'waiting_partner' && pairing.state.role === 'scanner' ? (
        <View style={styles.card}>
          <ActivityIndicator />
          {pairing.state.peer ? <Peer peer={pairing.state.peer} /> : null}
          <Text style={styles.help}>{pairing.state.message}</Text>
        </View>
      ) : null}

      {pairing.state.kind === 'confirm_partner' && pairing.state.role === 'scanner' ? (
        <View style={styles.card}>
          <Text style={styles.label}>Authenticated phone</Text>
          <Peer peer={pairing.state.peer} />
          <Text style={styles.help}>Check that this name matches the phone showing the QR. You confirm first; the creator must then confirm you separately.</Text>
          <Pressable accessibilityRole="button" onPress={() => { void pairing.confirmPartner().catch(() => undefined); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>Confirm this phone</Text>
          </Pressable>
        </View>
      ) : null}

      {pairing.state.kind === 'finalizing' && pairing.state.role === 'scanner' ? (
        <View style={styles.card}>
          <ActivityIndicator />
          <Text style={styles.label}>Saving trust on both phones…</Text>
          <Text style={styles.help}>Keep Chirp open until pairing finishes.</Text>
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
  container: { flexGrow: 1, gap: 18, padding: 24, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '800' },
  help: { fontSize: 14, lineHeight: 20, opacity: 0.75 },
  card: { borderWidth: 1, borderColor: '#999', borderRadius: 14, gap: 14, padding: 16 },
  label: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  cameraFrame: { height: 360, overflow: 'hidden', borderRadius: 16, borderWidth: 1, borderColor: '#777' },
  camera: { flex: 1 },
  peer: { gap: 4, alignItems: 'center' },
  peerName: { fontSize: 24, fontWeight: '800' },
  peerId: { fontFamily: 'monospace', opacity: 0.72 },
  primary: { alignItems: 'center', backgroundColor: '#111', borderRadius: 10, padding: 14 },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cancel: { alignItems: 'center', borderWidth: 1, borderColor: '#a00', borderRadius: 10, padding: 13 },
  cancelText: { color: '#a00', fontWeight: '700' },
  pressed: { opacity: 0.7 },
  errorBox: { borderWidth: 1, borderColor: '#a00', borderRadius: 10, gap: 10, padding: 12 },
  error: { color: '#a00' },
  link: { fontWeight: '700', textDecorationLine: 'underline' },
});
