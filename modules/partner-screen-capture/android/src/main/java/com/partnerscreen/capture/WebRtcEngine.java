package com.partnerscreen.capture;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;

import org.webrtc.CapturerObserver;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpParameters;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class WebRtcEngine {
  public interface EventListener { void onEvent(Map<String, Object> event); }
  public interface CaptureListener { void onStarted(boolean success); void onProjectionStopped(); }
  public interface SdpResult { void onSuccess(String sdp); void onFailure(); }
  public interface Result { void onResult(boolean success); }

  private static final int SCREEN_SHARE_MIN_BITRATE_BPS = 1_000_000;
  private static final int SCREEN_SHARE_MAX_BITRATE_BPS = 8_000_000;
  private static final double SCREEN_SHARE_BITRATE_PRIORITY = 4.0;

  private static final class CaptureResources {
    final VideoCapturer capturer;
    final VideoTrack track;
    final VideoSource source;
    final SurfaceTextureHelper helper;

    CaptureResources(VideoCapturer capturer, VideoTrack track, VideoSource source, SurfaceTextureHelper helper) {
      this.capturer = capturer;
      this.track = track;
      this.source = source;
      this.helper = helper;
    }
  }

  private static final WebRtcEngine INSTANCE = new WebRtcEngine();
  public static WebRtcEngine getInstance() { return INSTANCE; }

  private final Object lock = new Object();
  private PeerConnectionFactory factory;
  private EglBase eglBase;
  private VideoCapturer screenCapturer;
  private SurfaceTextureHelper surfaceTextureHelper;
  private VideoSource localVideoSource;
  private VideoTrack localVideoTrack;
  private CaptureListener captureListener;
  // Capture ownership generation: each startScreenCapture gets a unique token; callbacks from an
  // older capture generation are ignored (never redirected to a replacement capture's listener).
  private long captureGeneration = 0;
  private long ownedCaptureToken = 0;
  private PeerConnection peerConnection;
  private RtpSender localVideoSender;
  private VideoTrack remoteVideoTrack;
  private String mediaSessionId;
  private long peerGeneration;
  private static final int MAX_PENDING_CANDIDATES = 512;
  private final List<IceCandidate> pendingRemoteCandidates = new ArrayList<>();
  private VideoSink rendererSink;
  private String rendererSessionId;
  private volatile EventListener eventListener;

  private WebRtcEngine() {}

  public void setEventListener(EventListener listener) { eventListener = listener; }

  public void ensureInitialized(Context context) {
    synchronized (lock) {
      if (factory != null && eglBase != null) return;
      Context app = context.getApplicationContext();
      PeerConnectionFactory.initialize(
        PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions()
      );
      eglBase = EglBase.create();
      factory = PeerConnectionFactory.builder()
        .setVideoEncoderFactory(new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true))
        .setVideoDecoderFactory(new DefaultVideoDecoderFactory(eglBase.getEglBaseContext()))
        .createPeerConnectionFactory();
    }
  }

  public EglBase.Context getEglContext(Context context) {
    ensureInitialized(context);
    synchronized (lock) { return eglBase.getEglBaseContext(); }
  }

  public void startScreenCapture(Context context, Intent consentData, int width, int height, int fps, CaptureListener listener) throws Exception {
    ensureInitialized(context);
    // Unique capture token for THIS start. Callbacks below capture it and may only invoke their own
    // listener while this token is still the owned capture token.
    final long token;
    synchronized (lock) {
      if (screenCapturer != null || localVideoTrack != null) throw new IllegalStateException("Screen capture is already active.");
      token = ++captureGeneration;
    }
    // Build all capture resources OUTSIDE the engine lock. Any failure cleanup below also happens
    // outside the lock (never block/stop/dispose while holding it).
    final VideoCapturer capturer = new ScreenCapturerAndroid(new Intent(consentData), new MediaProjection.Callback() {
      @Override public void onStop() {
        final CaptureListener current;
        synchronized (lock) { current = isCurrentCaptureLocked(token) ? captureListener : null; }
        if (current != null) current.onProjectionStopped();
      }
    });
    VideoSource source = factory.createVideoSource(true);
    SurfaceTextureHelper helper = SurfaceTextureHelper.create("PartnerScreenCaptureThread", eglBase.getEglBaseContext());
    if (helper == null) {
      try { source.dispose(); } catch (Exception ignored) {}
      throw new IllegalStateException("WebRTC capture thread is unavailable.");
    }
    VideoTrack track;
    try {
      CapturerObserver delegate = source.getCapturerObserver();
      CapturerObserver observer = new CapturerObserver() {
        @Override public void onCapturerStarted(boolean success) {
          delegate.onCapturerStarted(success);
          final CaptureListener current;
          synchronized (lock) { current = isCurrentCaptureLocked(token) ? captureListener : null; }
          if (current != null) current.onStarted(success);
        }
        @Override public void onCapturerStopped() { delegate.onCapturerStopped(); }
        @Override public void onFrameCaptured(VideoFrame frame) { delegate.onFrameCaptured(frame); }
      };
      capturer.initialize(helper, context.getApplicationContext(), observer);
      track = factory.createVideoTrack("partnerscreen-screen-video", source);
      track.setEnabled(true);
    } catch (Exception error) {
      try { helper.dispose(); } catch (Exception ignored) {}
      try { source.dispose(); } catch (Exception ignored) {}
      throw error;
    }

    // Atomically record ownership (or discover a concurrent winner) WITHOUT disposing anything under the lock.
    final boolean owned;
    synchronized (lock) {
      if (screenCapturer != null || localVideoTrack != null) {
        owned = false;
      } else {
        ownedCaptureToken = token;
        captureListener = listener;
        screenCapturer = capturer;
        localVideoSource = source;
        surfaceTextureHelper = helper;
        localVideoTrack = track;
        owned = true;
      }
    }
    if (!owned) {
      // A concurrent start/stop won. Discard our freshly built resources OUTSIDE the lock.
      disposeCaptureResources(new CaptureResources(capturer, track, source, helper));
      throw new IllegalStateException("Screen capture is already active.");
    }

    try {
      capturer.startCapture(Math.max(2, width), Math.max(2, height), Math.max(1, Math.min(60, fps)));
    } catch (Exception error) {
      // Take ownership under the lock; actually dispose AFTER releasing it.
      CaptureResources resources;
      synchronized (lock) { resources = takeCaptureLocked(); }
      disposeCaptureResources(resources);
      throw error;
    }
  }

  public void changeScreenCaptureFormat(int width, int height, int fps) {
    final VideoCapturer capturer;
    synchronized (lock) { capturer = screenCapturer; }
    if (capturer == null) return;
    try { capturer.changeCaptureFormat(Math.max(2, width), Math.max(2, height), Math.max(1, Math.min(60, fps))); }
    catch (Exception ignored) {}
  }

  public void stopScreenCapture() {
    final CaptureResources resources;
    synchronized (lock) { resources = takeCaptureLocked(); }
    disposeCaptureResources(resources);
  }

  private CaptureResources takeCaptureLocked() {
    // Invalidate the owned capture token FIRST so no delayed callback from this capture generation
    // can ever be delivered to a replacement capture's listener.
    ownedCaptureToken = 0;
    captureListener = null;
    CaptureResources resources = new CaptureResources(screenCapturer, localVideoTrack, localVideoSource, surfaceTextureHelper);
    screenCapturer = null;
    localVideoTrack = null;
    localVideoSource = null;
    surfaceTextureHelper = null;
    return resources;
  }

  private boolean isCurrentCaptureLocked(long token) {
    return ownedCaptureToken == token && captureListener != null;
  }

  private static void disposeCaptureResources(CaptureResources resources) {
    if (resources.capturer != null) {
      try { resources.capturer.stopCapture(); } catch (Exception ignored) {}
      try { resources.capturer.dispose(); } catch (Exception ignored) {}
    }
    if (resources.track != null) { try { resources.track.dispose(); } catch (Exception ignored) {} }
    if (resources.source != null) { try { resources.source.dispose(); } catch (Exception ignored) {} }
    if (resources.helper != null) { try { resources.helper.dispose(); } catch (Exception ignored) {} }
  }

  public boolean prepareRequester(Context context, String sessionId) {
    ensureInitialized(context);
    synchronized (lock) { return ensurePeerLocked(sessionId, false); }
  }

  public void createPublisherOffer(Context context, String sessionId, SdpResult result) {
    ensureInitialized(context);
    final PeerConnection pc;
    final long generation;
    synchronized (lock) {
      if (localVideoTrack == null || !ensurePeerLocked(sessionId, true)) { result.onFailure(); return; }
      pc = peerConnection;
      generation = peerGeneration;
    }
    pc.createOffer(new CreateSdpObserver(pc, sessionId, generation, result), new MediaConstraints());
  }

  public void acceptOffer(Context context, String sessionId, String sdp, SdpResult result) {
    ensureInitialized(context);
    final PeerConnection pc;
    final long generation;
    synchronized (lock) {
      if (!ensurePeerLocked(sessionId, false)) { result.onFailure(); return; }
      pc = peerConnection;
      generation = peerGeneration;
    }
    pc.setRemoteDescription(new SetRemoteThenObserver(pc, sessionId, generation, true, result), new SessionDescription(SessionDescription.Type.OFFER, sdp));
  }

  public void acceptAnswer(String sessionId, String sdp, Result result) {
    final PeerConnection pc;
    final long generation;
    synchronized (lock) {
      if (peerConnection == null || mediaSessionId == null || !mediaSessionId.equals(sessionId)) { result.onResult(false); return; }
      pc = peerConnection;
      generation = peerGeneration;
    }
    pc.setRemoteDescription(new SetRemoteOnlyObserver(pc, sessionId, generation, result), new SessionDescription(SessionDescription.Type.ANSWER, sdp));
  }

  public boolean addRemoteIceCandidate(String sessionId, String sdpMid, int sdpMLineIndex, String candidate) {
    if (!isPrivateHostCandidate(candidate) || sdpMLineIndex < 0 || sdpMLineIndex > 32) return false;
    synchronized (lock) {
      if (peerConnection == null || mediaSessionId == null || !mediaSessionId.equals(sessionId)) return false;
      IceCandidate ice = new IceCandidate(sdpMid.isEmpty() ? null : sdpMid, sdpMLineIndex, candidate);
      if (peerConnection.getRemoteDescription() == null) {
        if (pendingRemoteCandidates.size() >= MAX_PENDING_CANDIDATES) {
          // Fail closed on overflow rather than unbounded buffering; the caller fails the session.
          pendingRemoteCandidates.clear();
          return false;
        }
        pendingRemoteCandidates.add(ice);
        return true;
      }
      return peerConnection.addIceCandidate(ice);
    }
  }

  public void closeMedia(String sessionId) {
    final PeerConnection closingPeer;
    synchronized (lock) {
      if (mediaSessionId != null && !mediaSessionId.equals(sessionId)) return;
      peerGeneration += 1;
      removeRendererFromCurrentTrackLocked(false);
      pendingRemoteCandidates.clear();
      remoteVideoTrack = null;
      localVideoSender = null;
      closingPeer = peerConnection;
      peerConnection = null;
      mediaSessionId = null;
    }
    if (closingPeer != null) {
      try { closingPeer.close(); } catch (Exception ignored) {}
      try { closingPeer.dispose(); } catch (Exception ignored) {}
    }
  }

  public boolean attachRenderer(String sessionId, VideoSink sink) {
    synchronized (lock) {
      removeRendererFromCurrentTrackLocked(true);
      rendererSink = sink;
      rendererSessionId = sessionId;
      if (mediaSessionId == null || !mediaSessionId.equals(sessionId) || remoteVideoTrack == null) return false;
      try { remoteVideoTrack.addSink(sink); return true; }
      catch (Exception ignored) { return false; }
    }
  }

  public void detachRenderer(VideoSink sink) {
    synchronized (lock) {
      if (rendererSink == sink) removeRendererFromCurrentTrackLocked(true);
    }
  }

  private void removeRendererFromCurrentTrackLocked(boolean clearBinding) {
    if (rendererSink != null && remoteVideoTrack != null) {
      try { remoteVideoTrack.removeSink(rendererSink); } catch (Exception ignored) {}
    }
    if (clearBinding) {
      rendererSink = null;
      rendererSessionId = null;
    }
  }

  private void attachDesiredRendererLocked(String sessionId) {
    if (rendererSink == null || rendererSessionId == null || remoteVideoTrack == null || !rendererSessionId.equals(sessionId)) return;
    try { remoteVideoTrack.addSink(rendererSink); } catch (Exception ignored) {}
  }

  private boolean ensurePeerLocked(String sessionId, boolean publisher) {
    if (sessionId == null || sessionId.isEmpty()) return false;
    if (peerConnection != null) return sessionId.equals(mediaSessionId);
    PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(Collections.emptyList());
    config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
    config.iceTransportsType = PeerConnection.IceTransportsType.ALL;
    final long generation = ++peerGeneration;
    mediaSessionId = sessionId;
    pendingRemoteCandidates.clear();
    PeerConnection created = factory.createPeerConnection(config, new PeerObserver(sessionId, generation));
    if (created == null) { if (peerGeneration == generation) mediaSessionId = null; return false; }
    created.setAudioPlayout(false);
    created.setAudioRecording(false);
    peerConnection = created;
    if (publisher) {
      if (localVideoTrack == null) {
        peerGeneration += 1;
        created.dispose();
        peerConnection = null;
        mediaSessionId = null;
        return false;
      }
      localVideoSender = created.addTrack(localVideoTrack, Collections.singletonList("partnerscreen-screen"));
      configureScreenShareSender(localVideoSender);
    }
    return true;
  }

  private static void configureScreenShareSender(RtpSender sender) {
    if (sender == null) return;
    try {
      RtpParameters parameters = sender.getParameters();
      parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION;
      for (RtpParameters.Encoding encoding : parameters.encodings) {
        encoding.bitratePriority = SCREEN_SHARE_BITRATE_PRIORITY;
        encoding.minBitrateBps = SCREEN_SHARE_MIN_BITRATE_BPS;
        encoding.maxBitrateBps = SCREEN_SHARE_MAX_BITRATE_BPS;
        encoding.scaleResolutionDownBy = 1.0;
      }
      sender.setParameters(parameters);
    } catch (RuntimeException ignored) {}
  }

  private boolean isCurrentPeerLocked(String sessionId, long generation) {
    return generation == peerGeneration && mediaSessionId != null && mediaSessionId.equals(sessionId);
  }

  private boolean isCurrentPeerLocked(PeerConnection pc, String sessionId, long generation) {
    return pc == peerConnection && generation == peerGeneration && mediaSessionId != null && mediaSessionId.equals(sessionId);
  }

  private boolean isCurrentPeer(PeerConnection pc, String sessionId, long generation) {
    synchronized (lock) { return isCurrentPeerLocked(pc, sessionId, generation); }
  }

  private void flushPendingLocked(PeerConnection pc) {
    for (IceCandidate candidate : pendingRemoteCandidates) pc.addIceCandidate(candidate);
    pendingRemoteCandidates.clear();
  }

  private final class PeerObserver implements PeerConnection.Observer {
    private final String sessionId;
    private final long generation;
    PeerObserver(String sessionId, long generation) { this.sessionId = sessionId; this.generation = generation; }
    @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
    @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {}
    @Override public void onIceConnectionReceivingChange(boolean receiving) {}
    @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
    @Override public void onIceCandidate(IceCandidate candidate) {
      if (!isPrivateHostCandidate(candidate.sdp)) return;
      synchronized (lock) {
        if (!isCurrentPeerLocked(sessionId, generation)) return;
        Map<String, Object> event = baseEvent("ice_candidate", sessionId);
        event.put("sdpMid", candidate.sdpMid == null ? "" : candidate.sdpMid);
        event.put("sdpMLineIndex", candidate.sdpMLineIndex);
        event.put("candidate", candidate.sdp);
        emit(event);
      }
    }
    @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
    @Override public void onAddStream(MediaStream stream) {}
    @Override public void onRemoveStream(MediaStream stream) {}
    @Override public void onDataChannel(DataChannel channel) { try { channel.close(); } catch (Exception ignored) {} }
    @Override public void onRenegotiationNeeded() {}
    @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
    @Override public void onTrack(RtpTransceiver transceiver) {
      MediaStreamTrack track = transceiver.getReceiver().track();
      if (!(track instanceof VideoTrack)) return;
      synchronized (lock) {
        if (!isCurrentPeerLocked(sessionId, generation)) return;
        removeRendererFromCurrentTrackLocked(false);
        remoteVideoTrack = (VideoTrack) track;
        attachDesiredRendererLocked(sessionId);
        emit(baseEvent("remote_track", sessionId));
      }
    }
    @Override public void onConnectionChange(PeerConnection.PeerConnectionState state) {
      synchronized (lock) {
        if (!isCurrentPeerLocked(sessionId, generation)) return;
        Map<String, Object> event = baseEvent("connection_state", sessionId);
        event.put("state", state.name().toLowerCase(Locale.US));
        emit(event);
      }
    }
  }

  private final class CreateSdpObserver implements SdpObserver {
    private final PeerConnection pc; private final String sessionId; private final long generation; private final SdpResult result;
    CreateSdpObserver(PeerConnection pc, String sessionId, long generation, SdpResult result) {
      this.pc = pc; this.sessionId = sessionId; this.generation = generation; this.result = result;
    }
    @Override public void onCreateSuccess(SessionDescription description) {
      if (!isCurrentPeer(pc, sessionId, generation)) { result.onFailure(); return; }
      pc.setLocalDescription(new SetLocalObserver(pc, sessionId, generation, description.description, result), description);
    }
    @Override public void onSetSuccess() {}
    @Override public void onCreateFailure(String error) { result.onFailure(); }
    @Override public void onSetFailure(String error) { result.onFailure(); }
  }

  private final class SetRemoteThenObserver implements SdpObserver {
    private final PeerConnection pc; private final String sessionId; private final long generation; private final boolean answer; private final SdpResult result;
    SetRemoteThenObserver(PeerConnection pc, String sessionId, long generation, boolean answer, SdpResult result) {
      this.pc = pc; this.sessionId = sessionId; this.generation = generation; this.answer = answer; this.result = result;
    }
    @Override public void onSetSuccess() {
      final boolean current;
      synchronized (lock) {
        current = isCurrentPeerLocked(pc, sessionId, generation);
        if (current) flushPendingLocked(pc);
      }
      if (!current) { result.onFailure(); return; }
      if (!answer) { result.onSuccess(""); return; }
      pc.createAnswer(new CreateSdpObserver(pc, sessionId, generation, result), new MediaConstraints());
    }
    @Override public void onSetFailure(String error) { result.onFailure(); }
    @Override public void onCreateSuccess(SessionDescription description) {}
    @Override public void onCreateFailure(String error) { result.onFailure(); }
  }

  private final class SetRemoteOnlyObserver implements SdpObserver {
    private final PeerConnection pc; private final String sessionId; private final long generation; private final Result result;
    SetRemoteOnlyObserver(PeerConnection pc, String sessionId, long generation, Result result) {
      this.pc = pc; this.sessionId = sessionId; this.generation = generation; this.result = result;
    }
    @Override public void onSetSuccess() {
      final boolean current;
      synchronized (lock) {
        current = isCurrentPeerLocked(pc, sessionId, generation);
        if (current) flushPendingLocked(pc);
      }
      result.onResult(current);
    }
    @Override public void onSetFailure(String error) { result.onResult(false); }
    @Override public void onCreateSuccess(SessionDescription description) {}
    @Override public void onCreateFailure(String error) { result.onResult(false); }
  }

  private final class SetLocalObserver implements SdpObserver {
    private final PeerConnection pc; private final String sessionId; private final long generation; private final String sdp; private final SdpResult result;
    SetLocalObserver(PeerConnection pc, String sessionId, long generation, String sdp, SdpResult result) {
      this.pc = pc; this.sessionId = sessionId; this.generation = generation; this.sdp = sdp; this.result = result;
    }
    @Override public void onSetSuccess() {
      final boolean current; final RtpSender sender;
      synchronized (lock) {
        current = isCurrentPeerLocked(pc, sessionId, generation);
        sender = current ? localVideoSender : null;
      }
      if (!current) { result.onFailure(); return; }
      configureScreenShareSender(sender);
      result.onSuccess(sdp);
    }
    @Override public void onSetFailure(String error) { result.onFailure(); }
    @Override public void onCreateSuccess(SessionDescription description) {}
    @Override public void onCreateFailure(String error) { result.onFailure(); }
  }

  private static Map<String, Object> baseEvent(String type, String sessionId) {
    Map<String, Object> event = new HashMap<>(); event.put("type", type); event.put("sessionId", sessionId); return event;
  }
  private void emit(Map<String, Object> event) { EventListener listener = eventListener; if (listener != null) listener.onEvent(event); }

  private static boolean isPrivateHostCandidate(String candidate) {
    if (candidate == null || candidate.length() > 2048) return false;
    String[] parts = candidate.trim().split("\\s+");
    if (parts.length < 8 || !"typ".equals(parts[6]) || !"host".equals(parts[7])) return false;
    return isPrivateIpv4(parts[4]);
  }
  private static boolean isPrivateIpv4(String host) {
    String[] parts = host.split("\\."); if (parts.length != 4) return false;
    int[] values = new int[4];
    try { for (int i = 0; i < 4; i++) { values[i] = Integer.parseInt(parts[i]); if (values[i] < 0 || values[i] > 255) return false; } }
    catch (NumberFormatException error) { return false; }
    return values[0] == 10 || (values[0] == 172 && values[1] >= 16 && values[1] <= 31) || (values[0] == 192 && values[1] == 168);
  }
}
