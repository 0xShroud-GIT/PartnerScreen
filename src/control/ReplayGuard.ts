const MAX_REPLAY_IDS = 256;

export class ReplayGuard {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private lastSequence = 0;

  accept(messageId: string, sequence: number): boolean {
    if (this.seen.has(messageId)) return false;
    if (sequence !== this.lastSequence + 1) return false;
    this.lastSequence = sequence;
    this.seen.add(messageId);
    this.order.push(messageId);
    while (this.order.length > MAX_REPLAY_IDS) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  reset(): void {
    this.seen.clear();
    this.order.length = 0;
    this.lastSequence = 0;
  }
}
