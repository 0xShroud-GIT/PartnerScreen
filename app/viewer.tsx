import { useEffect } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { RTCView } from 'react-native-webrtc';
import { useKeepAwake } from 'expo-keep-awake';
import { useSession } from '../src/presentation/useSession';
import { useMediaSession } from '../src/presentation/useMediaSession';

export default function Viewer() {
  useKeepAwake('chirp-viewer');
  const session = useSession();
  const media = useMediaSession();
  const current = session.state;
  const connected = current.type === 'Connected' && current.role === 'requester';
  const sessionId = connected ? current.sessionId : null;

  useEffect(() => {
    if (!connected) router.replace('/');
  }, [connected]);

  const stats = media.stats;
  const status = media.state.type === 'live'
    ? 'Live'
    : media.state.type === 'recovering'
      ? `Reconnecting ${media.state.attempt}/3`
      : media.state.type === 'error'
        ? media.state.message
        : 'Connecting…';

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.videoWrap}>
        {media.remoteStreamURL ? (
          <RTCView streamURL={media.remoteStreamURL} objectFit="contain" mirror={false} style={styles.video} />
        ) : (
          <View style={styles.placeholder}><Text style={styles.placeholderText}>{status}</Text></View>
        )}
      </View>
      <View style={styles.bar}>
        <View style={styles.statusBlock}>
          <Text style={styles.status}>{status}</Text>
          {stats && <Text style={styles.detail}>{stats.frameWidth ?? 0}×{stats.frameHeight ?? 0} · {Math.round(stats.framesPerSecond ?? 0)} fps · {Math.round((stats.receiveBitrateBps ?? 0) / 1000)} kbps</Text>}
        </View>
        <Pressable style={styles.endButton} onPress={() => {
          if (sessionId) void session.endSession(sessionId).finally(() => router.replace('/'));
          else router.replace('/');
        }}>
          <Text style={styles.endText}>End</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' }, videoWrap: { flex: 1, backgroundColor: '#000' }, video: { flex: 1 }, placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' }, placeholderText: { color: '#c8ced6', fontSize: 17 },
  bar: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#0f1216' }, statusBlock: { flex: 1, gap: 3 }, status: { color: '#fff', fontSize: 15, fontWeight: '700' }, detail: { color: '#9aa5b2', fontSize: 12 }, endButton: { minWidth: 72, minHeight: 44, borderRadius: 10, backgroundColor: '#d83a3a', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 }, endText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
