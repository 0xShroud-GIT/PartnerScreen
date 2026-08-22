export interface LabTimer {
  cancel(): void;
}

type ScheduledTask = {
  id: number;
  dueMs: number;
  order: number;
  cancelled: boolean;
  task: () => void;
};

/**
 * Deterministic scheduler used by the Runtime Laboratory.
 *
 * It is structurally compatible with MediaRecoveryScheduler and can be passed
 * directly to production controllers that already accept a scheduler. Tests
 * advance logical time explicitly; wall-clock sleeps are never required.
 */
export class VirtualClock {
  private currentMs: number;
  private nextId = 1;
  private nextOrder = 1;
  private readonly tasks: ScheduledTask[] = [];

  constructor(startMs = Date.parse('2026-08-22T00:00:00.000Z')) {
    this.currentMs = startMs;
  }

  nowMs = (): number => this.currentMs;
  nowDate = (): Date => new Date(this.currentMs);

  schedule(delayMs: number, task: () => void): LabTimer {
    const item: ScheduledTask = {
      id: this.nextId++,
      dueMs: this.currentMs + Math.max(0, Math.floor(delayMs)),
      order: this.nextOrder++,
      cancelled: false,
      task,
    };
    this.tasks.push(item);
    return {
      cancel: () => {
        item.cancelled = true;
      },
    };
  }

  pendingCount(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }

  nextDueMs(): number | null {
    const next = this.nextTask();
    return next?.dueMs ?? null;
  }

  async advanceBy(deltaMs: number): Promise<void> {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error('Virtual time cannot move backwards.');
    await this.advanceTo(this.currentMs + Math.floor(deltaMs));
  }

  async advanceTo(targetMs: number): Promise<void> {
    if (!Number.isFinite(targetMs) || targetMs < this.currentMs) throw new Error('Virtual time cannot move backwards.');

    while (true) {
      const next = this.nextTask();
      if (!next || next.dueMs > targetMs) break;
      this.removeTask(next.id);
      if (next.cancelled) continue;
      this.currentMs = next.dueMs;
      next.task();
      await settleMicrotasks();
    }

    this.currentMs = targetMs;
    await settleMicrotasks();
  }

  async runUntilIdle(maxTasks = 20_000): Promise<void> {
    let executed = 0;
    while (true) {
      const next = this.nextTask();
      if (!next) break;
      if (++executed > maxTasks) throw new Error(`VirtualClock exceeded ${maxTasks} scheduled tasks.`);
      await this.advanceTo(next.dueMs);
    }
    await settleMicrotasks();
  }

  cancelAll(): void {
    for (const task of this.tasks) task.cancelled = true;
    this.tasks.length = 0;
  }

  private nextTask(): ScheduledTask | null {
    let best: ScheduledTask | null = null;
    for (const task of this.tasks) {
      if (task.cancelled) continue;
      if (!best || task.dueMs < best.dueMs || (task.dueMs === best.dueMs && task.order < best.order)) best = task;
    }
    return best;
  }

  private removeTask(id: number): void {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index >= 0) this.tasks.splice(index, 1);
  }
}

export async function settleMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
