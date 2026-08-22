import type { ScreenCaptureState } from '../capture/ScreenCaptureCoordinator';
import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { AnyMediaControlMessage, ControlPayloadMap, MediaControlMessageType } from '../protocol/ControlMessage';
import type { SessionState } from '../session/SessionState';
import type { SanitizedIceClassification } from './IceCandidateClassification';
import { measuredBitrateBps, qualityFromStats, sanitizeMediaStats, type SanitizedMediaStats } from './MediaStats';
import { emptyMediaTransportSnapshot, type MediaTransportSnapshot } from './MediaTransportSnapshot';
import type { WebRtcMediaNativeEvent, WebRtcMediaPort } from './WebRtcMediaPort';

export const MEDIA_RECONNECT_MAX_ATTEMPTS = 3;
export const MEDIA_RECONNECT_DELAYS_MS = [750, 1_500, 3_000] as const;
export const MEDIA_RECONNECT_FRAME_GRACE_MS = 5_000;
export const MEDIA_INITIAL_USABLE_VIDEO_DEADLINE_MS = 15_000;
/** Connection timeout starts only after SDP/ICE work has actually begun. */
export const MEDIA_CONNECTION_TIMEOUT_MS = 10_000;
/** First-frame timeout starts only after a remote track exists to render. */
export const MEDIA_FIRST_FRAME_TIMEOUT_MS = MEDIA_INITIAL_USABLE_VIDEO_DEADLINE_MS;
export const MEDIA_RECONNECT_ATTEMPT_TIMEOUT_MS = 8_000;
export const MEDIA_STATS_POLL_INTERVAL_MS = 2_000;

export type MediaQuality = 'unknown' | 'good' | 'degraded' | 'reconnecting';
export type MediaSessionState =
  | { type: 'idle' }
  | { type: 'negotiating'; sessionId: string; role: 'requester' | 'sharer'; quality: 'unknown' }
  | { type: 'publishing'; sessionId: string; quality: 'unknown' | 'good' | 'degraded' }
  | { type: 'remote_track_attached'; sessionId: string; quality: 'unknown' | 'good' | 'degraded'; trackEpoch: number }
  | { type: 'live'; sessionId: string; quality: 'good'; trackEpoch: number }
  | { type: 'reconnecting'; sessionId: string; role: 'requester' | 'sharer'; attempt: number; quality: 'reconnecting' }
  | { type: 'error'; message: string };

export interface MediaDiagnostics { append(kind: DiagnosticEventKind): Promise<void>; }
export interface MediaSessionAuthority {
  getSnapshot(): SessionState;
  subscribe(listener: () => void): () => void;
  subscribeMedia(listener: (message: AnyMediaControlMessage) => void): () => void;
  sendMedia<T extends MediaControlMessageType>(expectedSessionId: string, type: T, payload: ControlPayloadMap[T]): Promise<void>;
  mediaFailed(expectedSessionId: string): Promise<void>;
}
export interface CaptureStateSource {
  getSnapshot(): ScreenCaptureState;
  subscribe(listener: () => void): () => void;
}
export interface RecoveryTimer { cancel(): void; }
export interface MediaRecoveryScheduler { schedule(delayMs: number, task: () => void): RecoveryTimer; }

const defaultScheduler: MediaRecoveryScheduler = {
  schedule(delayMs, task) {
    const handle = setTimeout(task, Math.max(1, delayMs));
    return { cancel: () => clearTimeout(handle) };
  },
};

