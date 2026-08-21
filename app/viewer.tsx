import { useEffect } from 'react';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { PartnerRemoteVideoView } from '../modules/partner-screen-capture';
import { useMediaSession } from '../src/presentation/useMediaSession';
import { useSession } from '../src/presentation/useSession';

export default function ViewerScreen() {
  const session = useSession();
  const media = useMediaSession();
  const requesterSessionId = session.state.type === 'Connected' && session.state.role === 'requester'
    ? session.state.sessionId
    : null;
  const rendererTrackState = requesterSessionId !== null
    && (media.state.type === 'remote_track_attached' || media.state.type === 'live')
    && media.state.sessionId === requesterSessionId
    ? media.state
    : null;
  const rendererReady = rendererTrackState !== null;
  // A replacement remote track inside the same session must create a fresh renderer lifecycle
  // so WebRTC's first-frame callback is earned again instead of inheriting stale LIVE state.
  const rendererEpoch = rendererTrackState?.trackEpoch ?? 0;

  const returnHome = () => {
    router.replace('/');
  };

  const stopSession = async () => {
    await session.endSession().catch(() => undefined);
    returnHome();
  };

  useEffect(() => {
    if (!requesterSessionId) returnHome();
  }, [requesterSessionId]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void stopSession();
      return true;
    });
    return () => subscription.remove();
  });

  if (!requesterSessionId) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Returning to PartnerScreen" />
        <Text style={styles.centerText}>Session ended.</Text>
      </View>
    );
  }

  const status = media.state.type === 'live' && media.state.sessionId === requesterSessionId
    ? 'LIVE'
    : media.state.type === 'remote_track_attached' && media.state.sessionId === requesterSessionId
      ? 'Preparing video…'
      : media.state.type === 'reconnecting' && media.state.sessionId === requesterSessionId
        ? `Reconnecting… ${media.state.attempt}/3`
        : media.state.type === 'error'
          ? media.state.message
          : 'Connecting…';

  return (
    <View accessibilityLabel="Trusted partner screen viewer" style={styles.root}>
      <StatusBar hidden />
      <View style={styles.videoStage}>
        {rendererReady ? (
          <PartnerRemoteVideoView
            key={`${requesterSessionId}:${rendererEpoch}`}
            accessibilityLabel="Trusted partner remote screen video"
            pointerEvents="none"
            sessionId={requesterSessionId}
            style={styles.video}
            onFirstFrame={(event) => { void media.rendererFirstFrame(event.nativeEvent.sessionId, rendererEpoch); }}
          />
        ) : (
          <View style={styles.center}>
            <ActivityIndicator accessibilityLabel="Waiting for partner video" />
            <Text accessibilityLiveRegion="polite" style={styles.centerText}>{status}</Text>
          </View>
        )}
      </View>

      <View pointerEvents="box-none" style={styles.overlay}>
        <View style={styles.topBar}>
          <View accessibilityLiveRegion="polite" style={styles.statusPill}>
            <Text style={styles.statusText}>{status}</Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop screen session"
          accessibilityHint="Ends the private screen-sharing session and returns home."
          onPress={() => { void stopSession(); }}
          style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
        >
          <Text style={styles.stopButtonText}>Stop session</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  videoStage: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#000', padding: 24 },
  centerText: { color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 24 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  statusPill: { minHeight: 40, justifyContent: 'center', borderRadius: 20, paddingHorizontal: 14, backgroundColor: 'rgba(0,0,0,0.72)' },
  statusText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  stopButton: { minHeight: 52, justifyContent: 'center', alignItems: 'center', alignSelf: 'center', borderRadius: 26, paddingHorizontal: 24, backgroundColor: 'rgba(150,0,0,0.88)' },
  stopButtonText: { color: '#fff', fontSize: 17, fontWeight: '900' },
  pressed: { opacity: 0.72 },
});
