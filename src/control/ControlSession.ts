import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_TIMESTAMP_TOLERANCE_MS,
  type AnyControlMessage,
  type ControlMessageType,
  type ControlPayloadMap,
  type Hello1Frame,
  type Hello2Frame,
} from '../protocol/ControlMessage';
import { decodeHandshakeFrame, decodeSealedControlFrame, encodeHandshakeFrame, encodeSealedControlFrame } from '../protocol/ControlCodec';
import { AuthenticatedSignalingCipher } from '../security/AuthenticatedSignalingCipher';
import type { ControlListenerEndpoint, ControlTransport, ControlTransportEvent } from '../platform/control/ControlTransport';
import { MessageValidator } from './MessageValidator';

export interface ControlTrustContext { pairId: string; localDeviceId: string; partnerDeviceId: string; pairSecretHex: string; }
export type ControlSessionEvent =
  | { type: 'authenticated'; sessionId: string; role: 'initiator' | 'responder' }
  | { type: 'reconnecting'; sessionId: string; role: 'initiator' | 'responder'; attempt: number }
  | { type: 'reconnected'; sessionId: string; role: 'initiator' | 'responder' }
  | { type: 'message'; message: AnyControlMessage }
  | { type: 'closed'; sessionId: string | null }
  | { type: 'error'; code: 'busy' | 'auth_failed' | 'transport_failed' | 'invalid_message' }
  | { type: 'listener_changed' };

interface ActiveConnection {
  connectionId: string;
  role: 'initiator' | 'responder';
  sessionId: string | null;
  initiatorNonce: string | null;
  responderNonce: string | null;
  sessionKeyHex: string | null;
  validator: MessageValidator | null;
  nextSendSequence: number;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  authResolve: ((sessionId: string) => void) | null;
  authReject: ((error: Error) => void) | null;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [350, 900, 1_800] as const;
const RESPONDER_RECONNECT_WINDOW_MS = 12_000;

export class ControlSession {
  private context: ControlTrustContext | null = null;
  private listenerEndpoint: ControlListenerEndpoint | null = null;
  private active: ActiveConnection | null = null;
  private outboundEndpoint: { host: string; port: number } | null = null;
  private resumeSessionId: string | null = null;
  private resumeRole: 'initiator' | 'responder' | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private responderReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(event: ControlSessionEvent) => void>();
  private readonly listenerChangeListeners = new Set<() => void>();
  private readonly unsubscribeTransport: () => void;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: ControlTransport,
    private readonly crypto: AuthenticatedSignalingCipher,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.unsubscribeTransport = transport.subscribe((event) => {
      void this.enqueue(() => this.handleTransportEvent(event)).catch(() => undefined);
    });
  }

