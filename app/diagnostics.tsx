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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Diagnostics</Text>
      <Text style={styles.help}>Sanitized local diagnostics only. No pair secret, QR material, SDP, ICE address, raw candidate, SSID, BSSID or full device ID is included.</Text>
      {loading || identityLoading ? <View style={styles.loading}><ActivityIndicator /><Text>Building report…</Text></View> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!loading && !identityLoading && !error ? (
        <>
          <View style={styles.reportBox}><Text style={styles.report}>{report}</Text></View>
          <Pressable onPress={() => void copy()} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Copy report</Text></Pressable>
          {copied ? <Text>Copied.</Text> : null}
          <Pressable onPress={() => void refresh()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Refresh</Text></Pressable>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, gap: 16, padding: 24, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '800' },
  help: { fontSize: 14, lineHeight: 20, opacity: 0.78 },
  loading: { gap: 8, alignItems: 'center' },
  reportBox: { borderWidth: 1, borderColor: '#777', borderRadius: 12, padding: 14 },
  report: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
  primaryButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', borderRadius: 10 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#555', borderRadius: 10 },
  secondaryButtonText: { fontSize: 16, fontWeight: '700' },
  error: { fontWeight: '700' },
});
