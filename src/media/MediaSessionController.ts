import type { ScreenCaptureState } from '../capture/ScreenCaptureCoordinator';
import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { AnyMediaControlMessage, ControlPayloadMap, MediaControlMessageType } from '../protocol/ControlMessage';
import type { SessionState } from '../session/SessionState';
import type { WebRtcMediaNativeEvent, WebRtcMediaPort } from './WebRtcMediaPort';

export const MEDIA_RECONNECT_MAX_ATTEMPTS = 3;
export const MEDIA_RECONNECT_DELAYS_MS = [750, 1_500, 3_000] as const;
export const MEDIA_RECONNECT_FRAME_GRACE_MS = 5_000;

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
  private recoveryAttempt = 0;
  private remoteTrackEpoch = 0;

  constructor(
    private readonly native: WebRtcMediaPort,
    private readonly session: MediaSessionAuthority,
    private readonly capture: CaptureStateSource,
    private readonly diagnostics: MediaDiagnostics,
    private readonly scheduler: MediaRecoveryScheduler = defaultScheduler,
  ) {
    this.unsubscribeNative = native.subscribe((event) => { void this.enqueue(() => this.handleNative(event)).catch(() => undefined); });
    this.unsubscribeSession = session.subscribe(() => { void this.enqueue(() => this.syncAuthority()).catch(() => undefined); });
    this.unsubscribeMedia = session.subscribeMedia((message) => { void this.enqueue(() => this.handleSignaling(message)).catch(() => undefined); });
    this.unsubscribeCapture = capture.subscribe(() => { void this.enqueue(() => this.syncAuthority()).catch(() => undefined); });
    void this.enqueue(() => this.syncAuthority()).catch(() => undefined);
  }

  getSnapshot = (): MediaSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  reconcile(): Promise<void> { return this.enqueue(() => this.syncAuthority()); }
  clearError(): Promise<void> { return this.enqueue(async () => {
    if (this.state.type !== 'error') return;
    this.clearRecovery(true);
    // After a failed media session, return to idle so a replacement session can start clean.
    // syncAuthority will also converge to idle when the product session is not Connected; this covers the
    // manual retry path where the SessionController has already returned to Paired*.
    this.setState({ type: 'idle' });
  }); }

  rendererFirstFrame(sessionId: string, rendererEpoch: number): Promise<void> { return this.enqueue(async () => {
    // LIVE is entered only for the exact current session AND the exact current renderer/track epoch.
    if (this.state.type !== 'remote_track_attached' || this.state.sessionId !== sessionId || this.state.trackEpoch !== rendererEpoch) return;
    const recovered = this.recoveryAttempt > 0;
    const trackEpoch = this.state.trackEpoch;
    this.clearRecovery(true);
    this.setState({ type: 'live', sessionId, quality: 'good', trackEpoch });
    await this.record('media_first_frame');
    if (recovered) await this.record('media_reconnected');
  }); }

  dispose(): void {
    const active = this.activeSessionId();
    this.unsubscribeNative(); this.unsubscribeSession(); this.unsubscribeMedia(); this.unsubscribeCapture();
    this.clearRecovery(true); this.listeners.clear();
    if (active) void this.native.close(active).catch(() => undefined);
  }

  /** True only while the product session is Connected with exactly expectedSessionId. */
  private isCurrentSession(expectedSessionId: string): boolean {
    const session = this.session.getSnapshot();
    return session.type === 'Connected' && session.sessionId === expectedSessionId;
  }

  private async syncAuthority(): Promise<void> {
    const session = this.session.getSnapshot();
    if (session.type !== 'Connected') {
      const active = this.activeSessionId();
      this.clearRecovery(true);
      if (active) await this.native.close(active).catch(() => undefined);
      if (this.state.type !== 'idle') this.setState({ type: 'idle' });
      return;
    }

    if (session.role === 'requester') {
      const sessionId = session.sessionId;
      const active = this.activeSessionId();
      if (active && active !== sessionId) { this.clearRecovery(true); await this.native.close(active).catch(() => undefined); }
      if (active !== sessionId) {
        this.setState({ type: 'negotiating', sessionId, role: 'requester', quality: 'unknown' });
        try {
          await this.native.prepareRequester(sessionId);
          if (!this.isCurrentSession(sessionId)) return;
          await this.record('media_negotiation_started');
        } catch { await this.failMedia(sessionId, 'PartnerScreen could not prepare private video reception.'); }
      }
      return;
    }

    const capture = this.capture.getSnapshot();
    if (capture.type !== 'capturing' || capture.sessionId !== session.sessionId) return;
    const sessionId = session.sessionId;
    const active = this.activeSessionId();
    if (active === sessionId) return;
    if (active) { this.clearRecovery(true); await this.native.close(active).catch(() => undefined); }
    this.setState({ type: 'negotiating', sessionId, role: 'sharer', quality: 'unknown' });
    try {
      const offer = await this.native.createPublisherOffer(sessionId);
      // Delayed offer from a replaced session must never be signaled over the fresh channel.
      if (!this.isCurrentSession(sessionId)) return;
      await this.session.sendMedia(sessionId, 'SDP_OFFER', { sdp: offer });
      if (!this.isCurrentSession(sessionId)) return;
      this.setState({ type: 'publishing', sessionId, quality: 'unknown' });
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
        }
        const answer = await this.native.acceptOffer(sessionId, message.payload.sdp);
        // Delayed answer from a replaced session must never be sent over the fresh channel.
        if (!this.isCurrentSession(sessionId)) return;
        await this.session.sendMedia(sessionId, 'SDP_ANSWER', { sdp: answer });
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
      await this.record('media_remote_track');
      if (recovering) this.scheduleFrameGrace(event.sessionId);
      return;
    }

    // new/connecting are progress signals only and never product LIVE truth.
    if (event.state === 'connected') {
      const recovering = this.recoveryAttempt > 0;
      this.clearRecovery(false);
      if (this.state.type === 'publishing' && this.state.sessionId === event.sessionId) {
        this.setState({ type: 'publishing', sessionId: event.sessionId, quality: 'good' });
        if (recovering) { this.recoveryAttempt = 0; await this.record('media_reconnected'); }
      } else if (this.state.type === 'reconnecting' && this.state.sessionId === event.sessionId && this.state.role === 'sharer') {
        this.setState({ type: 'publishing', sessionId: event.sessionId, quality: 'good' });
        this.recoveryAttempt = 0;
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
    this.recoveryAttempt += 1;
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
        await this.native.close(sessionId).catch(() => undefined);
        await this.native.prepareRequester(sessionId);
        if (!this.isCurrentSession(sessionId)) return;
        this.scheduleFrameGrace(sessionId);
        return;
      }
      const capture = this.capture.getSnapshot();
      if (capture.type !== 'capturing' || capture.sessionId !== sessionId) throw new Error('capture inactive');
      await this.native.close(sessionId).catch(() => undefined);
      const offer = await this.native.createPublisherOffer(sessionId);
      if (!this.isCurrentSession(sessionId)) return;
      await this.session.sendMedia(sessionId, 'SDP_OFFER', { sdp: offer });
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

  private async failMedia(expectedSessionId: string, message: string): Promise<void> {
    // A delayed failure from a replaced/terminal session must never terminate the fresh session.
    if (!this.isCurrentSession(expectedSessionId)) return;
    const active = this.activeSessionId();
    this.clearRecovery(true);
    if (active) await this.native.close(active).catch(() => undefined);
    this.setState({ type: 'error', message });
    await this.record('media_failed');
    await this.session.mediaFailed(expectedSessionId).catch(() => undefined);
  }
  private activeSessionId(): string | null { return this.state.type === 'negotiating' || this.state.type === 'publishing' || this.state.type === 'remote_track_attached' || this.state.type === 'live' || this.state.type === 'reconnecting' ? this.state.sessionId : null; }
  private clearRecovery(resetAttempt: boolean): void { this.recoveryTimer?.cancel(); this.recoveryTimer = null; if (resetAttempt) this.recoveryAttempt = 0; }
  private record(kind: DiagnosticEventKind): Promise<void> { return this.diagnostics.append(kind).catch(() => undefined); }
  private setState(next: MediaSessionState): void { this.state = next; for (const listener of this.listeners) listener(); }
  private enqueue(operation: () => Promise<void>): Promise<void> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
}
