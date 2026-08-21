export interface RuntimeTimer {
  cancel(): void;
}

export interface RuntimeScheduler {
  schedule(delayMs: number, task: () => void): RuntimeTimer;
}

/** Production scheduler. Tests inject VirtualClock, which is structurally compatible. */
export const systemRuntimeScheduler: RuntimeScheduler = {
  schedule(delayMs: number, task: () => void): RuntimeTimer {
    const handle = setTimeout(task, Math.max(0, Math.floor(delayMs)));
    return { cancel: () => clearTimeout(handle) };
  },
};