  subscribe(listener: (event: ControlSessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeListenerChanges(listener: () => void): () => void { this.listenerChangeListeners.add(listener); return () => this.listenerChangeListeners.delete(listener); }

  async activate(context: ControlTrustContext): Promise<void> {
    await this.enqueue(async () => {
      const same = this.context?.pairId === context.pairId && this.context.localDeviceId === context.localDeviceId && this.context.partnerDeviceId === context.partnerDeviceId;
      if (!same) await this.deactivateNow();
      this.context = { ...context, pairSecretHex: context.pairSecretHex.toLowerCase() };
      await this.crypto.assertRuntimeCompatible();
      await this.transport.startTrustedPresence?.().catch(() => undefined);
      await this.ensureListeningNow();
    });
  }

  async deactivate(): Promise<void> { await this.enqueue(() => this.deactivateNow()); }

  async ensureListening(expectedHost?: string): Promise<{ host: string; port: number }> {
    return this.enqueueResult(async () => {
      const endpoint = await this.ensureListeningNow(expectedHost);
      return { host: endpoint.host, port: endpoint.port };
    });
  }

  async connect(endpoint: { host: string; port: number }): Promise<string> {
    const context = this.requireContext();
    await this.crypto.assertRuntimeCompatible();
    if (this.active || this.resumeSessionId) throw new Error('A control session is already active.');
    this.outboundEndpoint = endpoint;
    const sessionId = this.crypto.randomId();
    const authenticated = this.openInitiator(endpoint, sessionId, context, true);
    return authenticated;
  }

  async send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> {
    return this.enqueueResult(async () => {
      const context = this.requireContext();
      const active = this.active;
      if (!active?.sessionId || !active.sessionKeyHex || !active.validator) {
        if (this.resumeSessionId) throw new Error('Authenticated control session is reconnecting.');
        throw new Error('Authenticated control session is not connected.');
      }
      const message = {
        version: CONTROL_PROTOCOL_VERSION,
        messageId: this.crypto.randomId(),
        type,
        sessionId: active.sessionId,
        senderDeviceId: context.localDeviceId,
        sequence: active.nextSendSequence++,
        timestamp: new Date(this.nowMs()).toISOString(),
        payload,
      } as AnyControlMessage;
      const sealed = await this.crypto.sealMessage(active.sessionKeyHex, message);
      try {
        await this.transport.send(active.connectionId, encodeSealedControlFrame(sealed));
      } catch (error) {
        await this.beginReconnect(active);
        throw error;
      }
      return message;
    });
  }

  async close(): Promise<void> { await this.enqueue(() => this.closeActiveNow(true)); }
  dispose(): void { this.unsubscribeTransport(); void this.deactivate().catch(() => undefined); }

  private async openInitiator(
    endpoint: { host: string; port: number },
    sessionId: string,
    context: ControlTrustContext,
    awaitAuthentication: boolean,
  ): Promise<string> {
    const initiatorNonce = await this.crypto.randomNonceHex();
    const helloId = this.crypto.randomId();
    let resolveAuth: ((sessionId: string) => void) | null = null;
    let rejectAuth: ((error: Error) => void) | null = null;
    const authenticated = awaitAuthentication
      ? new Promise<string>((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; })
      : Promise.resolve(sessionId);

    const connectionId = await this.transport.connect(endpoint.host, endpoint.port);
    const active: ActiveConnection = {
      connectionId,
      role: 'initiator',
      sessionId,
      initiatorNonce,
      responderNonce: null,
      sessionKeyHex: null,
      validator: null,
      nextSendSequence: 1,
      handshakeTimer: null,
      authResolve: resolveAuth,
      authReject: rejectAuth,
    };
    this.active = active;
    this.armHandshakeTimeout(active);
    const unsigned: Omit<Hello1Frame, 'mac'> = {
      kind: 'hello1', version: CONTROL_PROTOCOL_VERSION, helloId, sessionId,
      senderDeviceId: context.localDeviceId, nonce: initiatorNonce,
      timestamp: new Date(this.nowMs()).toISOString(),
    };
    const hello: Hello1Frame = { ...unsigned, mac: await this.crypto.hello1Mac(context.pairSecretHex, unsigned) };
    try {
      await this.transport.send(connectionId, encodeHandshakeFrame(hello));
    } catch (error) {
      await this.beginReconnect(active);
      if (awaitAuthentication) rejectAuth?.(error instanceof Error ? error : new Error('Control handshake failed.'));
      throw error;
    }
    return authenticated;
  }

  private armHandshakeTimeout(active: ActiveConnection): void {
    this.clearHandshake(active);
    active.handshakeTimer = setTimeout(() => {
      void this.enqueue(async () => {
        if (this.active !== active || active.sessionKeyHex) return;
        active.authReject?.(new Error('Authenticated control handshake timed out.'));
        if (this.resumeSessionId) {
          await this.transport.close(active.connectionId).catch(() => undefined);
          if (this.active === active) this.active = null;
          if (active.role === 'initiator') this.scheduleInitiatorReconnect();
          return;
        }
        this.emit({ type: 'error', code: 'auth_failed' });
        await this.closeActiveNow(false);
      }).catch(() => undefined);
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private async handleTransportEvent(event: ControlTransportEvent): Promise<void> {
    if (event.type === 'error' && event.listenerId) {
      const owned = this.listenerEndpoint;
      if (owned && event.listenerId === owned.listenerId) {
        this.listenerEndpoint = null;
        this.emit({ type: 'listener_changed' });
        for (const listener of this.listenerChangeListeners) listener();
      }
      return;
    }

    if (event.type === 'connected') {
      if (event.direction === 'outbound') return;
      if (!this.context || this.active || this.resumeRole === 'initiator') {
        await this.transport.close(event.connectionId).catch(() => undefined);
        return;
      }
      const active: ActiveConnection = {
        connectionId: event.connectionId,
        role: 'responder',
        sessionId: this.resumeSessionId,
        initiatorNonce: null,
        responderNonce: null,
        sessionKeyHex: null,
        validator: null,
        nextSendSequence: 1,
        handshakeTimer: null,
        authResolve: null,
        authReject: null,
      };
      this.active = active;
      this.armHandshakeTimeout(active);
      return;
    }

    if (event.type === 'message') {
      if (this.active && event.connectionId === this.active.connectionId) await this.handleFrame(event.frame);
      return;
    }

    if (event.type === 'closed') {
      if (!this.active || event.connectionId !== this.active.connectionId) return;
      const active = this.active;
      if (active.sessionKeyHex && active.sessionId) await this.beginReconnect(active);
      else {
        this.clearHandshake(active);
        active.authReject?.(new Error('Control connection closed before authentication.'));
        this.active = null;
        if (this.resumeSessionId && active.role === 'initiator') this.scheduleInitiatorReconnect();
        else if (!this.resumeSessionId) this.emit({ type: 'closed', sessionId: active.sessionId });
      }
      return;
    }

    if (event.connectionId) {
      if (!this.active || event.connectionId !== this.active.connectionId) return;
      const active = this.active;
      if (event.code === 'busy' && !active.sessionKeyHex) {
        active.authReject?.(new Error('Partner is busy.'));
        await this.closeActiveNow(false);
        this.emit({ type: 'error', code: 'busy' });
      } else if (active.sessionKeyHex && active.sessionId) {
        await this.beginReconnect(active);
      } else if (this.resumeSessionId) {
        await this.transport.close(active.connectionId).catch(() => undefined);
        this.active = null;
        this.scheduleInitiatorReconnect();
      } else {
        this.emit({ type: 'error', code: 'transport_failed' });
        await this.closeActiveNow(false);
      }
      return;
    }

    if (event.code === 'busy' || this.active || this.resumeSessionId) return;
    this.emit({ type: 'error', code: 'transport_failed' });
  }

  private async beginReconnect(active: ActiveConnection): Promise<void> {
    if (!active.sessionId || this.resumeSessionId) return;
    const sessionId = active.sessionId;
    const role = active.role;
    this.clearHandshake(active);
    this.active = null;
    active.authReject?.(new Error('Control transport interrupted.'));
    await this.transport.close(active.connectionId).catch(() => undefined);
    this.resumeSessionId = sessionId;
    this.resumeRole = role;
    this.reconnectAttempt = 0;
    this.emit({ type: 'reconnecting', sessionId, role, attempt: 1 });
    if (role === 'initiator') this.scheduleInitiatorReconnect();
    else this.armResponderReconnectWindow();
  }

  private scheduleInitiatorReconnect(): void {
    if (!this.resumeSessionId || this.resumeRole !== 'initiator' || this.reconnectTimer) return;
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      void this.enqueue(() => this.failReconnect()).catch(() => undefined);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    const attempt = this.reconnectAttempt + 1;
    this.reconnectAttempt = attempt;
    this.emit({ type: 'reconnecting', sessionId: this.resumeSessionId, role: 'initiator', attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.enqueue(async () => {
        const context = this.context;
        const endpoint = this.outboundEndpoint;
        const sessionId = this.resumeSessionId;
        if (!context || !endpoint || !sessionId || this.resumeRole !== 'initiator' || this.active) return;
        try {
          await this.openInitiator(endpoint, sessionId, context, false);
        } catch {
          this.scheduleInitiatorReconnect();
        }
      }).catch(() => undefined);
    }, delay);
  }

  private armResponderReconnectWindow(): void {
    if (this.responderReconnectTimer) clearTimeout(this.responderReconnectTimer);
    this.responderReconnectTimer = setTimeout(() => {
      this.responderReconnectTimer = null;
      void this.enqueue(() => this.failReconnect()).catch(() => undefined);
    }, RESPONDER_RECONNECT_WINDOW_MS);
  }

  private async failReconnect(): Promise<void> {
    const sessionId = this.resumeSessionId;
    if (!sessionId) return;
    this.clearReconnectState();
    this.emit({ type: 'error', code: 'transport_failed' });
    this.emit({ type: 'closed', sessionId });
  }

  private async handleFrame(frame: string): Promise<void> {
    const active = this.active;
    const context = this.context;
    if (!active || !context) return;
    if (!active.sessionKeyHex) {
      try {
        const handshake = decodeHandshakeFrame(frame);
        if (active.role === 'responder' && handshake.kind === 'hello1') { await this.acceptHello1(active, context, handshake); return; }
        if (active.role === 'initiator' && handshake.kind === 'hello2') { await this.acceptHello2(active, context, handshake); return; }
      } catch { /* fail closed below */ }
      active.authReject?.(new Error('Authenticated control handshake was rejected.'));
      if (this.resumeSessionId) {
        await this.transport.close(active.connectionId).catch(() => undefined);
        if (this.active === active) this.active = null;
        if (active.role === 'initiator') this.scheduleInitiatorReconnect();
        return;
      }
      this.emit({ type: 'error', code: 'auth_failed' });
      await this.closeActiveNow(false);
      return;
    }

    try {
      const sealed = decodeSealedControlFrame(frame);
      const message = await this.crypto.openMessage(active.sessionKeyHex, sealed);
      const validation = active.validator?.validate(message);
      if (!validation?.ok) {
        this.emit({ type: 'error', code: 'invalid_message' });
        await this.closeActiveNow(false);
        return;
      }
      this.emit({ type: 'message', message });
    } catch {
      this.emit({ type: 'error', code: 'invalid_message' });
      await this.closeActiveNow(false);
    }
  }

  private async acceptHello1(active: ActiveConnection, context: ControlTrustContext, hello: Hello1Frame): Promise<void> {
    if (this.resumeSessionId && hello.sessionId !== this.resumeSessionId) throw new Error('wrong resume session');
    if (hello.senderDeviceId !== context.partnerDeviceId || !this.timestampFresh(hello.timestamp) || !(await this.crypto.verifyHello1(context.pairSecretHex, hello))) throw new Error('hello1 rejected');
    const responderNonce = await this.crypto.randomNonceHex();
    const unsigned: Omit<Hello2Frame, 'mac'> = {
      kind: 'hello2', version: CONTROL_PROTOCOL_VERSION, helloId: this.crypto.randomId(), sessionId: hello.sessionId,
      senderDeviceId: context.localDeviceId, nonce: responderNonce, echoNonce: hello.nonce,
      initiatorDeviceId: hello.senderDeviceId, timestamp: new Date(this.nowMs()).toISOString(),
    };
    const response: Hello2Frame = { ...unsigned, mac: await this.crypto.hello2Mac(context.pairSecretHex, unsigned) };
    const key = await this.crypto.deriveSessionKey(context.pairSecretHex, {
      sessionId: hello.sessionId,
      initiatorDeviceId: hello.senderDeviceId,
      responderDeviceId: context.localDeviceId,
      initiatorNonce: hello.nonce,
      responderNonce,
    });
    active.sessionId = hello.sessionId;
    active.initiatorNonce = hello.nonce;
    active.responderNonce = responderNonce;
    active.sessionKeyHex = key;
    active.validator = new MessageValidator(context.partnerDeviceId, hello.sessionId, this.nowMs);
    active.nextSendSequence = 1;
    this.clearHandshake(active);
    await this.transport.send(active.connectionId, encodeHandshakeFrame(response));
    if (this.resumeSessionId) {
      this.clearReconnectState();
      this.emit({ type: 'reconnected', sessionId: hello.sessionId, role: 'responder' });
    } else {
      this.emit({ type: 'authenticated', sessionId: hello.sessionId, role: 'responder' });
    }
  }

  private async acceptHello2(active: ActiveConnection, context: ControlTrustContext, hello: Hello2Frame): Promise<void> {
    if (!active.sessionId || !active.initiatorNonce || hello.sessionId !== active.sessionId || hello.senderDeviceId !== context.partnerDeviceId || hello.initiatorDeviceId !== context.localDeviceId || hello.echoNonce !== active.initiatorNonce || !this.timestampFresh(hello.timestamp) || !(await this.crypto.verifyHello2(context.pairSecretHex, hello))) throw new Error('hello2 rejected');
    const key = await this.crypto.deriveSessionKey(context.pairSecretHex, {
      sessionId: active.sessionId,
      initiatorDeviceId: context.localDeviceId,
      responderDeviceId: context.partnerDeviceId,
      initiatorNonce: active.initiatorNonce,
      responderNonce: hello.nonce,
    });
    active.responderNonce = hello.nonce;
    active.sessionKeyHex = key;
    active.validator = new MessageValidator(context.partnerDeviceId, active.sessionId, this.nowMs);
    active.nextSendSequence = 1;
    this.clearHandshake(active);
    active.authResolve?.(active.sessionId);
    active.authResolve = null;
    active.authReject = null;
    if (this.resumeSessionId) {
      const sessionId = active.sessionId;
      this.clearReconnectState();
      this.emit({ type: 'reconnected', sessionId, role: 'initiator' });
    } else {
      this.emit({ type: 'authenticated', sessionId: active.sessionId, role: 'initiator' });
    }
  }

  private timestampFresh(value: string): boolean {
    const timestamp = Date.parse(value);
    return !Number.isNaN(timestamp) && Math.abs(this.nowMs() - timestamp) <= CONTROL_TIMESTAMP_TOLERANCE_MS;
  }

  private requireContext(): ControlTrustContext {
    if (!this.context) throw new Error('Confirmed pair trust is required for control sessions.');
    return this.context;
  }

  private async ensureListeningNow(expectedHost?: string): Promise<ControlListenerEndpoint> {
    this.requireContext();
    if (this.listenerEndpoint) {
      if (expectedHost === undefined || this.listenerEndpoint.host === expectedHost) return this.listenerEndpoint;
      const stale = this.listenerEndpoint;
      this.listenerEndpoint = null;
      await this.transport.stopListener(stale.listenerId).catch(() => undefined);
      this.emit({ type: 'listener_changed' });
      for (const listener of this.listenerChangeListeners) listener();
    }
    this.listenerEndpoint = await this.transport.startListener();
    return this.listenerEndpoint;
  }

  private async deactivateNow(): Promise<void> {
    await this.closeActiveNow(true);
    const listener = this.listenerEndpoint;
    this.listenerEndpoint = null;
    if (listener) await this.transport.stopListener(listener.listenerId).catch(() => undefined);
    await this.transport.stopTrustedPresence?.().catch(() => undefined);
    this.context = null;
    this.outboundEndpoint = null;
  }

  private async closeActiveNow(clearReconnect: boolean): Promise<void> {
    if (clearReconnect) this.clearReconnectState();
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.clearHandshake(active);
    active.authReject?.(new Error('Control session closed.'));
    active.authReject = null;
    active.authResolve = null;
    try { await this.transport.close(active.connectionId); } catch { /* best effort */ }
  }

  private clearReconnectState(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.responderReconnectTimer) clearTimeout(this.responderReconnectTimer);
    this.reconnectTimer = null;
    this.responderReconnectTimer = null;
    this.resumeSessionId = null;
    this.resumeRole = null;
    this.reconnectAttempt = 0;
  }

  private clearHandshake(active: ActiveConnection): void {
    if (active.handshakeTimer) clearTimeout(active.handshakeTimer);
    active.handshakeTimer = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private emit(event: ControlSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
