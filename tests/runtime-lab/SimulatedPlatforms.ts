import type { ScreenCaptureNativeEvent, ScreenCapturePort } from '../../src/capture/ScreenCapturePort';
import type { SanitizedMediaStats } from '../../src/media/MediaStats';
import type { WebRtcMediaNativeEvent, WebRtcMediaPort } from '../../src/media/WebRtcMediaPort';
import type { RequestNotificationPort } from '../../src/platform/notifications/ExpoRequestNotification';
import type { NotificationPermissionState } from '../../src/request/NotificationPermission';
import { VirtualClock } from './VirtualClock';
import { VirtualNetwork } from './VirtualNetwork';

export type SimulatedNotificationPermission = 'unknown' | 'granted' | 'denied' | 'dismissed' | 'channel_disabled' | 'requestable' | 'prompting';

export class SimulatedNotificationPort implements RequestNotificationPort {
  permission: SimulatedNotificationPermission = 'granted';
  nextPromptResult: SimulatedNotificationPermission = 'granted';
  permissionRequests = 0;
  shownSessionId: string | null = null;
  showAttempts: string[] = [];
  clearCount = 0;
  private launchSessionId: string | null = null;
  private readonly opened = new Set<(sessionId: string) => void>();

  async ensurePermission(): Promise<boolean> {
    if (this.permission === 'granted') return true;
    this.permissionRequests += 1;
    if (this.permission === 'unknown' || this.permission === 'dismissed' || this.permission === 'requestable') this.permission = this.nextPromptResult;
    return this.permission === 'granted';
  }

  async readPermissionState(): Promise<NotificationPermissionState> {
    if (this.permission === 'granted') return 'granted';
    if (this.permission === 'denied' || this.permission === 'channel_disabled') return 'denied';
    if (this.permission === 'dismissed') return 'dismissed';
    if (this.permission === 'unknown') return 'unknown';
    if (this.permission === 'requestable' || this.permission === 'prompting') return 'requestable';
    return 'unknown';
  }

  async requestPermissionFromForeground(): Promise<NotificationPermissionState> {
    this.permissionRequests += 1;
    if (this.permission === 'unknown' || this.permission === 'requestable' || this.permission === 'dismissed') {
      this.permission = this.nextPromptResult as SimulatedNotificationPermission;
    }
    return this.readPermissionState();
  }

  async showRequestNotification(sessionId: string, _partnerName?: string): Promise<boolean> {
    this.showAttempts.push(sessionId);
    if (this.permission !== 'granted') return false;
    this.shownSessionId = sessionId;
    return true;
  }

  async clearRequestNotification(): Promise<boolean> {
    this.clearCount += 1;
    this.shownSessionId = null;
    return true;
  }

  async consumeLaunchSessionId(): Promise<string | null> {
    const value = this.launchSessionId;
    this.launchSessionId = null;
    return value;
  }

  subscribeOpened(listener: (sessionId: string) => void): () => void {
    this.opened.add(listener);
    return () => this.opened.delete(listener);
  }

  tap(sessionId = this.shownSessionId): void {
    if (!sessionId) return;
    this.launchSessionId = sessionId;
    for (const listener of this.opened) listener(sessionId);
  }
}

export type SimulatedConsentMode = 'granted' | 'denied' | 'pending';

export class SimulatedCapturePort implements ScreenCapturePort {
  notificationPermission = true;
  consentMode: SimulatedConsentMode = 'granted';
  startDelayMs = 0;
  stopDelayMs = 0;
  startCount = 0;
  stopCount = 0;
  private state: 'idle' | 'starting' | 'capturing' = 'idle';
  private activeSessionId: string | null = null;
  private readonly listeners = new Set<(event: ScreenCaptureNativeEvent) => void>();
  private pendingConsent: ((granted: boolean) => void) | null = null;

  constructor(private readonly clock: VirtualClock) {}

  subscribe(listener: (event: ScreenCaptureNativeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ensureNotificationPermission(): Promise<boolean> {
    return this.notificationPermission;
  }

  requestConsent(): Promise<boolean> {
    if (this.consentMode === 'granted') return Promise.resolve(true);
    if (this.consentMode === 'denied') return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pendingConsent = resolve;
    });
  }

  async start(sessionId: string): Promise<void> {
    this.startCount += 1;
    this.state = 'starting';
    this.activeSessionId = sessionId;
    this.emit({ type: 'starting', sessionId });
    this.clock.schedule(this.startDelayMs, () => {
      if (this.activeSessionId !== sessionId || this.state !== 'starting') return;
      this.state = 'capturing';
      this.emit({ type: 'started', sessionId });
    });
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    const sessionId = this.activeSessionId;
    this.activeSessionId = null;
    this.state = 'idle';
    if (sessionId) this.clock.schedule(this.stopDelayMs, () => this.emit({ type: 'stopped', reason: 'user', sessionId }));
  }

  getNativeState(): 'idle' | 'starting' | 'capturing' {
    return this.state;
  }

  approveConsent(): void {
    const resolve = this.pendingConsent;
    this.pendingConsent = null;
    this.consentMode = 'granted';
    resolve?.(true);
  }

  denyConsent(): void {
    const resolve = this.pendingConsent;
    this.pendingConsent = null;
    this.consentMode = 'denied';
    resolve?.(false);
  }

  revoke(): void {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    this.activeSessionId = null;
    this.state = 'idle';
    this.emit({ type: 'revoked', sessionId });
  }

