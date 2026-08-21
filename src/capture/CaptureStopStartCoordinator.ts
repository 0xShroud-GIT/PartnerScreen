const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CaptureServicePhase = 'idle' | 'starting' | 'capturing' | 'stopping';

export type CaptureStartDecision = 'start_now' | 'queue' | 'ignore';
export type CaptureStopFinishedDecision =
  | { action: 'restart'; sessionId: string }
  | { action: 'idle' };

export function isValidCaptureSessionId(sessionId: string | null | undefined): sessionId is string {
  return typeof sessionId === 'string' && SESSION_RE.test(sessionId);
}

/**
 * Deterministic Stop -> immediate Start queue.
 * Latest valid START while stopping wins. Stale session ownership is never reused.
 */
export class CaptureStopStartCoordinator {
  phase: CaptureServicePhase = 'idle';
  activeSessionId: string | null = null;
  pendingSessionId: string | null = null;

  onStart(sessionId: string | null | undefined): CaptureStartDecision {
    if (!isValidCaptureSessionId(sessionId)) return 'ignore';
    if (this.phase === 'stopping') {
      this.pendingSessionId = sessionId;
      return 'queue';
    }
    if (this.phase === 'starting' || this.phase === 'capturing') return 'ignore';
    this.phase = 'starting';
    this.activeSessionId = sessionId;
    this.pendingSessionId = null;
    return 'start_now';
  }

  onStarted(sessionId: string): boolean {
    if (this.phase !== 'starting' || this.activeSessionId !== sessionId) return false;
    this.phase = 'capturing';
    return true;
  }

  onStopBegin(): { previousSessionId: string | null } {
    const previousSessionId = this.activeSessionId;
    this.phase = 'stopping';
    this.activeSessionId = null;
    return { previousSessionId };
  }

  onStopFinished(): CaptureStopFinishedDecision {
    const next = this.pendingSessionId;
    this.pendingSessionId = null;
    if (next && isValidCaptureSessionId(next)) {
      this.phase = 'starting';
      this.activeSessionId = next;
      return { action: 'restart', sessionId: next };
    }
    this.phase = 'idle';
    this.activeSessionId = null;
    return { action: 'idle' };
  }

  isOwnedSession(sessionId: string | null | undefined): boolean {
    return this.activeSessionId !== null && this.activeSessionId === sessionId;
  }
}
