import { useCallback, useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { buildDiagnosticReport } from '../src/application/DiagnosticsReport';
import { appServices } from '../src/application/AppServices';
import { getDiagnosticBuildMetadata } from '../src/platform/diagnostics/ExpoDiagnosticMetadata';
import { useLocalIdentity } from '../src/presentation/useLocalIdentity';

const REPORT_FAILURE = 'Could not build the sanitized diagnostic report. Try again.';
const COPY_FAILURE = 'Could not copy the diagnostic report. Try again.';

export default function DiagnosticsScreen() {
  const { identity, loading: identityLoading } = useLocalIdentity();
  const [report, setReport] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setCopied(false);
    setError(null);
    try {
      const events = await appServices.diagnosticsRepository.list();
      setReport(buildDiagnosticReport({
        generatedAt: appServices.clock.nowIso(),
        identity,
        events,
        build: getDiagnosticBuildMetadata(),
        media: appServices.mediaSession.getDiagnosticSnapshot(),
      }));
    } catch {
      setError(REPORT_FAILURE);
    } finally {
      setLoading(false);
    }
  }, [identity]);

  useEffect(() => { if (!identityLoading) void refresh(); }, [identityLoading, refresh]);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(report);
      setError(null);
      setCopied(true);
    } catch {
      setCopied(false);
      setError(COPY_FAILURE);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>Diagnostics</Text>
      <Text style={styles.help}>Sanitized local diagnostics only. No pair secret, QR material, SDP, ICE address, raw candidate, SSID, BSSID or full device ID is included.</Text>
      {loading || identityLoading ? <View style={styles.loading}><ActivityIndicator color="#ffffff" /><Text style={styles.help}>Building report…</Text></View> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!loading && !identityLoading && !error ? (
        <>
          <View style={styles.reportBox}><Text selectable style={styles.report}>{report}</Text></View>
          <Pressable accessibilityRole="button" onPress={() => void copy()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>Copy report</Text></Pressable>
          {copied ? <Text style={styles.copied}>Copied.</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => void refresh()} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}><Text style={styles.secondaryButtonText}>Refresh</Text></Pressable>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0d10' },
  container: { flexGrow: 1, gap: 16, padding: 24, paddingBottom: 40 },
  title: { color: '#ffffff', fontSize: 28, fontWeight: '800' },
  help: { color: '#b8c0cb', fontSize: 14, lineHeight: 20 },
  loading: { gap: 8, alignItems: 'center' },
  reportBox: { backgroundColor: '#11151a', borderWidth: 1, borderColor: '#303741', borderRadius: 12, padding: 14 },
  report: { color: '#d4dae2', fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  primaryButton: { minHeight: 50, justifyContent: 'center', alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 12 },
  primaryButtonText: { color: '#0b0d10', fontSize: 16, fontWeight: '700' },
  secondaryButton: { minHeight: 50, justifyContent: 'center', alignItems: 'center', backgroundColor: '#222831', borderRadius: 12 },
  secondaryButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  copied: { color: '#8fe0aa', textAlign: 'center', fontWeight: '700' },
  error: { color: '#ffb5ba', fontWeight: '700', lineHeight: 20 },
  pressed: { opacity: 0.65 },
});
