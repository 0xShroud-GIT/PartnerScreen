import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { PartnerRemoteVideoView } from '../modules/partner-screen-capture';
import { useMediaSession } from '../src/presentation/useMediaSession';
import { useSession } from '../src/presentation/useSession';
import { appServices } from '../src/application/AppServices';
import { displayedVideoSize, type VideoGeometry } from '../src/platform/pip/videoGeometry';
import { viewerOwnership } from '../src/presentation/ViewerOwnership';

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

  const [isPip, setIsPip] = useState(false);
  const [videoGeometry, setVideoGeometry] = useState<VideoGeometry | null>(null);
  const videoSize = videoGeometry ? displayedVideoSize(videoGeometry) : null;

  const returnHome = useCallback(() => {
    router.replace('/');
  }, []);

  const stopSession = useCallback(async () => {
    await session.endSession().catch(() => undefined);
    returnHome();
  }, [session, returnHome]);

  const enterPip = useCallback(async () => {
    if (!appServices.pipPort.supportsPip() || !videoSize) return;
    await appServices.pipPort.enterPip(videoSize.width, videoSize.height).catch(() => false);
  }, [videoSize]);

  useEffect(() => {
    if (!requesterSessionId) {
      void appServices.pipPort.exitPip().catch(() => false);
      returnHome();
    }
  }, [requesterSessionId, returnHome]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void stopSession();
      return true;
    });
    return () => subscription.remove();
  });

  // Viewer keep-awake: only while dedicated viewer is active for a valid requester session.
  // FLAG_KEEP_SCREEN_ON is scoped to the viewer Activity/window and released on unmount/session end.
  useEffect(() => {
    if (!requesterSessionId) return;
    const becameOwner = viewerOwnership.claim(requesterSessionId);
    if (becameOwner) {
      void appServices.diagnosticsRepository.append('viewer_opened').catch(() => undefined);
      void appServices.keepAwakePort.enable().then((enabled) => {
        if (enabled) void appServices.diagnosticsRepository.append('keep_awake_enabled').catch(() => undefined);
      });
    }
    return () => {
      const released = viewerOwnership.release(requesterSessionId);
      if (!released) return;
      void appServices.keepAwakePort.disable().then((disabled) => {
        if (disabled) void appServices.diagnosticsRepository.append('keep_awake_disabled').catch(() => undefined);
      });
      void appServices.diagnosticsRepository.append('viewer_closed').catch(() => undefined);
    };
  }, [requesterSessionId]);

  // PiP mode tracking to keep video rendering in PiP while session active.
  useEffect(() => {
    const sub = appServices.pipPort.subscribe((event) => {
      setIsPip(event.isInPictureInPictureMode);
    });
    return () => sub();
  }, []);

  // Explicit PiP entry via button is preferred for reliability; auto-enter on background is omitted for first release.
  // Viewer remains awake via keep-awake while foreground; background handling is via system PiP if user tapped.

  useEffect(() => {
    if (!isPip || !videoSize) return;
    void appServices.pipPort.updatePipAspect(videoSize.width, videoSize.height).catch(() => false);
  }, [isPip, videoSize]);

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
        : media.state.type === 'negotiating' && media.state.sessionId === requesterSessionId
          ? 'Connecting private video…'
          : media.state.type === 'error'
            ? media.state.message
            : 'Connecting…';

  const canEnterPip = appServices.pipPort.supportsPip() && rendererReady && !!requesterSessionId && videoSize !== null;

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
            onFrameResolution={(event) => {
              const { width, height, rotation } = event.nativeEvent;
              setVideoGeometry({ width, height, rotation });
            }}
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
          {canEnterPip ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Enter Picture-in-Picture"
              accessibilityHint="Continues the remote video in a floating window while the session remains active."
              onPress={() => { void enterPip(); }}
              style={({ pressed }) => [styles.pipButton, pressed && styles.pressed]}
            >
              <Text style={styles.pipButtonText}>PiP</Text>
            </Pressable>
          ) : null}
        </View>

        {!isPip ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop screen session"
            accessibilityHint="Ends the private screen-sharing session and returns home."
            onPress={() => { void stopSession(); }}
            style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
          >
            <Text style={styles.stopButtonText}>Stop session</Text>
          </Pressable>
        ) : (
          <View style={styles.pipHint}>
            <Text style={styles.pipHintText}>Tap to return</Text>
          </View>
        )}
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
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusPill: { minHeight: 40, justifyContent: 'center', borderRadius: 20, paddingHorizontal: 14, backgroundColor: 'rgba(0,0,0,0.72)' },
  statusText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  pipButton: { minHeight: 40, justifyContent: 'center', alignItems: 'center', borderRadius: 20, paddingHorizontal: 14, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  pipButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  stopButton: { minHeight: 52, justifyContent: 'center', alignItems: 'center', alignSelf: 'center', borderRadius: 26, paddingHorizontal: 24, backgroundColor: 'rgba(150,0,0,0.88)' },
  stopButtonText: { color: '#fff', fontSize: 17, fontWeight: '900' },
  pipHint: { alignSelf: 'center', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(0,0,0,0.6)' },
  pipHintText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
