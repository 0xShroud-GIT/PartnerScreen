export type LifecycleEventType = 'activity_started' | 'activity_resumed' | 'activity_paused' | 'activity_stopped' | 'activity_destroyed';

export interface LifecyclePort {
  subscribe(listener: (event: { type: LifecycleEventType }) => void): () => void;
}

type NativeModule = {
  addListener(eventName: 'onLifecycleEvent', listener: (event: { type: LifecycleEventType }) => void): { remove(): void };
};

let cached: NativeModule | null = null;
function getNative(): NativeModule | null {
  if (cached !== null) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../modules/partner-lifecycle').default as unknown as NativeModule | null;
    cached = mod;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export class ExpoLifecycle implements LifecyclePort {
  subscribe(listener: (event: { type: LifecycleEventType }) => void): () => void {
    const native = getNative();
    if (!native) return () => undefined;
    try {
      const sub = native.addListener('onLifecycleEvent', listener);
      return () => sub.remove();
    } catch {
      return () => undefined;
    }
  }
}

export class NoopLifecycle implements LifecyclePort {
  subscribe(): () => void { return () => undefined; }
}
