import { PartnerScreenTwin } from './PartnerScreenTwin';
import { settleMicrotasks } from './VirtualClock';

/**
 * Production controllers intentionally schedule future request/reconnect/stats timers.
 * A normal lab flush must never fast-forward through those timers implicitly: doing so
 * would turn a harmless 2-second stats poll into an infinite "run until idle" loop and,
 * worse, would hide deadline ownership bugs.
 *
 * Use advanceBy()/flushUntil() only when a scenario deliberately moves time forward.
 */
export class DeterministicPartnerScreenTwin extends PartnerScreenTwin {
  override async flush(maxCycles = 2_000): Promise<void> {
    let idleRounds = 0;
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      await settleMicrotasks();
      const next = this.clock.nextDueMs();
      if (next !== null && next <= this.clock.nowMs()) {
        idleRounds = 0;
        await this.clock.advanceTo(this.clock.nowMs());
        continue;
      }

      await Promise.all([this.alice.waitForPairLifecycle(), this.bob.waitForPairLifecycle()]);
      await settleMicrotasks();
      const after = this.clock.nextDueMs();
      if (after === null || after > this.clock.nowMs()) {
        idleRounds += 1;
        if (idleRounds >= 3) return;
      } else {
        idleRounds = 0;
      }
    }
    throw new Error('Deterministic PartnerScreen twin did not drain current-time work.');
  }

  override async flushUntil(predicate: () => boolean, maxCycles = 4_000): Promise<void> {
    let stagnantRounds = 0;
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      if (predicate()) return;
      await settleMicrotasks();
      if (predicate()) return;

      const next = this.clock.nextDueMs();
      if (next !== null) {
        stagnantRounds = 0;
        await this.clock.advanceTo(next);
        continue;
      }

      await Promise.all([this.alice.waitForPairLifecycle(), this.bob.waitForPairLifecycle()]);
      await settleMicrotasks();
      if (predicate()) return;
      if (this.clock.nextDueMs() === null) {
        stagnantRounds += 1;
        if (stagnantRounds >= 8) break;
      } else {
        stagnantRounds = 0;
      }
    }
    throw new Error('Deterministic PartnerScreen twin condition did not converge.');
  }
}
