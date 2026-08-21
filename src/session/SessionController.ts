import type { AvailabilitySnapshot } from '../availability/AvailabilityService';
import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { PairTrustMetadata } from '../domain/pairing/PairTrustRepository';
import { CONTROL_REQUEST_TIMEOUT_MS, isMediaControlMessageType, type AnyControlMessage, type AnyMediaControlMessage, type ControlMessageType, type ControlPayloadMap, type MediaControlMessageType } from '../protocol/ControlMessage';
import type { ControlSessionEvent, ControlTrustContext } from '../control/ControlSession';
import type { PendingRequestRecord } from '../request/PendingRequestStore';
import { isBasePairedState, type SessionState } from './SessionState';

export interface SessionDiagnostics { append(kind: DiagnosticEventKind): Promise<void>; }
export interface SessionIdentitySource { bootstrap(): Promise<{ identity: { deviceId: string } }>; }
export interface SessionPairSecretSource { loadPairSecret(): Promise<string>; }
export interface PendingRequestPersistence { clearOnStartup(): Promise<void>; clear(): Promise<void>; save(record: PendingRequestRecord): Promise<void>; }
export interface SessionControlChannel {
  subscribe(listener: (event: ControlSessionEvent) => void): () => void;
  activate(context: ControlTrustContext): Promise<void>;
  deactivate(): Promise<void>;
  connect(endpoint: { host: string; port: number }): Promise<string>;
  send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage>;
  close(): Promise<void>;
}

export class SessionController {
  private state: SessionState = { type: 'Unpaired' };
  private readonly listeners = new Set<() => void>();
  private readonly mediaListeners = new Set<(message: AnyMediaControlMessage) => void>();
  private pair: PairTrustMetadata | null = null;
  private lastAvailability: AvailabilitySnapshot = { kind: 'inactive' };
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribeControl: () => void;

  constructor(
    private readonly identitySource: SessionIdentitySource,
    private readonly pairSecrets: SessionPairSecretSource,
    private readonly pendingStore: PendingRequestPersistence,
    private readonly control: SessionControlChannel,
    private readonly diagnostics: SessionDiagnostics,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.unsubscribeControl = control.subscribe((event) => { void this.enqueue(() => this.handleControlEvent(event)).catch(() => undefined); });
  }

  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  subscribeMedia = (listener: (message: AnyMediaControlMessage) => void): (() => void) => { this.mediaListeners.add(listener); return () => this.mediaListeners.delete(listener); };

  activatePair(pair: PairTrustMetadata): Promise<void> { return this.enqueue(async () => {
    const identity = (await this.identitySource.bootstrap()).identity;
    const secret = await this.pairSecrets.loadPairSecret();
    await this.pendingStore.clearOnStartup();
    this.pair = pair;
    await this.control.activate({ pairId: pair.pairId, localDeviceId: identity.deviceId, partnerDeviceId: pair.partnerDeviceId, pairSecretHex: secret });
    if (this.state.type === 'Unpaired' || isBasePairedState(this.state)) this.setState(this.baseState());
  }); }
  deactivatePair(): Promise<void> { return this.enqueue(async () => { this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.deactivate(); this.pair = null; this.lastAvailability = { kind: 'inactive' }; this.setState({ type: 'Unpaired' }); }); }
  updateAvailability(snapshot: AvailabilitySnapshot): void {
    this.lastAvailability = snapshot;
    // Availability may refresh cached reachability while Error is showing, but must never clear Error.
    // recoverProductError()/clearError() is the only explicit path out of Error.
    if (this.pair && isBasePairedState(this.state)) this.setState(this.baseState());
  }

