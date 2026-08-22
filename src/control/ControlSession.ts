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

export class ControlSession {
  private context: ControlTrustContext | null = null;
  private listenerEndpoint: ControlListenerEndpoint | null = null;
  private active: ActiveConnection | null = null;
  private readonly listeners = new Set<(event: ControlSessionEvent) => void>();
  private readonly listenerChangeListeners = new Set<() => void>();
  private readonly unsubscribeTransport: () => void;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly transport: ControlTransport, private readonly crypto: AuthenticatedSignalingCipher, private readonly nowMs: () => number = () => Date.now()) {
    this.unsubscribeTransport = transport.subscribe((event) => { void this.enqueue(() => this.handleTransportEvent(event)).catch(() => undefined); });
  }
  subscribe(listener: (event: ControlSessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Subscribers are notified whenever the local control listening socket is replaced/invalidated. */
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
  async ensureListening(expectedHost?: string): Promise<{ host: string; port: number }> { return this.enqueueResult(async () => { const endpoint = await this.ensureListeningNow(expectedHost); return { host: endpoint.host, port: endpoint.port }; }); }

  async connect(endpoint: { host: string; port: number }): Promise<string> {
    const context = this.requireContext(); await this.crypto.assertRuntimeCompatible(); if (this.active) throw new Error('A control session is already active.');
    const sessionId = this.crypto.randomId(), initiatorNonce = await this.crypto.randomNonceHex(), helloId = this.crypto.randomId();
    let resolveAuth!: (sessionId: string) => void, rejectAuth!: (error: Error) => void;
    const authenticated = new Promise<string>((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; });
    let connectionId: string;
    try { connectionId = await this.transport.connect(endpoint.host, endpoint.port); } catch (error) { throw error instanceof Error ? error : new Error('Control connection failed.'); }
    const active: ActiveConnection = { connectionId, role: 'initiator', sessionId, initiatorNonce, responderNonce: null, sessionKeyHex: null, validator: null, nextSendSequence: 1, handshakeTimer: null, authResolve: resolveAuth, authReject: rejectAuth };
    this.active = active;
    active.handshakeTimer = setTimeout(() => { void this.enqueue(async () => { if (this.active !== active || active.sessionKeyHex) return; active.authReject?.(new Error('Authenticated control handshake timed out.')); this.emit({ type: 'error', code: 'auth_failed' }); await this.closeActiveNow(); }); }, HANDSHAKE_TIMEOUT_MS);
    const unsigned: Omit<Hello1Frame, 'mac'> = { kind: 'hello1', version: CONTROL_PROTOCOL_VERSION, helloId, sessionId, senderDeviceId: context.localDeviceId, nonce: initiatorNonce, timestamp: new Date(this.nowMs()).toISOString() };
    const hello: Hello1Frame = { ...unsigned, mac: await this.crypto.hello1Mac(context.pairSecretHex, unsigned) };
    try { await this.transport.send(connectionId, encodeHandshakeFrame(hello)); } catch (error) { await this.closeActiveNow(); throw error; }
    return authenticated;
  }

  async send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> {
    return this.enqueueResult(async () => {
      const context = this.requireContext(), active = this.active;
      if (!active?.sessionId || !active.sessionKeyHex || !active.validator) throw new Error('Authenticated control session is not connected.');
      const message = { version: CONTROL_PROTOCOL_VERSION, messageId: this.crypto.randomId(), type, sessionId: active.sessionId, senderDeviceId: context.localDeviceId, sequence: active.nextSendSequence++, timestamp: new Date(this.nowMs()).toISOString(), payload } as AnyControlMessage;
      const sealed = await this.crypto.sealMessage(active.sessionKeyHex, message); await this.transport.send(active.connectionId, encodeSealedControlFrame(sealed)); return message;
    });
  }
  async close(): Promise<void> { await this.enqueue(() => this.closeActiveNow()); }
  dispose(): void { this.unsubscribeTransport(); void this.deactivate().catch(() => undefined); }

  private async handleTransportEvent(event: ControlTransportEvent): Promise<void> {
    if (event.type === 'error' && event.listenerId) {
      // Listener-scoped failure: invalidate ONLY the listener this failure belongs to. It must never
      // terminate an authenticated active connection, and a stale failure from an older listener must
      // never invalidate its replacement.
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
      if (!this.context || this.active) {
        // Rejecting an extra inbound connection is listener-level rejection of an unowned socket,
        // NOT a fatal event for the currently authenticated ControlSession. Never emit a session error.
        await this.transport.close(event.connectionId).catch(() => undefined);
        return;
      }
      const active: ActiveConnection = { connectionId: event.connectionId, role: 'responder', sessionId: null, initiatorNonce: null, responderNonce: null, sessionKeyHex: null, validator: null, nextSendSequence: 1, handshakeTimer: null, authResolve: null, authReject: null };
      this.active = active;
      active.handshakeTimer = setTimeout(() => { void this.enqueue(async () => { if (this.active !== active || active.sessionKeyHex) return; this.emit({ type: 'error', code: 'auth_failed' }); await this.closeActiveNow(); }); }, HANDSHAKE_TIMEOUT_MS);
      return;
    }
    if (event.type === 'message') { if (this.active && event.connectionId === this.active.connectionId) await this.handleFrame(event.frame); return; }
    if (event.type === 'closed') {
      if (!this.active || event.connectionId !== this.active.connectionId) return;
      const sessionId = this.active.sessionId; this.clearHandshake(this.active); this.active.authReject?.(new Error('Control connection closed before authentication.')); this.active = null; this.emit({ type: 'closed', sessionId }); return;
    }
    if (event.connectionId) {
      if (!this.active || event.connectionId !== this.active.connectionId) return;
      this.emit({ type: 'error', code: event.code === 'busy' ? 'busy' : 'transport_failed' });
      await this.closeActiveNow();
      return;
    }
    // Unscoped error: rejected-connection diagnostics. A rejected extra inbound ('busy') is never
    // fatal, and diagnostics must not tear down the owned authenticated connection.
    if (event.code === 'busy') return;
    if (this.active) return;
    this.emit({ type: 'error', code: 'transport_failed' });
  }

  private async handleFrame(frame: string): Promise<void> {
    const active = this.active, context = this.context; if (!active || !context) return;
    if (!active.sessionKeyHex) {
      try {
        const handshake = decodeHandshakeFrame(frame);
        if (active.role === 'responder' && handshake.kind === 'hello1') { await this.acceptHello1(active, context, handshake); return; }
        if (active.role === 'initiator' && handshake.kind === 'hello2') { await this.acceptHello2(active, context, handshake); return; }
      } catch { /* fail closed below */ }
      active.authReject?.(new Error('Authenticated control handshake was rejected.')); this.emit({ type: 'error', code: 'auth_failed' }); await this.closeActiveNow(); return;
    }
    try {
      const sealed = decodeSealedControlFrame(frame); const message = await this.crypto.openMessage(active.sessionKeyHex, sealed); const validation = active.validator?.validate(message);
      if (!validation?.ok) { this.emit({ type: 'error', code: 'invalid_message' }); await this.closeActiveNow(); return; }
      this.emit({ type: 'message', message });
    } catch { this.emit({ type: 'error', code: 'invalid_message' }); await this.closeActiveNow(); }
  }

  private async acceptHello1(active: ActiveConnection, context: ControlTrustContext, hello: Hello1Frame): Promise<void> {
    if (hello.senderDeviceId !== context.partnerDeviceId || !this.timestampFresh(hello.timestamp) || !(await this.crypto.verifyHello1(context.pairSecretHex, hello))) throw new Error('hello1 rejected');
    const responderNonce = await this.crypto.randomNonceHex();
    const unsigned: Omit<Hello2Frame, 'mac'> = { kind: 'hello2', version: CONTROL_PROTOCOL_VERSION, helloId: this.crypto.randomId(), sessionId: hello.sessionId, senderDeviceId: context.localDeviceId, nonce: responderNonce, echoNonce: hello.nonce, initiatorDeviceId: hello.senderDeviceId, timestamp: new Date(this.nowMs()).toISOString() };
    const response: Hello2Frame = { ...unsigned, mac: await this.crypto.hello2Mac(context.pairSecretHex, unsigned) };
    const key = await this.crypto.deriveSessionKey(context.pairSecretHex, { sessionId: hello.sessionId, initiatorDeviceId: hello.senderDeviceId, responderDeviceId: context.localDeviceId, initiatorNonce: hello.nonce, responderNonce });
    active.sessionId = hello.sessionId; active.initiatorNonce = hello.nonce; active.responderNonce = responderNonce; active.sessionKeyHex = key; active.validator = new MessageValidator(context.partnerDeviceId, hello.sessionId, this.nowMs); this.clearHandshake(active);
    await this.transport.send(active.connectionId, encodeHandshakeFrame(response)); this.emit({ type: 'authenticated', sessionId: hello.sessionId, role: 'responder' });
  }

  private async acceptHello2(active: ActiveConnection, context: ControlTrustContext, hello: Hello2Frame): Promise<void> {
    if (!active.sessionId || !active.initiatorNonce || hello.sessionId !== active.sessionId || hello.senderDeviceId !== context.partnerDeviceId || hello.initiatorDeviceId !== context.localDeviceId || hello.echoNonce !== active.initiatorNonce || !this.timestampFresh(hello.timestamp) || !(await this.crypto.verifyHello2(context.pairSecretHex, hello))) throw new Error('hello2 rejected');
    const key = await this.crypto.deriveSessionKey(context.pairSecretHex, { sessionId: active.sessionId, initiatorDeviceId: context.localDeviceId, responderDeviceId: context.partnerDeviceId, initiatorNonce: active.initiatorNonce, responderNonce: hello.nonce });
    active.responderNonce = hello.nonce; active.sessionKeyHex = key; active.validator = new MessageValidator(context.partnerDeviceId, active.sessionId, this.nowMs); this.clearHandshake(active); active.authResolve?.(active.sessionId); active.authResolve = null; active.authReject = null; this.emit({ type: 'authenticated', sessionId: active.sessionId, role: 'initiator' });
  }

  private timestampFresh(value: string): boolean { const timestamp = Date.parse(value); return !Number.isNaN(timestamp) && Math.abs(this.nowMs() - timestamp) <= CONTROL_TIMESTAMP_TOLERANCE_MS; }
  private requireContext(): ControlTrustContext { if (!this.context) throw new Error('Confirmed pair trust is required for control sessions.'); return this.context; }
  private async ensureListeningNow(expectedHost?: string): Promise<ControlListenerEndpoint> {
    this.requireContext();
    if (this.listenerEndpoint) {
      // Wi-Fi/control host change: if a specific host is required and the cached listener is bound to
      // a different host, stop ONLY the old listener and create a fresh one bound to the current host.
      // Listener ownership and connection ownership are separate: the active ControlSession is untouched.
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
  private async deactivateNow(): Promise<void> { await this.closeActiveNow(); const listener = this.listenerEndpoint; this.listenerEndpoint = null; if (listener) await this.transport.stopListener(listener.listenerId).catch(() => undefined); await this.transport.stopTrustedPresence?.().catch(() => undefined); this.context = null; }
  private async closeActiveNow(): Promise<void> { const active = this.active; if (!active) return; this.active = null; this.clearHandshake(active); active.authReject?.(new Error('Control session closed.')); active.authReject = null; active.authResolve = null; try { await this.transport.close(active.connectionId); } catch { /* best effort */ } }
  private clearHandshake(active: ActiveConnection): void { if (active.handshakeTimer) clearTimeout(active.handshakeTimer); active.handshakeTimer = null; }
  private enqueue(operation: () => Promise<void>): Promise<void> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
  private enqueueResult<T>(operation: () => Promise<T>): Promise<T> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
  private emit(event: ControlSessionEvent): void { for (const listener of this.listeners) listener(event); }
}
