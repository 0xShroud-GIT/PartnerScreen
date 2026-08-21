import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { SessionState } from '../session/SessionState';

export interface NotificationPort {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
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
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: SessionSource,
    private readonly notifications: NotificationPort,
    private readonly diagnostics: NotifierDiagnostics,
  ) {
    this.unsubscribe = this.session.subscribe(() => {
      void this.sync();
    });
    void this.sync();
  }

  dispose(): void {
    this.unsubscribe();
    if (this.activeSessionId) {
      void this.notifications.clearRequestNotification().catch(() => undefined);
      this.activeSessionId = null;
    }
  }

  private async sync(): Promise<void> {
    const state = this.session.getSnapshot();
    if (state.type === 'IncomingRequest') {
      if (this.activeSessionId === state.sessionId) return;
      this.activeSessionId = state.sessionId;
      try {
        const shown = await this.notifications.showRequestNotification(state.sessionId, state.pair.partnerDeviceName);
        if (shown) await this.diagnostics.append('notification_shown').catch(() => undefined);
      } catch {
        // Notification failure must not fail the session; remain visible in-app.
      }
      return;
    }
    if (this.activeSessionId) {
      const previous = this.activeSessionId;
      this.activeSessionId = null;
      try {
        await this.notifications.clearRequestNotification();
        await this.diagnostics.append('notification_cleared').catch(() => undefined);
      } catch {
        // best effort
      }
      // Also handle case where we were showing for `previous` but state moved to other type
      void previous;
    }
  }
}