  requestScreen(): Promise<void> { return this.enqueue(async () => {
    if (this.state.type !== 'PairedAvailable') throw new Error('The trusted partner is not currently available.');
    const pair = this.state.pair;
    try {
      const sessionId = await this.control.connect(this.state.endpoint);
      const expiresAt = new Date(this.nowMs() + CONTROL_REQUEST_TIMEOUT_MS).toISOString();
      await this.control.send('REQUEST_SCREEN', { expiresAt });
      this.setState({ type: 'OutgoingRequest', pair, sessionId, expiresAt });
      this.scheduleTimeout(sessionId, 'outgoing', CONTROL_REQUEST_TIMEOUT_MS);
      await this.record('session_requested');
    } catch {
      await this.record('control_transport_failed'); await this.control.close().catch(() => undefined);
      this.setState({ type: 'Error', pair, message: 'PartnerScreen could not open an authenticated request channel. Try again.' });
    }
  }); }
  acceptRequest(): Promise<void> { return this.enqueue(async () => { if (this.state.type !== 'IncomingRequest') return; const current = this.state; this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.send('ACCEPT_SCREEN', {}); this.setState({ type: 'Connected', pair: current.pair, sessionId: current.sessionId, role: 'sharer' }); await this.record('session_accepted'); await this.record('session_connected'); }); }
  declineRequest(): Promise<void> { return this.enqueue(async () => { if (this.state.type !== 'IncomingRequest') return; const pair = this.state.pair; this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.send('DECLINE_SCREEN', { reason: 'declined' }).catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_declined'); }); }
  cancelRequest(): Promise<void> { return this.enqueue(async () => { if (this.state.type !== 'OutgoingRequest') return; const pair = this.state.pair; this.clearTimeout(); await this.control.send('REQUEST_CANCEL', { reason: 'user' }).catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_cancelled'); }); }
  endSession(expectedSessionId?: string): Promise<void> { return this.enqueue(async () => { if (this.state.type !== 'Connected') return; if (expectedSessionId !== undefined && this.state.sessionId !== expectedSessionId) return; const pair = this.state.pair; await this.control.send('SESSION_END', { reason: 'user' }).catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_ended'); }); }
  captureDenied(expectedSessionId: string, reason: 'system_denied' | 'notifications_denied'): Promise<void> { return this.enqueue(async () => { if (this.state.type !== 'Connected' || this.state.role !== 'sharer' || this.state.sessionId !== expectedSessionId) return; const pair = this.state.pair; await this.control.send('CAPTURE_DENIED', { reason }).catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_ended'); }); }
  captureFailed(expectedSessionId: string, reason: 'capture_failed' | 'capture_revoked'): Promise<void> { return this.failConnectedSession(expectedSessionId, reason); }
  mediaFailed(expectedSessionId: string): Promise<void> { return this.failConnectedSession(expectedSessionId, 'media_failed'); }

  sendMedia<T extends MediaControlMessageType>(expectedSessionId: string, type: T, payload: ControlPayloadMap[T]): Promise<void> { return this.enqueue(async () => {
    if (this.state.type !== 'Connected' || this.state.sessionId !== expectedSessionId) throw new Error('Authenticated media signaling requires the active control session.');
    await this.control.send(type, payload);
  }); }

  clearError(): Promise<void> { return this.enqueue(async () => {
    if (this.state.type !== 'Error' || !this.pair) return;
    this.clearTimeout();
    await this.pendingStore.clear().catch(() => undefined);
    await this.control.close().catch(() => undefined);
    this.setState(this.baseState());
  }); }
  /** User-visible retry: clear error and return to accurate paired state (available vs offline). */
  recover(): Promise<void> { return this.clearError(); }
  dispose(): void { this.unsubscribeControl(); this.clearTimeout(); this.mediaListeners.clear(); }

  private failConnectedSession(expectedSessionId: string, reason: 'capture_failed' | 'capture_revoked' | 'media_failed'): Promise<void> { return this.enqueue(async () => {
    if (this.state.type !== 'Connected' || this.state.sessionId !== expectedSessionId) return;
    const pair = this.state.pair;
    await this.control.send('SESSION_ERROR', { reason }).catch(() => undefined);
    await this.control.close().catch(() => undefined);
    this.setState({ type: 'Error', pair, message: reason === 'capture_revoked' ? 'Android stopped screen sharing.' : reason === 'media_failed' ? 'PartnerScreen could not continue the private video connection.' : 'PartnerScreen could not continue screen sharing.' });
    await this.record('session_error');
  }); }

  private async handleControlEvent(event: ControlSessionEvent): Promise<void> {
    if (event.type === 'authenticated') return;
    // The local control listening socket was replaced (Wi-Fi host change / listener failure).
    // This is an availability concern, not a product-session terminal event.
    if (event.type === 'listener_changed') return;
    if (event.type === 'message') { await this.handleMessage(event.message); return; }
    if (event.type === 'error') {
      await this.record(event.code === 'auth_failed' ? 'control_auth_failed' : event.code === 'transport_failed' ? 'control_transport_failed' : 'session_error');
      if (this.state.type === 'OutgoingRequest' || this.state.type === 'IncomingRequest' || this.state.type === 'Connected') { const pair = this.state.pair; this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); }
      return;
    }
    if (this.state.type === 'OutgoingRequest' || this.state.type === 'IncomingRequest' || this.state.type === 'Connected') { const pair = this.state.pair; this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_ended'); }
  }

  private async handleMessage(message: AnyControlMessage): Promise<void> {
    const pair = this.pair; if (!pair) { await this.control.close().catch(() => undefined); return; }
    if (message.type === 'REQUEST_SCREEN') {
      if (!isBasePairedState(this.state)) { await this.control.send('DECLINE_SCREEN', { reason: 'busy' }).catch(() => undefined); await this.control.close().catch(() => undefined); await this.record('session_error'); return; }
      const remaining = Date.parse(message.payload.expiresAt) - this.nowMs();
      if (remaining <= 0 || remaining > CONTROL_REQUEST_TIMEOUT_MS + 5_000) { await this.control.send('SESSION_ERROR', { reason: 'timeout' }).catch(() => undefined); await this.control.close().catch(() => undefined); await this.record('session_timeout'); return; }
      await this.pendingStore.save({ schemaVersion: 1, sessionId: message.sessionId, partnerDeviceId: pair.partnerDeviceId, receivedAt: new Date(this.nowMs()).toISOString(), expiresAt: message.payload.expiresAt });
      this.setState({ type: 'IncomingRequest', pair, sessionId: message.sessionId, expiresAt: message.payload.expiresAt }); this.scheduleTimeout(message.sessionId, 'incoming', remaining); await this.record('session_request_received'); return;
    }
    // Stale events from a previous session must never affect a replacement session.
    // While a session is active (Outgoing/Incoming/Connected), any message with a non-matching sessionId
    // (except inbound REQUEST_SCREEN which is already handled as busy) is stale and must be ignored.
    if ((this.state.type === 'OutgoingRequest' || this.state.type === 'IncomingRequest' || this.state.type === 'Connected') && message.sessionId !== this.state.sessionId) {
      return;
    }
    if (message.type === 'REQUEST_CANCEL' && this.state.type === 'IncomingRequest' && this.state.sessionId === message.sessionId) { this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_cancelled'); return; }
    if (message.type === 'ACCEPT_SCREEN' && this.state.type === 'OutgoingRequest' && this.state.sessionId === message.sessionId) { this.clearTimeout(); this.setState({ type: 'Connected', pair, sessionId: message.sessionId, role: 'requester' }); await this.record('session_accepted'); await this.record('session_connected'); return; }
    if (message.type === 'DECLINE_SCREEN' && this.state.type === 'OutgoingRequest' && this.state.sessionId === message.sessionId) { this.clearTimeout(); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_declined'); return; }
    if (message.type === 'CAPTURE_DENIED' && this.state.type === 'Connected' && this.state.role === 'requester' && this.state.sessionId === message.sessionId) { await this.control.close().catch(() => undefined); const messageText = message.payload.reason === 'notifications_denied' ? 'The sharing phone did not allow the notification required for screen sharing.' : 'The sharing phone did not grant Android screen sharing permission.'; this.setState({ type: 'Error', pair, message: messageText }); await this.record('session_ended'); return; }
    if (isMediaControlMessageType(message.type)) {
      if (this.state.type === 'Connected' && this.state.sessionId === message.sessionId) { for (const listener of this.mediaListeners) listener(message as AnyMediaControlMessage); return; }
      await this.rejectInvalidTransition(pair); return;
    }
    if ((message.type === 'SESSION_END' || message.type === 'SESSION_ERROR') && (this.state.type === 'OutgoingRequest' || this.state.type === 'IncomingRequest' || this.state.type === 'Connected') && this.state.sessionId === message.sessionId) {
      this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.close().catch(() => undefined);
      const isCaptureOrMediaFailure = message.type === 'SESSION_ERROR' && ['capture_failed', 'capture_revoked', 'media_failed'].includes(message.payload.reason);
      this.setState(isCaptureOrMediaFailure ? { type: 'Error', pair, message: message.payload.reason === 'capture_revoked' ? 'Android stopped screen sharing on the other phone.' : message.payload.reason === 'media_failed' ? 'The private video connection stopped on the other phone.' : 'The other phone could not start screen sharing.' } : this.baseState(pair));
      await this.record(message.type === 'SESSION_ERROR' ? 'session_error' : 'session_ended'); return;
    }
    await this.rejectInvalidTransition(pair);
  }

  private async rejectInvalidTransition(pair: PairTrustMetadata): Promise<void> {
    await this.control.send('SESSION_ERROR', { reason: 'invalid_transition' }).catch(() => undefined); await this.control.close().catch(() => undefined); await this.pendingStore.clear().catch(() => undefined); this.clearTimeout(); this.setState(this.baseState(pair)); await this.record('session_error');
  }
  private scheduleTimeout(sessionId: string, direction: 'incoming' | 'outgoing', delayMs: number): void { this.clearTimeout(); this.timeoutHandle = setTimeout(() => { void this.enqueue(async () => { if ((this.state.type !== 'IncomingRequest' && this.state.type !== 'OutgoingRequest') || this.state.sessionId !== sessionId) return; const pair = this.state.pair; await this.pendingStore.clear().catch(() => undefined); if (direction === 'outgoing') await this.control.send('REQUEST_CANCEL', { reason: 'timeout' }).catch(() => undefined); else await this.control.send('SESSION_ERROR', { reason: 'timeout' }).catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_timeout'); }); }, Math.max(1, delayMs)); }
  private baseState(pairOverride?: PairTrustMetadata): SessionState { const pair = pairOverride ?? this.pair; if (!pair) return { type: 'Unpaired' }; if (this.lastAvailability.kind === 'available' && this.lastAvailability.pair.pairId === pair.pairId) return { type: 'PairedAvailable', pair, endpoint: this.lastAvailability.endpoint }; return { type: 'PairedOffline', pair }; }
  private clearTimeout(): void { if (this.timeoutHandle) clearTimeout(this.timeoutHandle); this.timeoutHandle = null; }
  private record(kind: DiagnosticEventKind): Promise<void> { return this.diagnostics.append(kind).catch(() => undefined); }
  private setState(next: SessionState): void { this.state = next; for (const listener of this.listeners) listener(); }
  private enqueue(operation: () => Promise<void>): Promise<void> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
}