  private emit(event: ScreenCaptureNativeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const SAFE_SDP = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n';

function safeHostCandidate(host: string, port: number): string {
  return `candidate:1 1 udp 2122260223 ${host} ${port} typ host`;
}

type MediaSessionLink = {
  publisher?: SimulatedMediaPort | undefined;
  requester?: SimulatedMediaPort | undefined;
  connected: boolean;
};

export class SimulatedMediaFabric {
  readonly sessions = new Map<string, MediaSessionLink>();
  remoteTrackDelayMs = 0;
  connectionDelayMs = 0;

  constructor(readonly network: VirtualNetwork) {}

  registerPublisher(sessionId: string, port: SimulatedMediaPort): void {
    const link = this.sessions.get(sessionId) ?? { connected: false };
    link.publisher = port;
    this.sessions.set(sessionId, link);
  }

  registerRequester(sessionId: string, port: SimulatedMediaPort): void {
    const link = this.sessions.get(sessionId) ?? { connected: false };
    link.requester = port;
    this.sessions.set(sessionId, link);
  }

  onOfferAccepted(sessionId: string): void {
    const link = this.sessions.get(sessionId);
    if (!link?.requester) return;
    this.network.clock.schedule(this.remoteTrackDelayMs, () => {
      this.network.transmit('media', 64, () => link.requester?.emit({ type: 'remote_track', sessionId }));
    });
  }

  onAnswerAccepted(sessionId: string): void {
    const link = this.sessions.get(sessionId);
    if (!link?.publisher || !link.requester) return;
    this.network.clock.schedule(this.connectionDelayMs, () => {
      const delivered = this.network.transmit('media', 64, () => {
        link.connected = true;
        link.publisher?.markConnected(sessionId);
        link.requester?.markConnected(sessionId);
      });
      if (!delivered) {
        link.publisher?.emit({ type: 'connection_state', sessionId, state: 'failed' });
        link.requester?.emit({ type: 'connection_state', sessionId, state: 'failed' });
      }
    });
  }

  disconnect(sessionId: string): void {
    const link = this.sessions.get(sessionId);
    if (!link) return;
    link.connected = false;
    link.publisher?.emit({ type: 'connection_state', sessionId, state: 'disconnected' });
    link.requester?.emit({ type: 'connection_state', sessionId, state: 'disconnected' });
  }

  fail(sessionId: string): void {
    const link = this.sessions.get(sessionId);
    if (!link) return;
    link.connected = false;
    link.publisher?.emit({ type: 'connection_state', sessionId, state: 'failed' });
    link.requester?.emit({ type: 'connection_state', sessionId, state: 'failed' });
  }

  close(sessionId: string, port: SimulatedMediaPort): void {
    const link = this.sessions.get(sessionId);
    if (!link) return;
    if (link.publisher === port) link.publisher = undefined;
    if (link.requester === port) link.requester = undefined;
    if (!link.publisher && !link.requester) this.sessions.delete(sessionId);
  }
}

export class SimulatedMediaPort implements WebRtcMediaPort {
  private readonly listeners = new Set<(event: WebRtcMediaNativeEvent) => void>();
  private readonly connectedAt = new Map<string, number>();
  readonly addedCandidates: string[] = [];
  closeCount = 0;

  constructor(readonly host: string, readonly fabric: SimulatedMediaFabric, private readonly clock: VirtualClock) {}

  subscribe(listener: (event: WebRtcMediaNativeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prepareRequester(sessionId: string): Promise<void> {
    this.fabric.registerRequester(sessionId, this);
    this.emitCandidate(sessionId, 51000);
  }

  async createPublisherOffer(sessionId: string): Promise<string> {
    this.fabric.registerPublisher(sessionId, this);
    this.emitCandidate(sessionId, 52000);
    return SAFE_SDP;
  }

  async acceptOffer(sessionId: string, _sdp: string): Promise<string> {
    this.fabric.registerRequester(sessionId, this);
    this.fabric.onOfferAccepted(sessionId);
    return SAFE_SDP;
  }

  async acceptAnswer(sessionId: string, _sdp: string): Promise<void> {
    this.fabric.onAnswerAccepted(sessionId);
  }

  async addIceCandidate(_sessionId: string, _sdpMid: string, _sdpMLineIndex: number, candidate: string): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  async close(sessionId: string): Promise<void> {
    this.closeCount += 1;
    this.connectedAt.delete(sessionId);
    this.fabric.close(sessionId, this);
  }

  async getStats(sessionId: string): Promise<SanitizedMediaStats | null> {
    const connectedAt = this.connectedAt.get(sessionId);
    if (connectedAt === undefined) return null;
    const elapsed = Math.max(0, this.clock.nowMs() - connectedAt);
    const frames = Math.floor(elapsed / 50);
    return {
      bytesSent: frames * 4_000,
      bytesReceived: frames * 4_000,
      framesEncoded: frames,
      framesDecoded: frames,
      framesPerSecond: elapsed > 0 ? 20 : 0,
      frameWidth: 1280,
      frameHeight: 720,
      candidatePairState: 'succeeded',
      bitrateParametersState: 'applied',
    };
  }

  emit(event: WebRtcMediaNativeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  markConnected(sessionId: string): void {
    this.connectedAt.set(sessionId, this.clock.nowMs());
    this.emit({ type: 'connection_state', sessionId, state: 'connected' });
  }

  private emitCandidate(sessionId: string, port: number): void {
    this.fabric.network.transmit('media', 96, () => this.emit({
      type: 'ice_candidate',
      sessionId,
      sdpMid: '0',
      sdpMLineIndex: 0,
      candidate: safeHostCandidate(this.host, port),
    }));
  }
}