export class MediaSessionController {
  private state: MediaSessionState = { type: 'idle' };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeNative: () => void;
  private readonly unsubscribeSession: () => void;
  private readonly unsubscribeMedia: () => void;
  private readonly unsubscribeCapture: () => void;
  private operationQueue: Promise<void> = Promise.resolve();
  private recoveryTimer: RecoveryTimer | null = null;
  private initialDeadlineTimer: RecoveryTimer | null = null;
  private connectionDeadlineTimer: RecoveryTimer | null = null;
  private firstFrameDeadlineTimer: RecoveryTimer | null = null;
  private statsTimer: RecoveryTimer | null = null;
  private recoveryAttempt = 0;
  private iceRestartUsed = false;
  private mediaPhase: 'idle' | 'waiting_for_consent' | 'waiting_for_sender' | 'waiting_for_offer' | 'negotiating' | 'waiting_for_transport' | 'remote_track_waiting_frame' | 'live' | 'recovering' | 'terminal_media_error' = 'idle';
  private remoteTrackEpoch = 0;
  private stats: SanitizedMediaStats | null = null;
  private liveHealth: 'good' | 'degraded' = 'good';
  private previousBytesSent: { bytesSent: number; atMs: number } | null = null;
  private previousPacketsLost: number | undefined;
  private transport: MediaTransportSnapshot = emptyMediaTransportSnapshot();
  private disposed = false;

  constructor(
    private readonly native: WebRtcMediaPort,
    private readonly session: MediaSessionAuthority,
    private readonly capture: CaptureStateSource,
    private readonly diagnostics: MediaDiagnostics,
    private readonly scheduler: MediaRecoveryScheduler = defaultScheduler,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.unsubscribeNative = native.subscribe((event) => { void this.enqueue(() => this.handleNative(event)).catch(() => undefined); });
    this.unsubscribeSession = session.subscribe(() => { void this.enqueue(() => this.syncAuthority()).catch(() => undefined); });
    this.unsubscribeMedia = session.subscribeMedia((message) => { void this.enqueue(() => this.handleSignaling(message)).catch(() => undefined); });
    this.unsubscribeCapture = capture.subscribe(() => { void this.enqueue(() => this.syncAuthority()).catch(() => undefined); });
    void this.enqueue(() => this.syncAuthority()).catch(() => undefined);
  }

  getSnapshot = (): MediaSessionState => this.state;
  getStatsSnapshot = (): SanitizedMediaStats | null => this.stats;
  getLiveHealth = (): 'good' | 'degraded' => this.liveHealth;
  getTransportSnapshot = (): MediaTransportSnapshot => this.transport;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  reconcile(): Promise<void> { return this.enqueue(() => this.syncAuthority()); }
  clearError(): Promise<void> { return this.enqueue(async () => {
    if (this.state.type !== 'error') return;
    this.clearRecovery(true);
    this.clearDeadlines();
    this.clearStats();
    this.setState({ type: 'idle' });
  }); }
  resetToIdle(): Promise<void> { return this.enqueue(async () => {
    const active = this.activeSessionId();
    this.clearRecovery(true);
    this.clearDeadlines();
    this.clearStats();
    if (active) await this.native.close(active).catch(() => undefined);
    if (this.state.type !== 'idle') this.setState({ type: 'idle' });
  }); }

  rendererFirstFrame(sessionId: string, rendererEpoch: number): Promise<void> { return this.enqueue(async () => {
    if (this.state.type !== 'remote_track_attached' || this.state.sessionId !== sessionId || this.state.trackEpoch !== rendererEpoch) return;
    const recovered = this.recoveryAttempt > 0;
    const trackEpoch = this.state.trackEpoch;
    this.clearRecovery(true);
    this.clearDeadlines();
    this.liveHealth = 'good';
    this.setState({ type: 'live', sessionId, quality: 'good', trackEpoch });
    this.mediaPhase = 'live';
    this.iceRestartUsed = false;
    this.transport = { ...this.transport, firstRenderedFrame: true };
    this.scheduleStats(sessionId);
    await this.record('media_first_frame');
    if (recovered) await this.record('media_reconnected');
  }); }

  dispose(): void {
    const active = this.activeSessionId();
    this.disposed = true;
    this.unsubscribeNative(); this.unsubscribeSession(); this.unsubscribeMedia(); this.unsubscribeCapture();
    this.clearRecovery(true); this.clearDeadlines(); this.clearStats(); this.listeners.clear();
    if (active) void this.native.close(active).catch(() => undefined);
  }

