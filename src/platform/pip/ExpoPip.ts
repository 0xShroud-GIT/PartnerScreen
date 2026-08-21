export type PipMode = { isInPictureInPictureMode: boolean };

export interface PipPort {
  enterPip(width: number, height: number): Promise<boolean>;
  isInPip(): Promise<boolean>;
  supportsPip(): boolean;
  subscribe(listener: (event: PipMode) => void): () => void;
}

type NativeModule = {
  enterPip(width: number, height: number): Promise<boolean>;
  isInPip(): Promise<boolean>;
  supportsPip(): boolean;
  addListener(eventName: 'onPipModeChanged', listener: (event: PipMode) => void): { remove(): void };
};

let cached: NativeModule | null = null;
function getNative(): NativeModule | null {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../modules/partner-pip').default as NativeModule;
    cached = mod;
    return cached;
  } catch {
    return null;
  }
}

export class ExpoPip implements PipPort {
  private listeners = new Set<(event: PipMode) => void>();
  private nativeSub: { remove(): void } | null = null;

  constructor() {
    const native = getNative();
    if (native) {
      try {
        this.nativeSub = native.addListener('onPipModeChanged', (event) => {
          for (const listener of this.listeners) listener(event);
        });
      } catch {
        // ignore
      }
    }
  }

  async enterPip(width: number, height: number): Promise<boolean> {
    const native = getNative();
    if (!native) return false;
    try { return await native.enterPip(width, height); } catch { return false; }
  }

  async isInPip(): Promise<boolean> {
    const native = getNative();
    if (!native) return false;
    try { return await native.isInPip(); } catch { return false; }
  }

  supportsPip(): boolean {
    const native = getNative();
    if (!native) return false;
    try { return native.supportsPip(); } catch { return false; }
  }

  subscribe(listener: (event: PipMode) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.nativeSub?.remove();
    this.listeners.clear();
  }
}

export class NoopPip implements PipPort {
  async enterPip(): Promise<boolean> { return false; }
  async isInPip(): Promise<boolean> { return false; }
  supportsPip(): boolean { return false; }
  subscribe(): () => void { return () => undefined; }
}
