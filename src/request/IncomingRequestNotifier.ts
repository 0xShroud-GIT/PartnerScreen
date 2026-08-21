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
  private desiredGeneration = 0;
  private permissionAsked = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: SessionSource,
    private readonly notifications: NotificationPort,
    private readonly diagnostics: NotifierDiagnostics,
  ) {
    this.unsubscribe = this.session.subscribe(() => {
      const generation = this.bumpGeneration();
      void this.enqueue(() => this.sync(generation));
    });
    const generation = this.bumpGeneration();
    void this.enqueue(() => this.sync(generation));
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  dispose(): void {
    this.unsubscribe();
    this.bumpGeneration();
    if (this.activeSessionId) {
      void this.notifications.clearRequestNotification().catch(() => undefined);
      this.activeSessionId = null;
    }
  }

  private bumpGeneration(): number {
    this.desiredGeneration += 1;
    return this.desiredGeneration;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.desiredGeneration;
  }

  private async sync(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const state = this.session.getSnapshot();

    if ((isBasePairedState(state) || state.type === 'IncomingRequest') && !this.permissionAsked) {
      this.permissionAsked = true;
      await this.notifications.ensurePermission().catch(() => false);
      if (!this.isCurrent(generation)) return;
    }

    if (state.type === 'IncomingRequest') {
      if (this.activeSessionId === state.sessionId) return;
      const sessionId = state.sessionId;
      const partnerName = state.pair.partnerDeviceName;
      await this.notifications.ensurePermission().catch(() => false);
      if (!this.isCurrent(generation)) return;
      const shown = await this.notifications.showRequestNotification(sessionId, partnerName).catch(() => false);
      if (!this.isCurrent(generation)) {
        await this.reconcileNative();
        return;
      }
      const latest = this.session.getSnapshot();
      if (latest.type !== 'IncomingRequest' || latest.sessionId !== sessionId) {
        await this.reconcileNative();
        return;
      }
      this.activeSessionId = sessionId;
      if (shown) await this.diagnostics.append('notification_shown').catch(() => undefined);
      return;
    }

    if (this.activeSessionId) {
      await this.notifications.clearRequestNotification().catch(() => undefined);
      if (!this.isCurrent(generation)) {
        await this.reconcileNative();
        return;
      }
      const latest = this.session.getSnapshot();
      if (latest.type === 'IncomingRequest') return;
      this.activeSessionId = null;
      await this.diagnostics.append('notification_cleared').catch(() => undefined);
    }
  }

  private async reconcileNative(): Promise<void> {
    const latest = this.session.getSnapshot();
    if (latest.type === 'IncomingRequest') {
      // Latest queued generation owns the show. A stale generation must not commit or overwrite.
      return;
    }
    await this.notifications.clearRequestNotification().catch(() => undefined);
    this.activeSessionId = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