  private isCurrentSession(expectedSessionId: string): boolean {
    const session = this.session.getSnapshot();
    return session.type === 'Connected' && session.sessionId === expectedSessionId;
  }

  private async syncAuthority(): Promise<void> {
    const session = this.session.getSnapshot();
    if (session.type !== 'Connected') {
      const active = this.activeSessionId();
      this.clearRecovery(true);
      this.clearDeadlines();
      this.clearStats();
      if (active) await this.native.close(active).catch(() => undefined);
      this.iceRestartUsed = false;
      this.mediaPhase = 'idle';
      if (this.state.type !== 'idle') this.setState({ type: 'idle' });
      return;
    }

    if (session.role === 'requester') {
      const sessionId = session.sessionId;
      const active = this.activeSessionId();
      if (active && active !== sessionId) { this.clearRecovery(true); this.clearDeadlines(); this.clearStats(); await this.native.close(active).catch(() => undefined); }
      if (active !== sessionId) {
        this.setState({ type: 'negotiating', sessionId, role: 'requester', quality: 'unknown' });
        this.mediaPhase = 'waiting_for_offer';
        try {
          await this.native.prepareRequester(sessionId);
          if (!this.isCurrentSession(sessionId)) return;
          await this.record('media_negotiation_started');
        } catch { await this.failMedia(sessionId, 'PartnerScreen could not prepare private video reception.'); }
      }
      return;
    }

    const capture = this.capture.getSnapshot();
    if (capture.type === 'requesting_consent' && capture.sessionId === session.sessionId) {
      this.mediaPhase = 'waiting_for_consent';
      this.clearDeadlines();
      return;
    }
    if (capture.type !== 'capturing' || capture.sessionId !== session.sessionId) {
      if (session.role === 'sharer') this.mediaPhase = 'waiting_for_consent';
      return;
    }
    const sessionId = session.sessionId;
    const active = this.activeSessionId();
    if (active === sessionId) return;
    if (active) { this.clearRecovery(true); this.clearDeadlines(); this.clearStats(); await this.native.close(active).catch(() => undefined); }
    this.setState({ type: 'negotiating', sessionId, role: 'sharer', quality: 'unknown' });
    this.mediaPhase = 'waiting_for_sender';
    try {
      const offer = await this.native.createPublisherOffer(sessionId);
      if (!this.isCurrentSession(sessionId)) return;
      await this.session.sendMedia(sessionId, 'SDP_OFFER', { sdp: offer });
      if (!this.isCurrentSession(sessionId)) return;
      this.setState({ type: 'publishing', sessionId, quality: 'unknown' });
      this.mediaPhase = 'waiting_for_transport';
      this.scheduleConnectionDeadline(sessionId);
      await this.record('media_negotiation_started');
    } catch { await this.failMedia(sessionId, 'PartnerScreen could not start the private video connection.'); }
  }

