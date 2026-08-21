import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import { isBasePairedState, type SessionState } from '../session/SessionState';

export interface NotificationPort {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
  ensurePermission(): Promise<boolean>;
}

export interface NotifierDiagnostics {
  append(kind: DiagnosticEventKind): Promise<void>;
}

export interface SessionSource {
  getSnapshot(): SessionState;
  subscribe(listener: () => void): () => void;
}

export class IncomingRequestNotifier {
  private activeSessionId: string | null = null;
  private generation = 0;
  private permissionAsked = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: SessionSource,
    private readonly notifications: NotificationPort,
    private readonly diagnostics: NotifierDiagnostics,
  ) {
    this.unsubscribe = this.session.subscribe(() => {
      void this.enqueue(() => this.sync());
    });
    void this.enqueue(() => this.sync());
  }

  dispose(): void {
    this.unsubscribe();
    this.generation += 1;
    if (this.activeSessionId) {
      void this.notifications.clearRequestNotification().catch(() => undefined);
      this.activeSessionId = null;
    }
  }

  private async sync(): Promise<void> {
    const generation = ++this.generation;
    const state = this.session.getSnapshot();

    if ((isBasePairedState(state) || state.type === 'IncomingRequest') && !this.permissionAsked) {
      this.permissionAsked = true;
      await this.notifications.ensurePermission().catch(() => false);
      if (generation !== this.generation) return;
    }

    if (state.type === 'IncomingRequest') {
      if (this.activeSessionId === state.sessionId) return;
      const sessionId = state.sessionId;
      const partnerName = state.pair.partnerDeviceName;
      await this.notifications.ensurePermission().catch(() => false);
      if (generation !== this.generation) return;
      const shown = await this.notifications.showRequestNotification(sessionId, partnerName).catch(() => false);
      if (generation !== this.generation) {
        await this.reconcileNative(sessionId);
        return;
      }
      this.activeSessionId = sessionId;
      if (shown) await this.diagnostics.append('notification_shown').catch(() => undefined);
      return;
    }

    if (this.activeSessionId) {
      this.activeSessionId = null;
      try {
        await this.notifications.clearRequestNotification();
        if (generation !== this.generation) return;
        await this.diagnostics.append('notification_cleared').catch(() => undefined);
      } catch {
        // best effort
      }
    }
  }

  private async reconcileNative(attemptedSessionId: string): Promise<void> {
    const current = this.session.getSnapshot();
    if (current.type === 'IncomingRequest' && current.sessionId === attemptedSessionId) return;
    if (current.type !== 'IncomingRequest') {
      await this.notifications.clearRequestNotification().catch(() => undefined);
      this.activeSessionId = null;
      return;
    }
    await this.notifications.showRequestNotification(current.sessionId, current.pair.partnerDeviceName).catch(() => undefined);
    this.activeSessionId = current.sessionId;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
