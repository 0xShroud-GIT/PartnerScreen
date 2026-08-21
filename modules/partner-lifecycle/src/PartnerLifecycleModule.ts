import { NativeModule, requireNativeModule } from 'expo';

export type LifecycleEvent = { type: 'activity_started' | 'activity_resumed' | 'activity_paused' | 'activity_stopped' | 'activity_destroyed' };

declare class PartnerLifecycleModule extends NativeModule<{ onLifecycleEvent: (event: LifecycleEvent) => void }> {}

let cached: PartnerLifecycleModule | null = null;
function getModule(): PartnerLifecycleModule | null {
  try {
    if (!cached) cached = requireNativeModule<PartnerLifecycleModule>('PartnerLifecycle');
    return cached;
  } catch {
    return null;
  }
}

export default getModule();