  private async handleSignaling(message: AnyMediaControlMessage): Promise<void> {
    const session = this.session.getSnapshot();
    if (session.type !== 'Connected' || session.sessionId !== message.sessionId) { await this.failMedia(message.sessionId, 'Authenticated media signaling arrived outside the active session.'); return; }
    const sessionId = session.sessionId;
    try {
      if (message.type === 'MEDIA_RESTART_REQUEST') {
        if (session.role !== 'sharer') throw new Error('wrong role');
        await this.beginRecovery(sessionId, true);
        return;
      }
      if (message.type === 'SDP_OFFER') {
        if (session.role !== 'requester') throw new Error('wrong role');
        const wasRecovery = this.state.type === 'reconnecting' || this.state.type === 'live' || this.state.type === 'remote_track_attached';
        if (wasRecovery) {
          this.clearRecovery(false);
          await this.native.close(sessionId).catch(() => undefined);
          await this.native.prepareRequester(sessionId);
          if (!this.isCurrentSession(sessionId)) return;
          if (this.recoveryAttempt === 0) this.recoveryAttempt = 1;
          this.setState({ type: 'reconnecting', sessionId, role: 'requester', attempt: this.recoveryAttempt, quality: 'reconnecting' });
          this.scheduleAttemptWatchdog(sessionId);
        }
        const answer = await this.native.acceptOffer(sessionId, message.payload.sdp);
        if (!this.isCurrentSession(sessionId)) return;
        await this.session.sendMedia(sessionId, 'SDP_ANSWER', { sdp: answer });
        if (this.mediaPhase === 'waiting_for_offer' || this.mediaPhase === 'negotiating') this.mediaPhase = 'waiting_for_transport';
        this.scheduleConnectionDeadline(sessionId);
        return;
      }
      if (message.type === 'SDP_ANSWER') {
        if (session.role !== 'sharer') throw new Error('wrong role');
        await this.native.acceptAnswer(sessionId, message.payload.sdp);
        return;
      }
      await this.native.addIceCandidate(sessionId, message.payload.sdpMid, message.payload.sdpMLineIndex, message.payload.candidate);
    } catch { await this.failMedia(sessionId, 'Authenticated media negotiation failed.'); }
  }

  private async handleNative(event: WebRtcMediaNativeEvent): Promise<void> {
    const session = this.session.getSnapshot();
    if (session.type !== 'Connected' || session.sessionId !== event.sessionId) { await this.native.close(event.sessionId).catch(() => undefined); return; }
    this.observeNative(event);
    if (event.type === 'ice_state' || event.type === 'ice_classified' || event.type === 'renderer') return;
    if (event.type === 'ice_candidate') {
      try { await this.session.sendMedia(event.sessionId, 'ICE_CANDIDATE', { sdpMid: event.sdpMid, sdpMLineIndex: event.sdpMLineIndex, candidate: event.candidate }); }
      catch { await this.failMedia(event.sessionId, 'Private network candidate signaling failed.'); }
      return;
    }
    if (event.type === 'remote_track') {
      if (session.role !== 'requester') { await this.failMedia(event.sessionId, 'Unexpected remote video track.'); return; }
      const recovering = this.recoveryAttempt > 0;
      this.clearRecovery(false);
      this.remoteTrackEpoch += 1;
      this.setState({ type: 'remote_track_attached', sessionId: event.sessionId, quality: 'good', trackEpoch: this.remoteTrackEpoch });
      this.mediaPhase = 'remote_track_waiting_frame';
      this.clearConnectionDeadline();
      if (recovering) this.scheduleFrameGrace(event.sessionId);
      else this.scheduleFirstFrameDeadline(event.sessionId);
      await this.record('media_remote_track');
      return;
    }

    if (event.state === 'connected') {
      const recovering = this.recoveryAttempt > 0;
      this.clearRecovery(false);
      if (this.state.type === 'publishing' && this.state.sessionId === event.sessionId) {
        this.clearDeadlines();
        this.setState({ type: 'publishing', sessionId: event.sessionId, quality: 'good' });
        this.scheduleStats(event.sessionId);
        if (recovering) { this.recoveryAttempt = 0; await this.record('media_reconnected'); }
      } else if (this.state.type === 'reconnecting' && this.state.sessionId === event.sessionId && this.state.role === 'sharer') {
        this.clearDeadlines();
        this.setState({ type: 'publishing', sessionId: event.sessionId, quality: 'good' });
        this.recoveryAttempt = 0;
        this.scheduleStats(event.sessionId);
        await this.record('media_reconnected');
      } else if (this.state.type === 'remote_track_attached' && this.state.sessionId === event.sessionId) {
        this.setState({ type: 'remote_track_attached', sessionId: event.sessionId, quality: 'good', trackEpoch: this.state.trackEpoch });
        if (recovering) this.scheduleFrameGrace(event.sessionId);
      } else if (this.state.type === 'live' && this.state.sessionId === event.sessionId) {
        this.setState({ type: 'live', sessionId: event.sessionId, quality: 'good', trackEpoch: this.state.trackEpoch });
      } else if (this.state.type === 'reconnecting' && this.state.sessionId === event.sessionId && this.state.role === 'requester') {
        this.scheduleFrameGrace(event.sessionId);
      }
      return;
    }
    if (event.state === 'disconnected') { await this.beginRecovery(event.sessionId, false); return; }
    if (event.state === 'failed') {
      this.clearRecovery(false);
      await this.beginRecovery(event.sessionId, true);
      return;
    }
    if (event.state === 'closed') {
      if (this.state.type === 'reconnecting' && this.state.sessionId === event.sessionId) return;
      await this.failMedia(event.sessionId, 'The private video connection stopped.');
    }
  }

