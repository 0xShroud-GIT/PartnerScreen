export interface KeepAwakePort {
  enable(): Promise<boolean>;
  disable(): Promise<boolean>;
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
  async enable(): Promise<boolean> {
    const native = getNative();
    if (!native) return false;
    try { return await native.enable(); } catch { return false; }
  }
  async disable(): Promise<boolean> {
    const native = getNative();
    if (!native) return false;
    try { return await native.disable(); } catch { return false; }
  }
}

export class NoopKeepAwake implements KeepAwakePort {
  async enable(): Promise<boolean> { return false; }
  async disable(): Promise<boolean> { return false; }
}
