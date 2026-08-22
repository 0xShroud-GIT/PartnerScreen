import { Dimensions, PixelRatio } from 'react-native';
import {
  mediaDevices,
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { AnyMediaControlMessage, ControlPayloadMap, MediaControlMessageType } from '../protocol/ControlMessage';
import type { SessionState } from '../session/SessionState';
import {
  captureResolutionScale,
  classifyIceCandidate,
  MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
  MEDIA_DISCONNECTED_GRACE_MS,
  MEDIA_RESTART_DELAYS_MS,
  MEDIA_SIGNAL_RETRY_MS,
  MEDIA_STATS_INTERVAL_MS,
  SCREEN_FPS,
  senderBitrateParameters,
} from './MediaPolicy';

export type MediaState =
  | { type: 'idle' }
  | { type: 'awaiting_permission'; sessionId: string }
  | { type: 'connecting'; sessionId: string; role: 'requester' | 'sharer' }
  | { type: 'live'; sessionId: string; role: 'requester' | 'sharer' }
  | { type: 'recovering'; sessionId: string; role: 'requester' | 'sharer'; attempt: number }
  | { type: 'error'; sessionId: string; message: string };

export interface MediaStatsSnapshot {
  atMs: number;
  sendBitrateBps?: number | undefined;
  receiveBitrateBps?: number | undefined;
  framesPerSecond?: number | undefined;
  frameWidth?: number | undefined;
  frameHeight?: number | undefined;
  framesEncoded?: number | undefined;
  framesDecoded?: number | undefined;
  framesDropped?: number | undefined;
  keyFramesEncoded?: number | undefined;
  keyFramesDecoded?: number | undefined;
  nackCount?: number | undefined;
  pliCount?: number | undefined;
  firCount?: number | undefined;
  packetsLost?: number | undefined;
  jitterMs?: number | undefined;
  roundTripTimeMs?: number | undefined;
  candidatePairState?: string | undefined;
  codecMimeType?: string | undefined;
  encoderImplementation?: string | undefined;
  decoderImplementation?: string | undefined;
  qualityLimitationReason?: string | undefined;
}

export interface MediaDiagnosticSnapshot {
  state: MediaState['type'];
  role?: 'requester' | 'sharer' | undefined;
  connectionState?: string | undefined;
  iceConnectionState?: string | undefined;
  iceGatheringState?: string | undefined;
  signalingState?: string | undefined;
  remoteTrackSeen: boolean;
  firstFrameSeen: boolean;
  acceptedLocalCandidates: number;
  rejectedLocalCandidates: number;
  acceptedRemoteCandidates: number;
  rejectedRemoteCandidates: number;
  restartAttempts: number;
  bitrateParametersApplied: boolean;
  stats: MediaStatsSnapshot | null;
}

interface MediaAuthority {
  getSnapshot(): SessionState;
  subscribe(listener: () => void): () => void;
  subscribeMedia(listener: (message: AnyMediaControlMessage) => void): () => void;
  sendMedia<T extends MediaControlMessageType>(sessionId: string, type: T, payload: ControlPayloadMap[T]): Promise<void>;
  captureDenied(sessionId: string, reason: 'system_denied' | 'notifications_denied'): Promise<void>;
  captureFailed(sessionId: string, reason: 'capture_failed' | 'capture_revoked'): Promise<void>;
  mediaFailed(sessionId: string): Promise<void>;
}

interface MediaDiagnostics { append(kind: DiagnosticEventKind): Promise<void>; }
type Timer = ReturnType<typeof setTimeout>;
type ByteSample = { atMs: number; bytes: number };
type EndedAwareTrack = { onended?: (() => void) | null };

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function peerTransportConnected(peer: RTCPeerConnection): boolean {
  return peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed';
}

export class MediaSession {
  private state: MediaState = { type: 'idle' };
  private readonly listeners = new Set<() => void>();
  private peer: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteStreamURL: string | null = null;
  private peerSessionId: string | null = null;
  private role: 'requester' | 'sharer' | null = null;
  private pendingRemoteCandidates: RTCIceCandidate[] = [];
  private disconnectedTimer: Timer | null = null;
  private restartTimer: Timer | null = null;
  private statsTimer: Timer | null = null;
  private restartAttempt = 0;
  private bitrateParametersApplied = false;
  private remoteTrackSeen = false;
  private firstFrameSeen = false;
  private acceptedLocalCandidates = 0;
  private rejectedLocalCandidates = 0;
  private acceptedRemoteCandidates = 0;
  private rejectedRemoteCandidates = 0;
  private stats: MediaStatsSnapshot | null = null;
  private lastDiagnostic: MediaDiagnosticSnapshot | null = null;
  private previousSent: ByteSample | null = null;
  private previousReceived: ByteSample | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribeSession: () => void;
  private readonly unsubscribeMedia: () => void;

  constructor(
    private readonly session: MediaAuthority,
    private readonly diagnostics: MediaDiagnostics,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.unsubscribeSession = session.subscribe(() => void this.enqueue(() => this.syncSession()).catch(() => undefined));
    this.unsubscribeMedia = session.subscribeMedia((message) => void this.enqueue(() => this.handleSignal(message)).catch(() => undefined));
    void this.enqueue(() => this.syncSession()).catch(() => undefined);
  }

  getSnapshot = (): MediaState => this.state;
  getRemoteStreamURL = (): string | null => this.remoteStreamURL;
  getStatsSnapshot = (): MediaStatsSnapshot | null => this.stats;
  getDiagnosticSnapshot = (): MediaDiagnosticSnapshot => {
    const current = this.currentDiagnosticSnapshot();
    if (current.state === 'idle' && !this.peer && !this.localStream && !this.remoteStream && this.lastDiagnostic) {
      return this.lastDiagnostic;
    }
    return current;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async startSharing(): Promise<void> {
    return this.enqueue(async () => {
      const product = this.session.getSnapshot();
      if (product.type !== 'Connected' || product.role !== 'sharer') throw new Error('Screen sharing requires an accepted Chirp session.');
      const sessionId = product.sessionId;
      if (this.localStream && this.peerSessionId === sessionId) return;

      await this.resetMedia(false);
      this.lastDiagnostic = null;
      this.peerSessionId = sessionId;
      this.role = 'sharer';
      this.setState({ type: 'awaiting_permission', sessionId });
      await this.record('capture_consent_requested');

      let stream: MediaStream;
      const screen = Dimensions.get('screen');
      const pixelRatio = PixelRatio.get();
      const scale = captureResolutionScale(screen.width * pixelRatio, screen.height * pixelRatio);
      const consent = mediaDevices.getDisplayMedia({
        video: { frameRate: SCREEN_FPS },
        audio: false,
        android: { createConfigForDefaultDisplay: true, resolutionScale: scale },
      } as never);
      let consentTimer: Timer | null = null;
      let consentResult: { granted: true; stream: MediaStream } | { granted: false };
      try {
        consentResult = await Promise.race([
          consent.then((granted) => ({ granted: true as const, stream: granted })),
          new Promise<{ granted: false }>((resolve) => {
            consentTimer = setTimeout(() => resolve({ granted: false }), MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (consentTimer) clearTimeout(consentTimer);
      }
      if (!consentResult.granted) {
        // Bounded fail-closed: if Android grants after the app timeout, stop that orphaned projection.
        void consent.then((late) => late.getTracks().forEach((track) => track.stop())).catch(() => undefined);
        this.setState({ type: 'error', sessionId, message: 'Android screen sharing permission was not granted.' });
        await this.record('capture_consent_denied');
        await this.session.captureDenied(sessionId, 'system_denied');
        return;
      }
      stream = consentResult.stream;

      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        await this.fail(sessionId, 'Screen capture returned no video track.', 'capture_failed');
        return;
      }

      this.localStream = stream;
      (track as unknown as EndedAwareTrack).onended = () => {
        void this.enqueue(async () => {
          if (this.peerSessionId !== sessionId) return;
          await this.record('capture_revoked');
          await this.session.captureFailed(sessionId, 'capture_revoked');
          await this.resetMedia(false);
        }).catch(() => undefined);
      };
      await this.record('capture_started');

      const peer = this.createPeer(sessionId, 'sharer');
      const sender = peer.addTrack(track, stream);
      try {
        await this.configureSender(sender);
      } catch {
        // Sender bitrate/fps settings are a quality preference, never a session-lifetime decision.
        await this.record('media_bitrate_parameters_failed');
      }
      this.setState({ type: 'connecting', sessionId, role: 'sharer' });
      await this.record('media_negotiation_started');
      await this.sendOffer(sessionId, false);
      this.scheduleStats();
    });
  }

  async stop(): Promise<void> { return this.enqueue(() => this.resetMedia(true)); }
  async reconcile(): Promise<void> { return this.enqueue(() => this.syncSession()); }

  dispose(): void {
    this.unsubscribeSession();
    this.unsubscribeMedia();
    this.listeners.clear();
    void this.resetMedia(false);
  }

  private async syncSession(): Promise<void> {
    const product = this.session.getSnapshot();
    if (product.type !== 'Connected') {
      if (this.peer || this.localStream || this.remoteStream) await this.resetMedia(true);
      return;
    }
    if (product.role === 'requester') {
      if (this.peerSessionId !== product.sessionId || this.role !== 'requester') {
        await this.resetMedia(false);
        this.lastDiagnostic = null;
        this.peerSessionId = product.sessionId;
        this.role = 'requester';
        this.createPeer(product.sessionId, 'requester').addTransceiver('video', { direction: 'recvonly' });
        this.setState({ type: 'connecting', sessionId: product.sessionId, role: 'requester' });
        await this.record('media_negotiation_started');
        this.scheduleStats();
      }
      return;
    }
    if (this.peerSessionId && this.peerSessionId !== product.sessionId) await this.resetMedia(false);
  }

  private createPeer(sessionId: string, role: 'requester' | 'sharer'): RTCPeerConnection {
    if (this.peer && this.peerSessionId === sessionId && this.role === role) return this.peer;
    if (this.peer) this.closePeer();
    this.peerSessionId = sessionId;
    this.role = role;
    this.pendingRemoteCandidates = [];
    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peer = peer;

    peer.onicecandidate = (event: any) => {
      const candidate = event.candidate;
      if (!candidate?.candidate || this.peerSessionId !== sessionId) return;
      const decision = classifyIceCandidate(candidate.candidate);
      if (!decision.accepted) { this.rejectedLocalCandidates += 1; this.emit(); return; }
      this.acceptedLocalCandidates += 1;
      this.emit();
      void this.session.sendMedia(sessionId, 'ICE_CANDIDATE', {
        sdpMid: candidate.sdpMid ?? '0', sdpMLineIndex: candidate.sdpMLineIndex ?? 0, candidate: candidate.candidate,
      }).catch(() => undefined);
    };

    peer.ontrack = (event: any) => {
      if (role !== 'requester' || this.peerSessionId !== sessionId || event.track.kind !== 'video') return;
      const stream = event.streams?.[0] as MediaStream | undefined;
      if (!stream) {
        // Chirp always sends addTrack(track, stream). Do not synthesize a MediaStream around a remote
        // track: react-native-webrtc has a confirmed Android New Architecture race in that path.
        void this.enqueue(() => this.fail(sessionId, 'WebRTC delivered a video track without its negotiated stream.', 'media_failed')).catch(() => undefined);
        return;
      }
      this.remoteStream = stream;
      this.remoteStreamURL = stream.toURL();
      if (!this.remoteTrackSeen) void this.record('media_remote_track');
      this.remoteTrackSeen = true;
      this.emit();
    };

    peer.oniceconnectionstatechange = () => this.handlePeerTransportState(peer, sessionId, role);
    peer.onconnectionstatechange = () => this.handlePeerTransportState(peer, sessionId, role);
    peer.onicegatheringstatechange = () => { if (this.peer === peer) this.emit(); };
    peer.onsignalingstatechange = () => { if (this.peer === peer) this.emit(); };
    return peer;
  }

  private handlePeerTransportState(peer: RTCPeerConnection, sessionId: string, role: 'requester' | 'sharer'): void {
    if (this.peer !== peer || this.peerSessionId !== sessionId) return;
    const iceState = peer.iceConnectionState;
    const connectionState = peer.connectionState;

    if (peerTransportConnected(peer) && connectionState !== 'failed') {
      this.clearDisconnectedTimer();
      const recovered = this.restartAttempt > 0;
      this.restartAttempt = 0;
      if (role === 'requester' && !this.firstFrameSeen) this.setState({ type: 'connecting', sessionId, role });
      else this.setState({ type: 'live', sessionId, role });
      if (recovered) void this.record('media_reconnected');
      return;
    }

    if (iceState === 'failed' || connectionState === 'failed') {
      this.clearDisconnectedTimer();
      this.emit();
      void this.enqueue(() => this.scheduleRecovery(sessionId)).catch(() => undefined);
      return;
    }

    if (iceState === 'disconnected' || connectionState === 'disconnected') {
      if (!this.disconnectedTimer) {
        void this.record('media_degraded');
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          void this.enqueue(() => this.scheduleRecovery(sessionId)).catch(() => undefined);
        }, MEDIA_DISCONNECTED_GRACE_MS);
      }
      this.emit();
      return;
    }

    this.emit();
  }

  private async configureSender(sender: ReturnType<RTCPeerConnection['addTrack']>): Promise<void> {
    const parameters = sender.getParameters() as any;
    const patch = senderBitrateParameters(parameters?.encodings as ReadonlyArray<Record<string, unknown>> | undefined);
    if (!patch.applicable) return;
    parameters.encodings = patch.encodings;
    parameters.degradationPreference = patch.degradationPreference;
    await sender.setParameters(parameters as never);
    this.bitrateParametersApplied = true;
    this.emit();
  }

  private async sendOffer(sessionId: string, iceRestart: boolean): Promise<void> {
    const peer = this.requirePeer(sessionId);
    const offer = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peer.setLocalDescription(offer);
    if (!offer.sdp) throw new Error('WebRTC created an empty offer.');
    await this.session.sendMedia(sessionId, 'SDP_OFFER', { sdp: offer.sdp });
  }

  private async handleSignal(message: AnyMediaControlMessage): Promise<void> {
    const product = this.session.getSnapshot();
    if (product.type !== 'Connected' || product.sessionId !== message.sessionId) return;
    const sessionId = product.sessionId;
    try {
      if (message.type === 'MEDIA_RESTART_REQUEST') { if (product.role === 'sharer') await this.restartAsSharer(sessionId); return; }
      if (message.type === 'ICE_CANDIDATE') {
        const decision = classifyIceCandidate(message.payload.candidate);
        if (!decision.accepted) { this.rejectedRemoteCandidates += 1; this.emit(); return; }
        this.acceptedRemoteCandidates += 1;
        const candidate = new RTCIceCandidate(message.payload);
        const peer = this.requirePeer(sessionId);
        if (!peer.remoteDescription) this.pendingRemoteCandidates.push(candidate); else await peer.addIceCandidate(candidate);
        this.emit();
        return;
      }
      if (message.type === 'SDP_OFFER') {
        if (product.role !== 'requester') throw new Error('Only requester accepts a media offer.');
        const peer = this.peerSessionId === sessionId && this.role === 'requester' ? this.requirePeer(sessionId) : this.createPeer(sessionId, 'requester');
        if (peer.getTransceivers().length === 0) peer.addTransceiver('video', { direction: 'recvonly' });
        await peer.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: message.payload.sdp }));
        await this.flushRemoteCandidates(peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (!answer.sdp) throw new Error('WebRTC created an empty answer.');
        await this.session.sendMedia(sessionId, 'SDP_ANSWER', { sdp: answer.sdp });
        return;
      }
      if (message.type === 'SDP_ANSWER') {
        if (product.role !== 'sharer') throw new Error('Only sharer accepts a media answer.');
        const peer = this.requirePeer(sessionId);
        await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: message.payload.sdp }));
        await this.flushRemoteCandidates(peer);
      }
    } catch {
      await this.scheduleRecovery(sessionId);
    }
  }

  private async flushRemoteCandidates(peer: RTCPeerConnection): Promise<void> {
    const pending = this.pendingRemoteCandidates.splice(0);
    for (const candidate of pending) await peer.addIceCandidate(candidate);
  }

  private async scheduleRecovery(sessionId: string): Promise<void> {
    const product = this.session.getSnapshot();
    if (product.type !== 'Connected' || product.sessionId !== sessionId || this.restartTimer) return;
    if (this.restartAttempt >= MEDIA_RESTART_DELAYS_MS.length) { await this.fail(sessionId, 'The Wi-Fi video connection could not recover.', 'media_failed'); return; }
    const attempt = this.restartAttempt + 1;
    const delay = MEDIA_RESTART_DELAYS_MS[this.restartAttempt];
    this.restartAttempt = attempt;
    this.setState({ type: 'recovering', sessionId, role: product.role, attempt });
    await this.record('media_reconnect_attempt');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.enqueue(async () => {
        const current = this.session.getSnapshot();
        if (current.type !== 'Connected' || current.sessionId !== sessionId) return;
        try {
          if (current.role === 'sharer') await this.restartAsSharer(sessionId);
          else await this.session.sendMedia(sessionId, 'MEDIA_RESTART_REQUEST', { reason: 'connection_lost' });
        } catch {
          if (this.restartAttempt === attempt) this.restartAttempt = attempt - 1;
          if (this.peerSessionId !== sessionId || this.restartTimer) return;
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.enqueue(() => this.scheduleRecovery(sessionId)).catch(() => undefined);
          }, MEDIA_SIGNAL_RETRY_MS);
        }
      }).catch(() => undefined);
    }, delay);
  }

  private async restartAsSharer(sessionId: string): Promise<void> {
    if (!this.peer || !this.localStream) throw new Error('No active publisher to restart.');
    await this.sendOffer(sessionId, true);
  }

  private scheduleStats(): void {
    if (this.statsTimer) return;
    const poll = async () => {
      this.statsTimer = null;
      await this.collectStats().catch(() => undefined);
      if (this.peer) this.statsTimer = setTimeout(() => void poll(), MEDIA_STATS_INTERVAL_MS);
    };
    this.statsTimer = setTimeout(() => void poll(), MEDIA_STATS_INTERVAL_MS);
  }

  private async collectStats(): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    const report = await peer.getStats();
    const now = this.nowMs();
    const next: MediaStatsSnapshot = { atMs: now };
    let sentBytes: number | undefined;
    let receivedBytes: number | undefined;
    report.forEach((item: any) => {
      if (item.type === 'codec' && typeof item.mimeType === 'string' && item.mimeType.toLowerCase().startsWith('video/')) next.codecMimeType ??= item.mimeType;
      if (item.type === 'outbound-rtp' && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote) {
        sentBytes = numeric(item.bytesSent);
        next.framesPerSecond = numeric(item.framesPerSecond) ?? next.framesPerSecond;
        next.frameWidth = numeric(item.frameWidth) ?? next.frameWidth;
        next.frameHeight = numeric(item.frameHeight) ?? next.frameHeight;
        next.framesEncoded = numeric(item.framesEncoded);
        next.keyFramesEncoded = numeric(item.keyFramesEncoded);
        next.nackCount = numeric(item.nackCount);
        next.pliCount = numeric(item.pliCount);
        next.firCount = numeric(item.firCount);
        next.encoderImplementation = text(item.encoderImplementation);
        next.qualityLimitationReason = text(item.qualityLimitationReason);
      }
      if (item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote) {
        receivedBytes = numeric(item.bytesReceived);
        next.framesPerSecond = numeric(item.framesPerSecond) ?? next.framesPerSecond;
        next.frameWidth = numeric(item.frameWidth) ?? next.frameWidth;
        next.frameHeight = numeric(item.frameHeight) ?? next.frameHeight;
        next.framesDecoded = numeric(item.framesDecoded);
        next.framesDropped = numeric(item.framesDropped);
        next.keyFramesDecoded = numeric(item.keyFramesDecoded);
        next.nackCount = numeric(item.nackCount) ?? next.nackCount;
        next.pliCount = numeric(item.pliCount) ?? next.pliCount;
        next.firCount = numeric(item.firCount) ?? next.firCount;
        next.decoderImplementation = text(item.decoderImplementation);
        next.packetsLost = numeric(item.packetsLost);
        const jitter = numeric(item.jitter); if (jitter !== undefined) next.jitterMs = jitter * 1_000;
      }
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || item.selected)) {
        next.candidatePairState = text(item.state);
        const rtt = numeric(item.currentRoundTripTime); if (rtt !== undefined) next.roundTripTimeMs = rtt * 1_000;
      }
      if (item.type === 'remote-inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video')) {
        const rtt = numeric(item.roundTripTime); if (rtt !== undefined) next.roundTripTimeMs = rtt * 1_000;
      }
    });
    if (sentBytes !== undefined) {
      if (this.previousSent && now > this.previousSent.atMs && sentBytes >= this.previousSent.bytes) next.sendBitrateBps = ((sentBytes - this.previousSent.bytes) * 8_000) / (now - this.previousSent.atMs);
      this.previousSent = { atMs: now, bytes: sentBytes };
    }
    if (receivedBytes !== undefined) {
      if (this.previousReceived && now > this.previousReceived.atMs && receivedBytes >= this.previousReceived.bytes) next.receiveBitrateBps = ((receivedBytes - this.previousReceived.bytes) * 8_000) / (now - this.previousReceived.atMs);
      this.previousReceived = { atMs: now, bytes: receivedBytes };
    }
    this.stats = next;
    if (!this.firstFrameSeen && this.role === 'requester' && (next.framesDecoded ?? 0) > 0) {
      this.firstFrameSeen = true;
      if (this.peerSessionId && peerTransportConnected(peer)) {
        this.setState({ type: 'live', sessionId: this.peerSessionId, role: 'requester' });
      }
      await this.record('media_first_frame');
    }
    await this.record('media_stats');
    this.emit();
  }

  private async fail(sessionId: string, message: string, reason: 'capture_failed' | 'media_failed'): Promise<void> {
    this.setState({ type: 'error', sessionId, message });
    await this.record(reason === 'capture_failed' ? 'capture_failed' : 'media_failed');
    if (reason === 'capture_failed') await this.session.captureFailed(sessionId, 'capture_failed'); else await this.session.mediaFailed(sessionId);
    await this.resetMedia(false);
  }

  private async resetMedia(recordCaptureStop: boolean): Promise<void> {
    if (this.state.type !== 'idle' || this.peer || this.localStream || this.remoteStream) {
      this.lastDiagnostic = this.currentDiagnosticSnapshot();
    }
    this.clearDisconnectedTimer();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.restartTimer = null;
    this.statsTimer = null;
    const hadCapture = Boolean(this.localStream);
    const localTracks = this.localStream?.getTracks() ?? [];
    for (const track of localTracks) {
      (track as unknown as EndedAwareTrack).onended = null;
      track.stop();
    }
    this.localStream = null;
    // Closing the PeerConnection owns remote-track teardown. Avoid manually stopping remote tracks;
    // react-native-webrtc maps remote track state back through the peer connection.
    this.remoteStream = null;
    this.remoteStreamURL = null;
    this.closePeer();
    this.peerSessionId = null;
    this.role = null;
    this.pendingRemoteCandidates = [];
    this.restartAttempt = 0;
    this.bitrateParametersApplied = false;
    this.remoteTrackSeen = false;
    this.firstFrameSeen = false;
    this.acceptedLocalCandidates = 0;
    this.rejectedLocalCandidates = 0;
    this.acceptedRemoteCandidates = 0;
    this.rejectedRemoteCandidates = 0;
    this.stats = null;
    this.previousSent = null;
    this.previousReceived = null;
    this.setState({ type: 'idle' });
    if (recordCaptureStop && hadCapture) await this.record('capture_stopped');
  }

  private currentDiagnosticSnapshot(): MediaDiagnosticSnapshot {
    return {
      state: this.state.type,
      role: this.role ?? undefined,
      connectionState: this.peer?.connectionState,
      iceConnectionState: this.peer?.iceConnectionState,
      iceGatheringState: this.peer?.iceGatheringState,
      signalingState: this.peer?.signalingState,
      remoteTrackSeen: this.remoteTrackSeen,
      firstFrameSeen: this.firstFrameSeen,
      acceptedLocalCandidates: this.acceptedLocalCandidates,
      rejectedLocalCandidates: this.rejectedLocalCandidates,
      acceptedRemoteCandidates: this.acceptedRemoteCandidates,
      rejectedRemoteCandidates: this.rejectedRemoteCandidates,
      restartAttempts: this.restartAttempt,
      bitrateParametersApplied: this.bitrateParametersApplied,
      stats: this.stats ? { ...this.stats } : null,
    };
  }

  private closePeer(): void {
    const peer = this.peer;
    this.peer = null;
    if (!peer) return;
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.oniceconnectionstatechange = null;
    peer.onconnectionstatechange = null;
    peer.onicegatheringstatechange = null;
    peer.onsignalingstatechange = null;
    try { peer.close(); } catch { /* already closed */ }
  }
  private requirePeer(sessionId: string): RTCPeerConnection { if (!this.peer || this.peerSessionId !== sessionId) throw new Error('No WebRTC peer for active session.'); return this.peer; }
  private clearDisconnectedTimer(): void { if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer); this.disconnectedTimer = null; }
  private record(kind: DiagnosticEventKind): Promise<void> { return this.diagnostics.append(kind).catch(() => undefined); }
  private setState(next: MediaState): void { this.state = next; this.emit(); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
}