  private async beginRecovery(sessionId: string, immediate: boolean): Promise<void> {
    const session = this.session.getSnapshot();
    if (session.type !== 'Connected' || session.sessionId !== sessionId) return;
    if (this.recoveryTimer) return;
    if (this.recoveryAttempt >= MEDIA_RECONNECT_MAX_ATTEMPTS) { await this.failMedia(sessionId, 'The private video connection could not recover.'); return; }
    this.clearStats();
    this.clearInitialDeadline();
    this.clearConnectionDeadline();
    this.clearFirstFrameDeadline();
    this.recoveryAttempt += 1;
    this.mediaPhase = 'recovering';
    this.setState({ type: 'reconnecting', sessionId, role: session.role, attempt: this.recoveryAttempt, quality: 'reconnecting' });
    if (this.recoveryAttempt === 1) await this.record('media_degraded');
    await this.record('media_reconnect_attempt');
    const delay = immediate ? 1 : MEDIA_RECONNECT_DELAYS_MS[this.recoveryAttempt - 1]!;
    this.recoveryTimer = this.scheduler.schedule(delay, () => {
      this.recoveryTimer = null;
      void this.enqueue(() => this.performRecovery(sessionId)).catch(() => undefined);
    });
  }

  private async performRecovery(sessionId: string): Promise<void> {
    const session = this.session.getSnapshot();
    if (session.type !== 'Connected' || session.sessionId !== sessionId) return;
    try {
      if (session.role === 'requester') {
        await this.session.sendMedia(sessionId, 'MEDIA_RESTART_REQUEST', { reason: 'connection_lost' });
        if (!this.isCurrentSession(sessionId)) return;
        if (!this.iceRestartUsed && this.native.restartIce) {
          const restarted = await this.native.restartIce(sessionId).catch(() => false);
          if (restarted) {
            this.iceRestartUsed = true;
            this.scheduleFrameGrace(sessionId);
            return;
          }
        }
        this.iceRestartUsed = true;
        await this.native.close(sessionId).catch(() => undefined);
        await this.native.prepareRequester(sessionId);
        if (!this.isCurrentSession(sessionId)) return;
        this.scheduleFrameGrace(sessionId);
        return;
      }
      const capture = this.capture.getSnapshot();
      if (capture.type !== 'capturing' || capture.sessionId !== sessionId) throw new Error('capture inactive');
      if (!this.iceRestartUsed && this.native.restartIce) {
        const restarted = await this.native.restartIce(sessionId).catch(() => false);
        if (restarted) {
          this.iceRestartUsed = true;
          const offer = await this.native.createPublisherOffer(sessionId);
          if (!this.isCurrentSession(sessionId)) return;
          await this.session.sendMedia(sessionId, 'SDP_OFFER', { sdp: offer });
          this.scheduleAttemptWatchdog(sessionId);
          return;
        }
      }
      this.iceRestartUsed = true;
      await this.native.close(sessionId).catch(() => undefined);
      const offer = await this.native.createPublisherOffer(sessionId);
      if (!this.isCurrentSession(sessionId)) return;
      await this.session.sendMedia(sessionId, 'SDP_OFFER', { sdp: offer });
      this.scheduleAttemptWatchdog(sessionId);
    } catch {
      await this.beginRecovery(sessionId, false);
    }
  }

