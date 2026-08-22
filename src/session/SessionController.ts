import type { AvailabilitySnapshot } from '../availability/AvailabilityService';
import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { PairTrustMetadata } from '../domain/pairing/PairTrustRepository';
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  isMediaControlMessageType,
  type AnyControlMessage,
  type AnyMediaControlMessage,
  type ControlMessageType,
  type ControlPayloadMap,
  type MediaControlMessageType,
} from '../protocol/ControlMessage';
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
  updateReconnectEndpoint?(endpoint: { host: string; port: number }): void;
  send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage>;
  close(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;
type ActiveProductState = Extract<SessionState, { type: 'OutgoingRequest' | 'IncomingRequest' | 'Connected' }>;
function isActiveProductState(state: SessionState): state is ActiveProductState {
  return state.type === 'OutgoingRequest' || state.type === 'IncomingRequest' || state.type === 'Connected';
}

export class SessionController {
  private state: SessionState = { type: 'Unpaired' };
  private readonly listeners = new Set<() => void>();
  private readonly mediaListeners = new Set<(message: AnyMediaControlMessage) => void>();
  private pair: PairTrustMetadata | null = null;
  private lastAvailability: AvailabilitySnapshot = { kind: 'inactive' };
  private timeoutHandle: Timer | null = null;
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
    this.unsubscribeControl = control.subscribe((event) => void this.enqueue(() => this.handleControlEvent(event)).catch(() => undefined));
  }

  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  subscribeMedia = (listener: (message: AnyMediaControlMessage) => void): (() => void) => { this.mediaListeners.add(listener); return () => this.mediaListeners.delete(listener); };

  activatePair(pair: PairTrustMetadata): Promise<void> {
    return this.enqueue(async () => {
      const identity = (await this.identitySource.bootstrap()).identity;
      const secret = await this.pairSecrets.loadPairSecret();
      await this.pendingStore.clearOnStartup();
      this.pair = pair;
      await this.control.activate({ pairId: pair.pairId, localDeviceId: identity.deviceId, partnerDeviceId: pair.partnerDeviceId, pairSecretHex: secret });
      if (this.state.type === 'Unpaired' || isBasePairedState(this.state)) this.setState(this.baseState());
    });
  }

  deactivatePair(): Promise<void> {
    return this.enqueue(async () => {
      this.clearTimeout();
      await this.pendingStore.clear().catch(() => undefined);
      await this.control.deactivate();
      this.pair = null;
      this.lastAvailability = { kind: 'inactive' };
      this.setState({ type: 'Unpaired' });
    });
  }

  updateAvailability(snapshot: AvailabilitySnapshot): void {
    this.lastAvailability = snapshot;
    if (snapshot.kind === 'available') this.control.updateReconnectEndpoint?.(snapshot.endpoint);
    if (this.pair && isBasePairedState(this.state)) this.setState(this.baseState());
  }

  requestScreen(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.state;
      if (current.type !== 'PairedAvailable') throw new Error('The trusted partner is not currently available.');
      const pair = current.pair;
      try {
        const sessionId = await this.control.connect(current.endpoint);
        const expiresAt = new Date(this.nowMs() + CONTROL_REQUEST_TIMEOUT_MS).toISOString();
        await this.control.send('REQUEST_SCREEN', { expiresAt });
        this.setState({ type: 'OutgoingRequest', pair, sessionId, expiresAt });
        this.scheduleTimeout(sessionId, 'outgoing', CONTROL_REQUEST_TIMEOUT_MS);
        await this.record('session_requested');
      } catch {
        await this.record('control_transport_failed');
        await this.control.close().catch(() => undefined);
        this.setState({ type: 'Error', pair, message: 'Chirp could not open an authenticated request channel. Try again.' });
      }
    });
  }

  acceptRequest(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.state;
      if (current.type !== 'IncomingRequest') return;
      this.clearTimeout();
      await this.pendingStore.clear().catch(() => undefined);
      await this.control.send('ACCEPT_SCREEN', {});
      this.setState({ type: 'Connected', pair: current.pair, sessionId: current.sessionId, role: 'sharer' });
      await this.record('session_accepted');
      await this.record('session_connected');
    });
  }

  declineRequest(): Promise<void> { return this.finishRequest('IncomingRequest', 'DECLINE_SCREEN', { reason: 'declined' }, 'session_declined'); }
  cancelRequest(): Promise<void> { return this.finishRequest('OutgoingRequest', 'REQUEST_CANCEL', { reason: 'user' }, 'session_cancelled'); }

  endSession(expectedSessionId?: string): Promise<void> {
    return this.enqueue(async () => {
      const current = this.state;
      if (current.type !== 'Connected') return;
      if (expectedSessionId !== undefined && current.sessionId !== expectedSessionId) return;
      await this.control.send('SESSION_END', { reason: 'user' }).catch(() => undefined);
      await this.control.close().catch(() => undefined);
      this.setState(this.baseState(current.pair));
      await this.record('session_ended');
    });
  }

  captureDenied(expectedSessionId: string, reason: 'system_denied' | 'notifications_denied'): Promise<void> {
    return this.enqueue(async () => {
      const current = this.state;
      if (current.type !== 'Connected' || current.role !== 'sharer' || current.sessionId !== expectedSessionId) return;
      await this.control.send('CAPTURE_DENIED', { reason }).catch(() => undefined);
      await this.control.close().catch(() => undefined);
      this.setState(this.baseState(current.pair));
      await this.record('session_ended');
    });
  }

  captureFailed(expectedSessionId: string, reason: 'capture_failed' | 'capture_revoked'): Promise<void> { return this.failConnectedSession(expectedSessionId, reason); }
  mediaFailed(expectedSessionId: string): Promise<void> { return this.failConnectedSession(expectedSessionId, 'media_failed'); }

  sendMedia<T extends MediaControlMessageType>(expectedSessionId: string, type: T, payload: ControlPayloadMap[T]): Promise<void> {
    return this.enqueue(async () => {
      const current = this.state;
      if (current.type !== 'Connected' || current.sessionId !== expectedSessionId) throw new Error('Authenticated media signaling requires the active session.');
      await this.control.send(type, payload);
    });
  }

  clearError(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.type !== 'Error' || !this.pair) return;
      this.clearTimeout();
      await this.pendingStore.clear().catch(() => undefined);
      await this.control.close().catch(() => undefined);
      this.setState(this.baseState());
    });
  }

  recover(): Promise<void> { return this.clearError(); }
  dispose(): void { this.unsubscribeControl(); this.clearTimeout(); this.mediaListeners.clear(); }

  private finishRequest<T extends 'DECLINE_SCREEN' | 'REQUEST_CANCEL'>(expected: 'IncomingRequest' | 'OutgoingRequest', type: T, payload: ControlPayloadMap[T], diagnostic: DiagnosticEventKind): Promise<void> {
    return this.enqueue(async () => {
      const current = this.state;
      if (current.type !== expected) return;
      this.clearTimeout();
      await this.pendingStore.clear().catch(() => undefined);
      await this.control.send(type, payload).catch(() => undefined);
      await this.control.close().catch(() => undefined);
      this.setState(this.baseState(current.pair));
      await this.record(diagnostic);
    });
  }

  private failConnectedSession(expectedSessionId: string, reason: 'capture_failed' | 'capture_revoked' | 'media_failed'): Promise<void> {
    return this.enqueue(async () => {
      const current = this.state;
      if (current.type !== 'Connected' || current.sessionId !== expectedSessionId) return;
      await this.control.send('SESSION_ERROR', { reason }).catch(() => undefined);
      await this.control.close().catch(() => undefined);
      const message = reason === 'capture_revoked' ? 'Android stopped screen sharing.' : reason === 'media_failed' ? 'Chirp could not continue the private video connection.' : 'Chirp could not continue screen sharing.';
      this.setState({ type: 'Error', pair: current.pair, message });
      await this.record('session_error');
    });
  }

  private async handleControlEvent(event: ControlSessionEvent): Promise<void> {
    if (event.type === 'authenticated' || event.type === 'reconnecting' || event.type === 'reconnected' || event.type === 'listener_changed') return;
    if (event.type === 'message') { await this.handleMessage(event.message); return; }
    if (event.type === 'error') {
      await this.record(event.code === 'auth_failed' ? 'control_auth_failed' : event.code === 'transport_failed' ? 'control_transport_failed' : 'session_error');
      const current = this.state;
      if (isActiveProductState(current)) {
        this.clearTimeout();
        await this.pendingStore.clear().catch(() => undefined);
        await this.control.close().catch(() => undefined);
        this.setState(this.baseState(current.pair));
      }
      return;
    }
    if (event.type === 'closed') {
      const current = this.state;
      if (!isActiveProductState(current)) return;
      this.clearTimeout();
      await this.pendingStore.clear().catch(() => undefined);
      this.setState(this.baseState(current.pair));
      await this.record('session_ended');
    }
  }

  private async handleMessage(message: AnyControlMessage): Promise<void> {
    const pair = this.pair;
    if (!pair) { await this.control.close().catch(() => undefined); return; }

    if (message.type === 'REQUEST_SCREEN') {
      if (!isBasePairedState(this.state)) {
        await this.control.send('DECLINE_SCREEN', { reason: 'busy' }).catch(() => undefined);
        await this.control.close().catch(() => undefined);
        return;
      }
      const remaining = Date.parse(message.payload.expiresAt) - this.nowMs();
      if (remaining <= 0 || remaining > CONTROL_REQUEST_TIMEOUT_MS + 5_000) {
        await this.control.send('SESSION_ERROR', { reason: 'timeout' }).catch(() => undefined);
        await this.control.close().catch(() => undefined);
        await this.record('session_timeout');
        return;
      }
      await this.pendingStore.save({ schemaVersion: 1, sessionId: message.sessionId, partnerDeviceId: pair.partnerDeviceId, receivedAt: new Date(this.nowMs()).toISOString(), expiresAt: message.payload.expiresAt });
      this.setState({ type: 'IncomingRequest', pair, sessionId: message.sessionId, expiresAt: message.payload.expiresAt });
      this.scheduleTimeout(message.sessionId, 'incoming', remaining);
      await this.record('session_request_received');
      return;
    }

    const active = this.state;
    if (isActiveProductState(active) && message.sessionId !== active.sessionId) return;

    if (message.type === 'REQUEST_CANCEL' && this.state.type === 'IncomingRequest') {
      this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_cancelled'); return;
    }
    if (message.type === 'ACCEPT_SCREEN' && this.state.type === 'OutgoingRequest') {
      this.clearTimeout(); this.setState({ type: 'Connected', pair, sessionId: message.sessionId, role: 'requester' }); await this.record('session_accepted'); await this.record('session_connected'); return;
    }
    if (message.type === 'DECLINE_SCREEN' && this.state.type === 'OutgoingRequest') {
      this.clearTimeout(); await this.control.close().catch(() => undefined); this.setState(this.baseState(pair)); await this.record('session_declined'); return;
    }
    if (message.type === 'CAPTURE_DENIED' && this.state.type === 'Connected' && this.state.role === 'requester') {
      await this.control.close().catch(() => undefined);
      this.setState({ type: 'Error', pair, message: message.payload.reason === 'notifications_denied' ? 'The sharing phone could not run screen sharing.' : 'The sharing phone did not grant Android screen sharing permission.' });
      await this.record('session_ended'); return;
    }
    if (isMediaControlMessageType(message.type)) {
      if (this.state.type === 'Connected') { for (const listener of this.mediaListeners) listener(message as AnyMediaControlMessage); return; }
      await this.rejectInvalidTransition(pair); return;
    }
    if (message.type === 'SESSION_END' || message.type === 'SESSION_ERROR') {
      const current = this.state;
      if (!isActiveProductState(current)) { await this.rejectInvalidTransition(pair); return; }
      this.clearTimeout(); await this.pendingStore.clear().catch(() => undefined); await this.control.close().catch(() => undefined);
      const failed = message.type === 'SESSION_ERROR' && ['capture_failed', 'capture_revoked', 'media_failed'].includes(message.payload.reason);
      this.setState(failed ? { type: 'Error', pair, message: 'The other phone could not continue screen sharing.' } : this.baseState(pair));
      await this.record(message.type === 'SESSION_ERROR' ? 'session_error' : 'session_ended'); return;
    }
    await this.rejectInvalidTransition(pair);
  }

  private async rejectInvalidTransition(pair: PairTrustMetadata): Promise<void> {
    await this.control.send('SESSION_ERROR', { reason: 'invalid_transition' }).catch(() => undefined);
    await this.control.close().catch(() => undefined);
    await this.pendingStore.clear().catch(() => undefined);
    this.clearTimeout();
    this.setState(this.baseState(pair));
    await this.record('session_error');
  }

  private scheduleTimeout(sessionId: string, direction: 'incoming' | 'outgoing', delayMs: number): void {
    this.clearTimeout();
    this.timeoutHandle = setTimeout(() => {
      void this.enqueue(async () => {
        const current = this.state;
        if ((current.type !== 'IncomingRequest' && current.type !== 'OutgoingRequest') || current.sessionId !== sessionId) return;
        await this.pendingStore.clear().catch(() => undefined);
        if (direction === 'outgoing') await this.control.send('REQUEST_CANCEL', { reason: 'timeout' }).catch(() => undefined);
        else await this.control.send('SESSION_ERROR', { reason: 'timeout' }).catch(() => undefined);
        await this.control.close().catch(() => undefined);
        this.setState(this.baseState(current.pair));
        await this.record('session_timeout');
      }).catch(() => undefined);
    }, Math.max(1, delayMs));
  }

  private baseState(pairOverride?: PairTrustMetadata): SessionState {
    const pair = pairOverride ?? this.pair;
    if (!pair) return { type: 'Unpaired' };
    if (this.lastAvailability.kind === 'available' && this.lastAvailability.pair.pairId === pair.pairId) return { type: 'PairedAvailable', pair, endpoint: this.lastAvailability.endpoint };
    return { type: 'PairedOffline', pair };
  }

  private clearTimeout(): void { if (this.timeoutHandle) clearTimeout(this.timeoutHandle); this.timeoutHandle = null; }
  private record(kind: DiagnosticEventKind): Promise<void> { return this.diagnostics.append(kind).catch(() => undefined); }
  private setState(next: SessionState): void { this.state = next; for (const listener of this.listeners) listener(); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
}
