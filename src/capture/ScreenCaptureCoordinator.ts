import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { SessionState } from '../session/SessionState';
import type { ScreenCaptureNativeEvent, ScreenCapturePort } from './ScreenCapturePort';

export type ScreenCaptureState =
  | { type: 'idle' }
  | { type: 'requesting_consent'; sessionId: string }
  | { type: 'starting'; sessionId: string }
  | { type: 'capturing'; sessionId: string }
  | { type: 'error'; message: string };

export interface CaptureDiagnostics { append(kind: DiagnosticEventKind): Promise<void>; }
export interface CaptureSessionAuthority {
  getSnapshot(): SessionState;
  subscribe(listener: () => void): () => void;
  captureDenied(sessionId: string, reason: 'system_denied' | 'notifications_denied'): Promise<void>;
  captureFailed(sessionId: string, reason: 'capture_failed' | 'capture_revoked'): Promise<void>;
  /** Terminate the product session ONLY when the current Connected session is exactly expectedSessionId. */
  endSession(expectedSessionId: string): Promise<void>;
}

export class ScreenCaptureCoordinator {
  private state: ScreenCaptureState = { type: 'idle' };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeNative: () => void;
  private readonly unsubscribeSession: () => void;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: ScreenCapturePort,
    private readonly session: CaptureSessionAuthority,
    private readonly diagnostics: CaptureDiagnostics,
  ) {
    this.unsubscribeNative = port.subscribe((event) => { void this.enqueue(() => this.handleNativeEvent(event)).catch(() => undefined); });
    this.unsubscribeSession = session.subscribe(() => { void this.enqueue(() => this.handleSessionState()).catch(() => undefined); });
  }

  getSnapshot = (): ScreenCaptureState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  /** True only while the product session is still the exact Connected sharer this coordinator started for. */
  private isOwnedSharerSession(expectedSessionId: string): boolean {
    const session = this.session.getSnapshot();
    return session.type === 'Connected' && session.role === 'sharer' && session.sessionId === expectedSessionId;
  }

  requestForConnectedSharer(): Promise<void> {
    return this.enqueue(async () => {
      const session = this.session.getSnapshot();
      if (session.type !== 'Connected' || session.role !== 'sharer') throw new Error('Screen capture requires an accepted sharer session.');
      const expectedSessionId = session.sessionId;
      if (this.state.type !== 'idle' && this.state.type !== 'error') {
        if (this.state.sessionId === expectedSessionId) throw new Error('Screen capture is already active.');
        await this.port.stop().catch(() => undefined);
        this.setState({ type: 'idle' });
      }
      this.setState({ type: 'requesting_consent', sessionId: expectedSessionId });
      await this.record('capture_consent_requested');

      // POST_NOTIFICATIONS is not required to start a MediaProjection FGS or accept an in-app request.
      // ensureNotificationPermission() remains on the capture port for explicit notification setup only.
      const granted = await this.port.requestConsent().catch(() => false);
      // Re-check AFTER the MediaProjection consent await (grant OR denial): an old permission result
      // must never terminate a replacement session.
      if (!this.isOwnedSharerSession(expectedSessionId)) { this.setState({ type: 'idle' }); return; }
      if (!granted) {
        await this.record('capture_consent_denied');
        this.setState({ type: 'error', message: 'Android screen sharing permission was not granted.' });
        await this.session.captureDenied(expectedSessionId, 'system_denied');
        return;
      }

      this.setState({ type: 'starting', sessionId: expectedSessionId });
      try { await this.port.start(expectedSessionId); }
      catch {
        if (!this.isOwnedSharerSession(expectedSessionId)) { this.setState({ type: 'idle' }); return; }
        await this.record('capture_failed');
        this.setState({ type: 'error', message: 'PartnerScreen could not start Android screen sharing.' });
        await this.session.captureFailed(expectedSessionId, 'capture_failed');
      }
    });
  }

  stopSharing(): Promise<void> {
    return this.enqueue(async () => {
      const session = this.session.getSnapshot();
      const sharerSessionId = session.type === 'Connected' && session.role === 'sharer' ? session.sessionId : null;
      if (this.state.type === 'idle') {
        // The UI promises that Stop sharing ends the active session, even with no native capture
        // active (e.g. consent not yet granted). End the exact current sharer session locally.
        if (sharerSessionId) await this.session.endSession(sharerSessionId);
        return;
      }
      const expectedSessionId = this.state.type === 'error' ? null : this.state.sessionId;
      try { await this.port.stop(); }
      catch {
        await this.record('capture_failed');
        this.setState({ type: 'error', message: 'PartnerScreen could not stop screen sharing cleanly.' });
        if (expectedSessionId) await this.session.captureFailed(expectedSessionId, 'capture_failed');
      }
      // Local-first: end the exact current sharer session now; a later native 'stopped' event is a
      // no-op (coordinator already idle) or a session-scoped no-op.
      if (sharerSessionId) await this.session.endSession(sharerSessionId);
    });
  }

  clearError(): void { if (this.state.type === 'error') this.setState({ type: 'idle' }); }
  resetToIdle(): Promise<void> {
    return this.enqueue(async () => {
      const wasIdle = this.state.type === 'idle';
      if (!wasIdle) await this.port.stop().catch(() => undefined);
      this.setState({ type: 'idle' });
    });
  }

  dispose(): void {
    this.unsubscribeNative();
    this.unsubscribeSession();
    this.listeners.clear();
  }

  private async handleNativeEvent(event: ScreenCaptureNativeEvent): Promise<void> {
    if (event.type === 'starting') return;
    // Stale-event gate: a capture event must belong to the exact capture session this coordinator
    // owns. An event from capture attempt A can never mutate replacement session B.
    if (this.state.type === 'idle' || this.state.type === 'error' || event.sessionId !== this.state.sessionId) return;
    const session = this.session.getSnapshot();
    if (event.type === 'started') {
      if (!this.isOwnedSharerSession(event.sessionId)) {
        await this.port.stop().catch(() => undefined);
        this.setState({ type: 'idle' });
        return;
      }
      this.setState({ type: 'capturing', sessionId: event.sessionId });
      await this.record('capture_started');
      return;
    }
    if (event.type === 'stopped') {
      this.setState({ type: 'idle' });
      await this.record('capture_stopped');
      if (this.isOwnedSharerSession(event.sessionId)) await this.session.endSession(event.sessionId);
      return;
    }
    if (event.type === 'revoked') {
      this.setState({ type: 'error', message: 'Android stopped screen sharing.' });
      await this.record('capture_revoked');
      if (this.isOwnedSharerSession(event.sessionId)) await this.session.captureFailed(event.sessionId, 'capture_revoked');
      return;
    }
    this.setState({ type: 'error', message: 'PartnerScreen could not continue Android screen sharing.' });
    await this.record('capture_failed');
    if (this.isOwnedSharerSession(event.sessionId)) await this.session.captureFailed(event.sessionId, 'capture_failed');
  }

  private async handleSessionState(): Promise<void> {
    const session = this.session.getSnapshot();
    if (this.state.type === 'idle') return;
    const currentId = this.state.type === 'error' ? null : this.state.sessionId;
    const ownsThis = session.type === 'Connected' && session.role === 'sharer' && currentId === session.sessionId;
    if (ownsThis) return;
    await this.port.stop().catch(() => undefined);
    this.setState({ type: 'idle' });
  }

  private record(kind: DiagnosticEventKind): Promise<void> { return this.diagnostics.append(kind).catch(() => undefined); }
  private setState(next: ScreenCaptureState): void { this.state = next; for (const listener of this.listeners) listener(); }
  private enqueue(operation: () => Promise<void>): Promise<void> { const result = this.operationQueue.then(operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
}