  private scheduleFrameGrace(sessionId: string): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = this.scheduler.schedule(MEDIA_RECONNECT_FRAME_GRACE_MS, () => {
      this.recoveryTimer = null;
      void this.enqueue(async () => {
        if (this.recoveryAttempt === 0) return;
        const state = this.state;
        if (state.type !== 'reconnecting' && state.type !== 'remote_track_attached') return;
        if (state.sessionId !== sessionId) return;
        await this.beginRecovery(sessionId, false);
      }).catch(() => undefined);
    });
  }

  private scheduleInitialDeadline(sessionId: string): void {
    this.scheduleFirstFrameDeadline(sessionId);
  }

  private isTransportConnected(): boolean {
    return this.transport.peerConnectionState === 'connected' || this.transport.iceConnectionState === 'connected' || this.transport.iceConnectionState === 'completed';
  }

  private scheduleConnectionDeadline(sessionId: string): void {
    if (this.connectionDeadlineTimer || this.recoveryTimer) return;
    this.connectionDeadlineTimer = this.scheduler.schedule(MEDIA_CONNECTION_TIMEOUT_MS, () => {
      this.connectionDeadlineTimer = null;
      void this.enqueue(async () => {
        if (!this.isCurrentSession(sessionId)) return;
        if (this.state.type === 'live' && this.state.sessionId === sessionId) return;
        if (this.isTransportConnected()) return;
        if (this.state.type === 'reconnecting') return;
        await this.beginRecovery(sessionId, true);
      }).catch(() => undefined);
    });
  }

  private scheduleFirstFrameDeadline(sessionId: string): void {
    this.clearFirstFrameDeadline();
    this.firstFrameDeadlineTimer = this.scheduler.schedule(MEDIA_FIRST_FRAME_TIMEOUT_MS, () => {
      this.firstFrameDeadlineTimer = null;
      void this.enqueue(async () => {
        if (!this.isCurrentSession(sessionId)) return;
        if (this.state.type === 'live' && this.state.sessionId === sessionId) return;
        if (this.state.type === 'reconnecting') return;
        if (this.state.type !== 'remote_track_attached' || this.state.sessionId !== sessionId) return;
        await this.beginRecovery(sessionId, true);
      }).catch(() => undefined);
    });
  }

  private scheduleAttemptWatchdog(sessionId: string): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = this.scheduler.schedule(MEDIA_RECONNECT_ATTEMPT_TIMEOUT_MS, () => {
      this.recoveryTimer = null;
      void this.enqueue(async () => {
        if (this.recoveryAttempt === 0) return;
        if (!this.isCurrentSession(sessionId)) return;
        if (this.state.type === 'live' && this.state.sessionId === sessionId) return;
        if (this.isTransportConnected()) return;
        await this.beginRecovery(sessionId, false);
      }).catch(() => undefined);
    });
  }

  private statsGeneration = 0;
  private nextNativeStatsToken = 0;
  private nativeStatsFlight: { token: number; sessionId: string; promise: Promise<SanitizedMediaStats | null> } | null = null;
  private statsTimeout: RecoveryTimer | null = null;

  private scheduleStats(sessionId: string): void {
    if (this.disposed) return;
    this.clearStatsTimer();
    this.statsTimer = this.scheduler.schedule(MEDIA_STATS_POLL_INTERVAL_MS, () => {
      this.statsTimer = null;
      void this.pullStats(sessionId).catch(() => undefined);
    });
  }

  private statsEligibleSessionId(): string | null {
    if (this.disposed) return null;
    if (this.state.type !== 'live' && this.state.type !== 'publishing' && this.state.type !== 'remote_track_attached') return null;
    return this.isCurrentSession(this.state.sessionId) ? this.state.sessionId : null;
  }

  private resumeStatsAfterNativeFlight(): void {
    const current = this.statsEligibleSessionId();
    if (current) this.scheduleStats(current);
  }

  private async pullStats(sessionId: string): Promise<void> {
    if (this.disposed || this.nativeStatsFlight) return;
    if (!this.isCurrentSession(sessionId)) return;
    if (this.state.type !== 'live' && this.state.type !== 'publishing' && this.state.type !== 'remote_track_attached') return;
    if (this.state.sessionId !== sessionId) return;

    const consumerGeneration = this.statsGeneration;
    const token = ++this.nextNativeStatsToken;
    const nativePromise = this.native.getStats(sessionId).catch(() => null);
    this.nativeStatsFlight = { token, sessionId, promise: nativePromise };

    const timeoutPromise = new Promise<{ timedOut: true; value: null }>((resolve) => {
      this.statsTimeout = this.scheduler.schedule(1_200, () => {
        this.statsTimeout = null;
        resolve({ timedOut: true, value: null });
      });
    });

    const nativeResultPromise = nativePromise.then((value) => ({ timedOut: false as const, value }));
    const winner = await Promise.race([nativeResultPromise, timeoutPromise]);

    if (winner.timedOut) {
      // The sample is abandoned, but the native invocation remains the single global flight until it settles.
      void nativePromise.finally(() => {
        if (this.nativeStatsFlight?.token !== token) return;
        this.nativeStatsFlight = null;
        this.resumeStatsAfterNativeFlight();
      });
      return;
    }

    if (this.statsTimeout) {
      this.statsTimeout.cancel();
      this.statsTimeout = null;
    }
    if (this.nativeStatsFlight?.token === token) this.nativeStatsFlight = null;

    // Session cleanup invalidates result consumption, never the underlying native-flight lifetime.
    if (consumerGeneration !== this.statsGeneration || !this.isCurrentSession(sessionId)) {
      this.resumeStatsAfterNativeFlight();
      return;
    }

    const sanitized = sanitizeMediaStats(winner.value);
    if (sanitized && typeof sanitized.bytesSent === 'number') {
      const measured = measuredBitrateBps(this.previousBytesSent, sanitized.bytesSent, this.nowMs());
      this.previousBytesSent = { bytesSent: sanitized.bytesSent, atMs: this.nowMs() };
      if (measured !== undefined) sanitized.measuredBitrateBps = measured;
    }
    this.stats = sanitized;
    const nextHealth = qualityFromStats(sanitized, this.previousPacketsLost);
    if (typeof sanitized?.packetsLost === 'number') this.previousPacketsLost = sanitized.packetsLost;
    if (this.state.type === 'live') {
      if (nextHealth === 'degraded' && this.liveHealth !== 'degraded') {
        this.liveHealth = 'degraded';
        await this.record('media_degraded');
      } else if (nextHealth === 'good') {
        this.liveHealth = 'good';
      }
    } else if ((this.state.type === 'publishing' || this.state.type === 'remote_track_attached') && this.state.sessionId === sessionId) {
      if (nextHealth === 'degraded' && this.state.quality !== 'degraded') {
        this.setState({ ...this.state, quality: 'degraded' });
        await this.record('media_degraded');
      } else if (nextHealth === 'good' && this.state.quality === 'degraded') {
        this.setState({ ...this.state, quality: 'good' });
      }
    }
    if (sanitized) await this.record('media_stats');
    for (const listener of this.listeners) listener();
    this.resumeStatsAfterNativeFlight();
  }

  private async failMedia(expectedSessionId: string, message: string): Promise<void> {
    if (!this.isCurrentSession(expectedSessionId)) return;
    const active = this.activeSessionId();
    this.clearRecovery(true);
    this.clearDeadlines();
    this.clearStats();
    if (active) await this.native.close(active).catch(() => undefined);
    this.mediaPhase = 'terminal_media_error';
    this.setState({ type: 'error', message });
    await this.record('media_failed');
    // Media failure owns the product-session terminal transition. Await it before returning so queued
    // native events cannot observe a still-Connected session and restart recovery after media_failed.
    await this.session.mediaFailed(expectedSessionId).catch(() => undefined);
  }
  private activeSessionId(): string | null { return this.state.type === 'negotiating' || this.state.type === 'publishing' || this.state.type === 'remote_track_attached' || this.state.type === 'live' || this.state.type === 'reconnecting' ? this.state.sessionId : null; }
  private clearRecovery(resetAttempt: boolean): void { this.recoveryTimer?.cancel(); this.recoveryTimer = null; if (resetAttempt) this.recoveryAttempt = 0; }
  private clearInitialDeadline(): void { this.initialDeadlineTimer?.cancel(); this.initialDeadlineTimer = null; }
  private clearConnectionDeadline(): void { this.connectionDeadlineTimer?.cancel(); this.connectionDeadlineTimer = null; }
  private clearFirstFrameDeadline(): void { this.firstFrameDeadlineTimer?.cancel(); this.firstFrameDeadlineTimer = null; }
  private clearStatsTimer(): void { this.statsTimer?.cancel(); this.statsTimer = null; }
  private clearDeadlines(): void { this.clearInitialDeadline(); this.clearConnectionDeadline(); this.clearFirstFrameDeadline(); this.clearStatsTimer(); }
  private clearStats(): void {
    this.statsGeneration += 1;
    this.clearStatsTimer();
    // Do not clear nativeStatsFlight or cancel its presentation timeout. A session teardown cannot cancel
    // the underlying native operation, so the single-flight token remains occupied until that Promise settles.
    this.stats = null;
    this.liveHealth = 'good';
    this.previousBytesSent = null;
    this.previousPacketsLost = undefined;
    this.transport = emptyMediaTransportSnapshot();
  }
  private observeNative(event: WebRtcMediaNativeEvent): void {
    if (event.type === 'connection_state') {
      this.transport = { ...this.transport, peerConnectionState: event.state };
      return;
    }
    if (event.type === 'ice_state') {
      this.transport = { ...this.transport, iceConnectionState: event.iceConnectionState, iceGatheringState: event.iceGatheringState };
      return;
    }
    if (event.type === 'ice_classified') {
      this.applyClassification(event.classification);
      return;
    }
    if (event.type === 'renderer') {
      const next: MediaTransportSnapshot = { ...this.transport, rendererAttached: event.attached };
      if (event.width !== undefined) next.rendererWidth = event.width;
      if (event.height !== undefined) next.rendererHeight = event.height;
      if (event.rotation !== undefined) next.rendererRotation = event.rotation;
      this.transport = next;
    }
  }
  private applyClassification(classification: SanitizedIceClassification): void {
    const next = { ...this.transport, lastRejectionReason: classification.rejectionReason ?? this.transport.lastRejectionReason };
    if (classification.direction === 'local') {
      next.localCandidatesGenerated += 1;
      next.lastLocalType = classification.candidateType;
      next.lastLocalTransport = classification.transport;
      next.lastLocalAddressFamily = classification.addressFamily;
      if (classification.accepted) next.localAccepted += 1;
      else next.localRejected += 1;
    } else {
      next.lastRemoteType = classification.candidateType;
      next.lastRemoteTransport = classification.transport;
      next.lastRemoteAddressFamily = classification.addressFamily;
      if (classification.accepted) next.remoteAccepted += 1;
      else next.remoteRejected += 1;
    }
    this.transport = next;
  }
  private record(kind: DiagnosticEventKind): Promise<void> { return this.diagnostics.append(kind).catch(() => undefined); }
  private setState(next: MediaSessionState): void { this.state = next; for (const listener of this.listeners) listener(); }
  private enqueue(operation: () => Promise<void>): Promise<void> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
}
