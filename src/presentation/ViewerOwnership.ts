/** One requester Viewer route per exact session. Reservation happens before navigation. */
export class ViewerOwnership {
  private sessionId: string | null = null;
  private phase: 'idle' | 'reserved' | 'mounted' = 'idle';

  reserve(sessionId: string): boolean {
    if (!sessionId) return false;
    if (this.phase !== 'idle') return false;
    this.sessionId = sessionId;
    this.phase = 'reserved';
    return true;
  }

  mount(sessionId: string): boolean {
    if (!sessionId) return false;
    if (this.phase === 'idle') {
      this.sessionId = sessionId;
      this.phase = 'mounted';
      return true;
    }
    if (this.sessionId !== sessionId || this.phase === 'mounted') return false;
    this.phase = 'mounted';
    return true;
  }

  release(sessionId: string): boolean {
    if (this.sessionId !== sessionId || this.phase === 'idle') return false;
    this.sessionId = null;
    this.phase = 'idle';
    return true;
  }

  cancelReservation(sessionId: string): boolean {
    if (this.sessionId !== sessionId || this.phase !== 'reserved') return false;
    this.sessionId = null;
    this.phase = 'idle';
    return true;
  }

  isOwner(sessionId: string): boolean {
    return this.sessionId === sessionId && this.phase === 'mounted';
  }

  isReservedOrOwner(sessionId: string): boolean {
    return this.sessionId === sessionId && this.phase !== 'idle';
  }

  getPhase(sessionId: string): 'idle' | 'reserved' | 'mounted' {
    return this.sessionId === sessionId ? this.phase : 'idle';
  }
}

export function requestViewerNavigation(sessionId: string, navigate: () => void): boolean {
  if (!viewerOwnership.reserve(sessionId)) return false;
  try {
    navigate();
    return true;
  } catch (error) {
    viewerOwnership.cancelReservation(sessionId);
    throw error;
  }
}

export const viewerOwnership = new ViewerOwnership();
