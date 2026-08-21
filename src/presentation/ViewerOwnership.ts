/** One requester Viewer owner per exact session. Navigation must be idempotent. */
export class ViewerOwnership {
  private sessionId: string | null = null;
  private refs = 0;

  claim(sessionId: string): boolean {
    if (this.sessionId && this.sessionId !== sessionId) return false;
    this.sessionId = sessionId;
    this.refs += 1;
    return this.refs === 1;
  }

  release(sessionId: string): boolean {
    if (this.sessionId !== sessionId || this.refs === 0) return false;
    this.refs -= 1;
    if (this.refs === 0) {
      this.sessionId = null;
      return true;
    }
    return false;
  }

  isOwner(sessionId: string): boolean {
    return this.sessionId === sessionId && this.refs > 0;
  }
}

export const viewerOwnership = new ViewerOwnership();
