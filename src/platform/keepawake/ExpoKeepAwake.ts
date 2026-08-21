export interface KeepAwakePort {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

type NativeModule = {
  enable(): Promise<boolean>;
  disable(): Promise<boolean>;
};

let cached: NativeModule | null = null;
function getNative(): NativeModule | null {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../modules/partner-keep-awake').default as NativeModule;
    cached = mod;
    return cached;
  } catch {
    return null;
  }
}

export class ExpoKeepAwake implements KeepAwakePort {
  async enable(): Promise<void> {
    const native = getNative();
    if (!native) return;
    try { await native.enable(); } catch { /* best effort */ }
  }
  async disable(): Promise<void> {
    const native = getNative();
    if (!native) return;
    try { await native.disable(); } catch { /* best effort */ }
  }
}

export class NoopKeepAwake implements KeepAwakePort {
  async enable(): Promise<void> {}
  async disable(): Promise<void> {}
}
