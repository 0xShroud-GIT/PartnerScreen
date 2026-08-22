export interface RuntimeTimer { cancel(): void; }
export interface RuntimeScheduler { schedule(delayMs: number, task: () => void): RuntimeTimer; }

export const systemRuntimeScheduler: RuntimeScheduler = {
  schedule(delayMs, task) {
    const handle = setTimeout(task, Math.max(1, delayMs));
    return { cancel: () => clearTimeout(handle) };
  },
};
