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
  MEDIA_DISCONNECTED_GRACE_MS,
  MEDIA_RESTART_DELAYS_MS,
  MEDIA_STATS_INTERVAL_MS,
  SCREEN_FPS,
  SCREEN_MAX_BITRATE_BPS,
  SCREEN_MIN_BITRATE_BPS,
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
  sendBitrateBps?: number;
  receiveBitrateBps?: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesEncoded?: number;
  framesDecoded?: number;
  framesDropped?: number;
  packetsLost?: number;
  jitterMs?: number;
  roundTripTimeMs?: number;
  qualityLimitationReason?: string;
}

export interface MediaDiagnosticSnapshot {
  state: MediaState['type'];
  role?: 'requester' | 'sharer';
  remoteTrackSeen: boolean;
  firstFrameSeen: boolean;
  acceptedLocalCandidates: number;
  rejectedLocalCandidates: number;
  acceptedRemoteCandidates: number;
  rejectedRemoteCandidates: number;
  restartAttempts: number;
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

interface MediaDiagnostics {
  append(kind: DiagnosticEventKind): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;

type ByteSample = { atMs: number; bytes: number };

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  private remoteTrackSeen = false;
  private firstFrameSeen = false;
  private acceptedLocalCandidates = 0;
  private rejectedLocalCandidates = 0;
  private acceptedRemoteCandidates = 0;
  private rejectedRemoteCandidates = 0;
  private stats: MediaStatsSnapshot | null = null;
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
    this.unsubscribeSession = session.subscribe(() => {
      void this.enqueue(() => this.syncSession()).catch(() => undefined);
    });
    this.unsubscribeMedia = session.subscribeMedia((message) => {
      void this.enqueue(() => this.handleSignal(message)).catch(() => undefined);
    });
    void this.enqueue(() => this.syncSession()).catch(() => undefined);
  }

  getSnapshot = (): MediaState => this.state;
  getRemoteStreamURL = (): string | null => this.remoteStreamURL;
  getStatsSnapshot = (): MediaStatsSnapshot | null => this.stats;
  getDiagnosticSnapshot = (): MediaDiagnosticSnapshot => ({
    state: this.state.type,
    role: this.role ?? undefined,
    remoteTrackSeen: this.remoteTrackSeen,
    firstFrameSeen: this.firstFrameSeen,
    acceptedLocalCandidates: this.acceptedLocalCandidates,
    rejectedLocalCandidates: this.rejectedLocalCandidates,
    acceptedRemoteCandidates: this.acceptedRemoteCandidates,
    rejectedRemoteCandidates: this.rejectedRemoteCandidates,
    restartAttempts: this.restartAttempt,
    stats: this.stats,
  });
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async startSharing(): Promise<void> {
    return this.enqueue(async () => {
      const product = this.session.getSnapshot();
      if (product.type !== 'Connected' || product.role !== 'sharer') {
        throw new Error('Screen sharing requires an accepted Chirp session.');
      }
      const sessionId = product.sessionId;
      if (this.localStream && this.peerSessionId === sessionId) return;

      await this.resetMedia(false);
      this.peerSessionId = sessionId;
      this.role = 'sharer';
      this.setState({ type: 'awaiting_permission', sessionId });
      await this.record('capture_consent_requested');

      let stream: MediaStream;
      try {
        const screen = Dimensions.get('screen');
        const pixelRatio = PixelRatio.get();
        const scale = captureResolutionScale(screen.width * pixelRatio, screen.height * pixelRatio);
        stream = await mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
          android: { createConfigForDefaultDisplay: true, resolutionScale: scale },
        } as never);
      } catch (error) {
        this.setState({ type: 'error', sessionId, message: 'Android screen sharing permission was not granted.' });
        await this.record('capture_consent_denied');
        await this.session.captureDenied(sessionId, 'system_denied');
        return;
      }

      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        await this.fail(sessionId, 'Screen capture returned no video track.', 'capture_failed');
        return;
      }

