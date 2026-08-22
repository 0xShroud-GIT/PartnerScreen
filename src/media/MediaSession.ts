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
import { peerTransportDisposition, settlePromiseWithTimeout } from './MediaRuntimePolicy';

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
  lastFailureReason?: string | undefined;
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

type PeerTransportSnapshot = {
  connectionState?: string;
  iceConnectionState?: string;
  iceGatheringState?: string;
  signalingState?: string;
};

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function snapshotPeerTransport(peer: RTCPeerConnection | null): PeerTransportSnapshot {
  if (!peer) return {};
  return {
    connectionState: (peer as any).connectionState,
    iceConnectionState: (peer as any).iceConnectionState,
    iceGatheringState: (peer as any).iceGatheringState,
    signalingState: (peer as any).signalingState,
  };
}

function failureText(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name || 'Error'}: ${error.message}`
    : typeof error === 'string' ? error : 'unknown error';
  return raw
    .replace(/candidate:[^\n\r]*/gi, '<redacted-candidate>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<redacted-ipv4>')
    .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]+\b/gi, '<redacted-ipv6>')
    .slice(0, 280);
}

function cloneDiagnostic(snapshot: MediaDiagnosticSnapshot): MediaDiagnosticSnapshot {
  return { ...snapshot, stats: snapshot.stats ? { ...snapshot.stats } : null };
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
  private lastFailureReason: string | undefined;
  private archivedDiagnostic: MediaDiagnosticSnapshot | null = null;
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
    if (!this.hasActiveMediaSession() && this.archivedDiagnostic) return cloneDiagnostic(this.archivedDiagnostic);
    return this.currentDiagnosticSnapshot();
  };

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
      this.beginDiagnosticSession();
      this.peerSessionId = sessionId;
      this.role = 'sharer';
      this.setState({ type: 'awaiting_permission', sessionId });
      await this.record('capture_consent_requested');

      const screen = Dimensions.get('screen');
      const pixelRatio = PixelRatio.get();
      const scale = captureResolutionScale(screen.width * pixelRatio, screen.height * pixelRatio);

      let consent: Promise<MediaStream>;
      try {
        consent = mediaDevices.getDisplayMedia({
          video: { frameRate: SCREEN_FPS },
          audio: false,
          android: { createConfigForDefaultDisplay: true, resolutionScale: scale },
        } as never) as Promise<MediaStream>;
      } catch (error) {
        await this.denyCapture(sessionId, `getDisplayMedia threw: ${failureText(error)}`);
        return;
      }

      const consentResult = await settlePromiseWithTimeout(consent, MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS);
      if (consentResult.status === 'timeout') {
        void consent.then(
          (late) => this.disposeOwnedLocalStream(late),
          () => undefined,
        );
        await this.denyCapture(sessionId, 'getDisplayMedia timed out waiting for Android consent');
        return;
      }
      if (consentResult.status === 'rejected') {
        await this.denyCapture(sessionId, `getDisplayMedia rejected: ${failureText(consentResult.error)}`);
        return;
      }

      const stream = consentResult.value;
      const currentProduct = this.session.getSnapshot();
      if (
        currentProduct.type !== 'Connected'
        || currentProduct.role !== 'sharer'
        || currentProduct.sessionId !== sessionId
      ) {
        this.disposeOwnedLocalStream(stream);
        if (this.peerSessionId === sessionId) await this.resetMedia(false);
        return;
      }

      const track = stream.getVideoTracks()[0];
      if (!track) {
        this.disposeOwnedLocalStream(stream);
        await this.fail(sessionId, 'Screen capture returned no video track.', 'capture_failed');
        return;
      }

      this.localStream = stream;
      (track as unknown as EndedAwareTrack).onended = () => {
        void this.enqueue(async () => {
          if (this.peerSessionId !== sessionId) return;
          this.lastFailureReason = 'MediaProjection capture ended';
          this.setState({ type: 'error', sessionId, message: 'Android stopped screen sharing.' });
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
      if (this.hasActiveMediaSession()) await this.resetMedia(true);
      return;
    }

    if (product.role === 'requester') {
      if (this.peerSessionId !== product.sessionId || this.role !== 'requester') {
        await this.resetMedia(false);
        this.beginDiagnosticSession();
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
      }).catch((error) => {
        if (this.peerSessionId !== sessionId) return;
        this.noteFailure('send ICE_CANDIDATE', error);
      });
    };

    peer.ontrack = (event: any) => {
      if (role !== 'requester' || this.peerSessionId !== sessionId || event.track.kind !== 'video') return;
      const stream = event.streams?.[0] as MediaStream | undefined;
      if (!stream) {
        this.lastFailureReason = 'ontrack missing negotiated stream';
        void this.enqueue(async () => {
          if (this.peerSessionId !== sessionId) return;
          await this.fail(sessionId, 'WebRTC delivered a video track without its negotiated stream.', 'media_failed');
        }).catch(() => undefined);
        return;
      }
      this.remoteStream = stream;
      this.remoteStreamURL = stream.toURL();
      if (!this.remoteTrackSeen) void this.record('media_remote_track');
      this.remoteTrackSeen = true;
      this.emit();
    };

    const handleTransport = () => this.handlePeerTransportState(peer, sessionId, role);
    peer.onconnectionstatechange = handleTransport;
    (peer as any).oniceconnectionstatechange = handleTransport;
    (peer as any).onicegatheringstatechange = () => { if (this.peer === peer) this.emit(); };
    (peer as any).onsignalingstatechange = () => { if (this.peer === peer) this.emit(); };

    return peer;
  }

  private handlePeerTransportState(
    peer: RTCPeerConnection,
    sessionId: string,
    role: 'requester' | 'sharer',
  ): void {
    if (this.peer !== peer || this.peerSessionId !== sessionId) return;
    const connectionState = (peer as any).connectionState as string | undefined;
    const iceConnectionState = (peer as any).iceConnectionState as string | undefined;
    const disposition = peerTransportDisposition(connectionState, iceConnectionState);

    if (disposition === 'failed') {
      this.clearDisconnectedTimer();
      this.emit();
      void this.enqueue(() => this.scheduleRecovery(sessionId, 'peer transport failed')).catch(() => undefined);
      return;
    }

    if (disposition === 'disconnected') {
      if (!this.disconnectedTimer) {
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          void this.enqueue(async () => {
            if (this.peer !== peer || this.peerSessionId !== sessionId) return;
            const currentDisposition = peerTransportDisposition(
              (peer as any).connectionState as string | undefined,
              (peer as any).iceConnectionState as string | undefined,
            );
            if (currentDisposition !== 'disconnected') return;
            await this.record('media_degraded');
            await this.scheduleRecovery(sessionId, 'peer transport disconnected');
          }).catch(() => undefined);
        }, MEDIA_DISCONNECTED_GRACE_MS);
      }
      this.emit();
      return;
    }

    if (disposition === 'connected') {
      this.clearDisconnectedTimer();
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = null;
      const recovered = this.restartAttempt > 0;
      this.restartAttempt = 0;
      if (role === 'requester' && !this.firstFrameSeen) {
        this.setState({ type: 'connecting', sessionId, role });
      } else {
        this.setState({ type: 'live', sessionId, role });
      }
      if (recovered) void this.record('media_reconnected');
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
    const offer = await this.rtcOperation('createOffer', () => peer.createOffer(iceRestart ? { iceRestart: true } : undefined));
    await this.rtcOperation('setLocalDescription(offer)', () => peer.setLocalDescription(offer));
    if (!offer.sdp) {
      this.noteFailure('createOffer', new Error('empty SDP'));
      throw new Error('WebRTC created an empty offer.');
    }
    await this.rtcOperation('send SDP_OFFER', () => this.session.sendMedia(sessionId, 'SDP_OFFER', { sdp: offer.sdp! }));
  }

  private async handleSignal(message: AnyMediaControlMessage): Promise<void> {
    const product = this.session.getSnapshot();
    if (product.type !== 'Connected' || product.sessionId !== message.sessionId) return;
    const sessionId = product.sessionId;

    if (message.type === 'MEDIA_KEYFRAME_REQUEST') return;

    if (message.type === 'MEDIA_RESTART_REQUEST') {
      if (product.role === 'sharer') {
        try {
          await this.restartAsSharer(sessionId);
        } catch {
          await this.scheduleRecovery(sessionId, 'restart request failed');
        }
      }
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
      try {
        const candidate = new RTCIceCandidate(message.payload);
        const peer = this.requirePeer(sessionId);
        if (!peer.remoteDescription) this.pendingRemoteCandidates.push(candidate);
        else await this.rtcOperation('addIceCandidate', () => peer.addIceCandidate(candidate));
      } catch (error) {
        if (!this.lastFailureReason) this.noteFailure('construct/add ICE candidate', error);
      }
      this.emit();
      return;
    }

    if (message.type === 'SDP_OFFER') {
      if (product.role !== 'requester') {
        this.lastFailureReason = 'SDP_OFFER received by non-requester';
        await this.scheduleRecovery(sessionId, 'SDP offer wrong role');
        return;
      }
      try {
        const peer = this.peerSessionId === sessionId && this.role === 'requester'
          ? this.requirePeer(sessionId)
          : this.createPeer(sessionId, 'requester');
        if (peer.getTransceivers().length === 0) peer.addTransceiver('video', { direction: 'recvonly' });
        await this.rtcOperation('setRemoteDescription(offer)', () => peer.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: message.payload.sdp })));
        await this.flushRemoteCandidates(peer);
        const answer = await this.rtcOperation('createAnswer', () => peer.createAnswer());
        await this.rtcOperation('setLocalDescription(answer)', () => peer.setLocalDescription(answer));
        if (!answer.sdp) {
          this.noteFailure('createAnswer', new Error('empty SDP'));
          throw new Error('WebRTC created an empty answer.');
        }
        await this.rtcOperation('send SDP_ANSWER', () => this.session.sendMedia(sessionId, 'SDP_ANSWER', { sdp: answer.sdp! }));
      } catch {
        await this.scheduleRecovery(sessionId, 'SDP offer handling failed');
      }
      return;
    }

    if (message.type === 'SDP_ANSWER') {
      if (product.role !== 'sharer') {
        this.lastFailureReason = 'SDP_ANSWER received by non-sharer';
        await this.scheduleRecovery(sessionId, 'SDP answer wrong role');
        return;
      }
      try {
        const peer = this.requirePeer(sessionId);
        await this.rtcOperation('setRemoteDescription(answer)', () => peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: message.payload.sdp })));
        await this.flushRemoteCandidates(peer);
      } catch {
        await this.scheduleRecovery(sessionId, 'SDP answer handling failed');
      }
    }
  }

  private async flushRemoteCandidates(peer: RTCPeerConnection): Promise<void> {
    const pending = this.pendingRemoteCandidates.splice(0);
    for (const candidate of pending) {
      try {
        await this.rtcOperation('flush addIceCandidate', () => peer.addIceCandidate(candidate));
      } catch {
        // Individual candidate failures are evidence, not product-lifetime decisions.
      }
    }
  }

  private async scheduleRecovery(sessionId: string, reason: string): Promise<void> {
    const product = this.session.getSnapshot();
    if (product.type !== 'Connected' || product.sessionId !== sessionId || this.restartTimer) return;
    if (this.restartAttempt >= MEDIA_RESTART_DELAYS_MS.length) {
      await this.fail(sessionId, 'The Wi-Fi video connection could not recover.', 'media_failed');
      return;
    }

    if (!this.lastFailureReason) this.lastFailureReason = reason;
    const attempt = this.restartAttempt + 1;
    const delay = MEDIA_RESTART_DELAYS_MS[this.restartAttempt]!;
    this.restartAttempt = attempt;
    this.setState({ type: 'recovering', sessionId, role: product.role, attempt });
    await this.record('media_reconnect_attempt');

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.enqueue(async () => {
        const current = this.session.getSnapshot();
        if (current.type !== 'Connected' || current.sessionId !== sessionId || this.restartAttempt !== attempt) return;
        try {
          if (current.role === 'sharer') await this.restartAsSharer(sessionId);
          else await this.rtcOperation('send MEDIA_RESTART_REQUEST', () => this.session.sendMedia(sessionId, 'MEDIA_RESTART_REQUEST', { reason: 'connection_lost' }));
        } catch {
          if (this.restartAttempt === attempt) this.restartAttempt = attempt - 1;
          if (this.peerSessionId !== sessionId || this.restartTimer) return;
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.enqueue(() => this.scheduleRecovery(sessionId, `signaling retry after attempt ${attempt}`)).catch(() => undefined);
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
    const peer = this.peer;
    const sessionId = this.peerSessionId;
    if (!peer || !sessionId) return;
    const poll = async () => {
      this.statsTimer = null;
      try {
        await this.collectStats(peer, sessionId);
      } catch (error) {
        if (this.peer === peer && this.peerSessionId === sessionId) this.noteFailure('getStats', error);
      }
      if (this.peer === peer && this.peerSessionId === sessionId) {
        this.statsTimer = setTimeout(() => void poll(), MEDIA_STATS_INTERVAL_MS);
      }
    };
    this.statsTimer = setTimeout(() => void poll(), MEDIA_STATS_INTERVAL_MS);
  }

  private async collectStats(peer: RTCPeerConnection, sessionId: string): Promise<void> {
    const report = await peer.getStats();
    const product = this.session.getSnapshot();
    if (
      this.peer !== peer
      || this.peerSessionId !== sessionId
      || product.type !== 'Connected'
      || product.sessionId !== sessionId
    ) return;

    const now = this.nowMs();
    const next: MediaStatsSnapshot = { atMs: now };
    let sentBytes: number | undefined;
    let receivedBytes: number | undefined;

    report.forEach((item: any) => {
      if (item.type === 'codec' && typeof item.mimeType === 'string' && item.mimeType.toLowerCase().startsWith('video/')) {
        next.codecMimeType ??= item.mimeType;
      }
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
        const jitter = numeric(item.jitter);
        if (jitter !== undefined) next.jitterMs = jitter * 1_000;
      }
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || item.selected)) {
        next.candidatePairState = text(item.state);
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
      const transport = snapshotPeerTransport(peer);
      if (
        this.peerSessionId &&
        peerTransportDisposition(transport.connectionState, transport.iceConnectionState) === 'connected'
      ) {
        this.setState({ type: 'live', sessionId: this.peerSessionId, role: 'requester' });
      }
      await this.record('media_first_frame');
    }
    await this.record('media_stats');
    this.emit();
  }

  private async fail(sessionId: string, message: string, reason: 'capture_failed' | 'media_failed'): Promise<void> {
    if (!this.lastFailureReason) this.lastFailureReason = message;
    this.setState({ type: 'error', sessionId, message });
    await this.record(reason === 'capture_failed' ? 'capture_failed' : 'media_failed');
    if (reason === 'capture_failed') await this.session.captureFailed(sessionId, 'capture_failed');
    else await this.session.mediaFailed(sessionId);
    await this.resetMedia(false);
  }

  private async denyCapture(sessionId: string, detail: string): Promise<void> {
    this.lastFailureReason = detail;
    this.setState({ type: 'error', sessionId, message: 'Android screen sharing permission was not granted.' });
    await this.record('capture_consent_denied');
    await this.session.captureDenied(sessionId, 'system_denied');
  }

  private currentDiagnosticSnapshot(): MediaDiagnosticSnapshot {
    const transport = snapshotPeerTransport(this.peer);
    return {
      state: this.state.type,
      role: this.role ?? undefined,
      connectionState: transport.connectionState,
      iceConnectionState: transport.iceConnectionState,
      iceGatheringState: transport.iceGatheringState,
      signalingState: transport.signalingState,
      remoteTrackSeen: this.remoteTrackSeen,
      firstFrameSeen: this.firstFrameSeen,
      acceptedLocalCandidates: this.acceptedLocalCandidates,
      rejectedLocalCandidates: this.rejectedLocalCandidates,
      acceptedRemoteCandidates: this.acceptedRemoteCandidates,
      rejectedRemoteCandidates: this.rejectedRemoteCandidates,
      restartAttempts: this.restartAttempt,
      bitrateParametersApplied: this.bitrateParametersApplied,
      lastFailureReason: this.lastFailureReason,
      stats: this.stats,
    };
  }

  private hasActiveMediaSession(): boolean {
    return this.peerSessionId !== null || this.state.type !== 'idle' || Boolean(this.peer || this.localStream || this.remoteStream);
  }

  private archiveCurrentDiagnosticSnapshot(): void {
    if (!this.hasActiveMediaSession()) return;
    this.archivedDiagnostic = cloneDiagnostic(this.currentDiagnosticSnapshot());
  }

  private beginDiagnosticSession(): void {
    this.archivedDiagnostic = null;
    this.lastFailureReason = undefined;
  }

  private resetActiveDiagnostics(): void {
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
    this.lastFailureReason = undefined;
  }

  private async resetMedia(recordCaptureStop: boolean): Promise<void> {
    this.archiveCurrentDiagnosticSnapshot();
    this.clearDisconnectedTimer();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.restartTimer = null;
    this.statsTimer = null;

    const localStream = this.localStream;
    const hadCapture = Boolean(localStream);
    if (localStream) this.disposeOwnedLocalStream(localStream);

    this.remoteStreamURL = null;
    this.remoteStream = null;
    this.closePeer();
    this.peerSessionId = null;
    this.role = null;
    this.pendingRemoteCandidates = [];
    this.resetActiveDiagnostics();
    this.setState({ type: 'idle' });
    if (recordCaptureStop && hadCapture) await this.record('capture_stopped');
  }

  private disposeOwnedLocalStream(stream: MediaStream): void {
    const installed = this.localStream === stream;
    for (const track of stream.getTracks()) {
      (track as unknown as EndedAwareTrack).onended = null;
      try { track.stop(); } catch { /* already stopped */ }
    }
    if (installed) {
      this.localStream = null;
      this.closePeer();
    }
    try { stream.release(); } catch { /* already released */ }
  }

  private closePeer(): void {
    const peer = this.peer;
    this.peer = null;
    if (!peer) return;
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    (peer as any).oniceconnectionstatechange = null;
    (peer as any).onicegatheringstatechange = null;
    (peer as any).onsignalingstatechange = null;
    try { peer.close(); } catch { /* already closed */ }
  }

  private async rtcOperation<T>(label: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.noteFailure(label, error);
      throw error;
    }
  }

  private noteFailure(label: string, error: unknown): void {
    this.lastFailureReason = `${label}: ${failureText(error)}`;
    this.emit();
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