      this.localStream = stream;
      (track as unknown as { onended?: () => void }).onended = () => {
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
      await this.configureSender(sender);
      this.setState({ type: 'connecting', sessionId, role: 'sharer' });
      await this.record('media_negotiation_started');
      await this.sendOffer(sessionId, false);
      this.scheduleStats();
    });
  }

  async stop(): Promise<void> {
    return this.enqueue(() => this.resetMedia(true));
  }

  async reconcile(): Promise<void> {
    return this.enqueue(() => this.syncSession());
  }

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

    peer.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate?.candidate || this.peerSessionId !== sessionId) return;
      const decision = classifyIceCandidate(candidate.candidate);
      if (!decision.accepted) {
        this.rejectedLocalCandidates += 1;
        this.emit();
        return;
      }
      this.acceptedLocalCandidates += 1;
      this.emit();
      void this.session.sendMedia(sessionId, 'ICE_CANDIDATE', {
        sdpMid: candidate.sdpMid ?? '0',
        sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
        candidate: candidate.candidate,
      }).catch(() => this.scheduleRecovery(sessionId));
    };

    peer.ontrack = (event) => {
      if (role !== 'requester' || this.peerSessionId !== sessionId || event.track.kind !== 'video') return;
      const stream = event.streams?.[0] ?? new MediaStream([event.track]);
      this.remoteStream = stream;
      this.remoteStreamURL = stream.toURL();
      if (!this.remoteTrackSeen) void this.record('media_remote_track');
      this.remoteTrackSeen = true;
      this.emit();
    };

    peer.onconnectionstatechange = () => {
      if (this.peer !== peer || this.peerSessionId !== sessionId) return;
      const state = peer.connectionState;
      if (state === 'connected') {
        this.clearDisconnectedTimer();
        const recovered = this.restartAttempt > 0;
        this.restartAttempt = 0;
        this.setState({ type: 'live', sessionId, role });
        if (recovered) void this.record('media_reconnected');
        return;
      }
      if (state === 'disconnected') {
        if (!this.disconnectedTimer) {
          void this.record('media_degraded');
          this.disconnectedTimer = setTimeout(() => {
            this.disconnectedTimer = null;
            void this.enqueue(() => this.scheduleRecovery(sessionId)).catch(() => undefined);
          }, MEDIA_DISCONNECTED_GRACE_MS);
        }
        return;
      }
      if (state === 'failed') {
        this.clearDisconnectedTimer();
        void this.enqueue(() => this.scheduleRecovery(sessionId)).catch(() => undefined);
      }
    };

    return peer;
  }

  private async configureSender(sender: ReturnType<RTCPeerConnection['addTrack']>): Promise<void> {
    const parameters = sender.getParameters() as any;
    if (!Array.isArray(parameters.encodings) || parameters.encodings.length === 0) parameters.encodings = [{}];
    for (const encoding of parameters.encodings) {
      encoding.minBitrate = SCREEN_MIN_BITRATE_BPS;
      encoding.maxBitrate = SCREEN_MAX_BITRATE_BPS;
      encoding.maxFramerate = SCREEN_FPS;
      encoding.scaleResolutionDownBy = 1;
      encoding.active = true;
    }
    parameters.degradationPreference = 'maintain-resolution';
    await sender.setParameters(parameters);
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
      if (message.type === 'MEDIA_RESTART_REQUEST') {
        if (product.role === 'sharer') await this.restartAsSharer(sessionId);
        return;
      }

      if (message.type === 'ICE_CANDIDATE') {
        const decision = classifyIceCandidate(message.payload.candidate);
        if (!decision.accepted) {
          this.rejectedRemoteCandidates += 1;
          this.emit();
          return;
        }
        this.acceptedRemoteCandidates += 1;
        const candidate = new RTCIceCandidate(message.payload);
        const peer = this.requirePeer(sessionId);
        if (!peer.remoteDescription) this.pendingRemoteCandidates.push(candidate);
        else await peer.addIceCandidate(candidate);
        this.emit();
        return;
      }

      if (message.type === 'SDP_OFFER') {
        if (product.role !== 'requester') throw new Error('Only requester accepts a media offer.');
        const peer = this.peerSessionId === sessionId && this.role === 'requester'
          ? this.requirePeer(sessionId)
          : this.createPeer(sessionId, 'requester');
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
    if (this.restartAttempt >= MEDIA_RESTART_DELAYS_MS.length) {
      await this.fail(sessionId, 'The Wi-Fi video connection could not recover.', 'media_failed');
      return;
    }

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
          await this.scheduleRecovery(sessionId);
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
      if (item.type === 'outbound-rtp' && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote) {
        sentBytes = numeric(item.bytesSent);
        next.framesPerSecond = numeric(item.framesPerSecond) ?? next.framesPerSecond;
        next.frameWidth = numeric(item.frameWidth) ?? next.frameWidth;
        next.frameHeight = numeric(item.frameHeight) ?? next.frameHeight;
        next.framesEncoded = numeric(item.framesEncoded);
        next.qualityLimitationReason = typeof item.qualityLimitationReason === 'string' ? item.qualityLimitationReason : undefined;
      }
      if (item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote) {
        receivedBytes = numeric(item.bytesReceived);
        next.framesPerSecond = numeric(item.framesPerSecond) ?? next.framesPerSecond;
        next.frameWidth = numeric(item.frameWidth) ?? next.frameWidth;
        next.frameHeight = numeric(item.frameHeight) ?? next.frameHeight;
        next.framesDecoded = numeric(item.framesDecoded);
        next.framesDropped = numeric(item.framesDropped);
        next.packetsLost = numeric(item.packetsLost);
        const jitter = numeric(item.jitter);
        if (jitter !== undefined) next.jitterMs = jitter * 1_000;
      }
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || item.selected)) {
        const rtt = numeric(item.currentRoundTripTime);
        if (rtt !== undefined) next.roundTripTimeMs = rtt * 1_000;
      }
      if (item.type === 'remote-inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video')) {
        const rtt = numeric(item.roundTripTime);
        if (rtt !== undefined) next.roundTripTimeMs = rtt * 1_000;
      }
    });

    if (sentBytes !== undefined) {
      if (this.previousSent && now > this.previousSent.atMs && sentBytes >= this.previousSent.bytes) {
        next.sendBitrateBps = ((sentBytes - this.previousSent.bytes) * 8_000) / (now - this.previousSent.atMs);
      }
      this.previousSent = { atMs: now, bytes: sentBytes };
    }
    if (receivedBytes !== undefined) {
      if (this.previousReceived && now > this.previousReceived.atMs && receivedBytes >= this.previousReceived.bytes) {
        next.receiveBitrateBps = ((receivedBytes - this.previousReceived.bytes) * 8_000) / (now - this.previousReceived.atMs);
      }
      this.previousReceived = { atMs: now, bytes: receivedBytes };
    }

    this.stats = next;
    if (!this.firstFrameSeen && this.role === 'requester' && (next.framesDecoded ?? 0) > 0) {
      this.firstFrameSeen = true;
      await this.record('media_first_frame');
    }
    await this.record('media_stats');
    this.emit();
  }

  private async fail(sessionId: string, message: string, reason: 'capture_failed' | 'media_failed'): Promise<void> {
    this.setState({ type: 'error', sessionId, message });
    await this.record(reason === 'capture_failed' ? 'capture_failed' : 'media_failed');
    if (reason === 'capture_failed') await this.session.captureFailed(sessionId, 'capture_failed');
    else await this.session.mediaFailed(sessionId);
    await this.resetMedia(false);
  }

  private async resetMedia(recordCaptureStop: boolean): Promise<void> {
    this.clearDisconnectedTimer();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.restartTimer = null;
    this.statsTimer = null;
    const hadCapture = Boolean(this.localStream);
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.remoteStream?.getTracks().forEach((track) => track.stop());
    this.remoteStream = null;
    this.remoteStreamURL = null;
    this.closePeer();
    this.peerSessionId = null;
    this.role = null;
    this.pendingRemoteCandidates = [];
    this.restartAttempt = 0;
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

  private closePeer(): void {
    const peer = this.peer;
    this.peer = null;
    if (!peer) return;
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    try { peer.close(); } catch { /* already closed */ }
  }

  private requirePeer(sessionId: string): RTCPeerConnection {
    if (!this.peer || this.peerSessionId !== sessionId) throw new Error('No WebRTC peer for active session.');
    return this.peer;
  }

  private clearDisconnectedTimer(): void {
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
  }

  private record(kind: DiagnosticEventKind): Promise<void> {
    return this.diagnostics.append(kind).catch(() => undefined);
  }

  private setState(next: MediaState): void {
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
