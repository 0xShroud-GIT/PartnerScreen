export interface RequestNotificationPort {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
}

type NativeModule = {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
};

let cached: NativeModule | null = null;
function getNative(): NativeModule | null {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../modules/partner-request-notification').default as NativeModule;
    cached = mod;
    return cached;
  } catch {
    return null;
  }
}

export class ExpoRequestNotification implements RequestNotificationPort {
  async showRequestNotification(sessionId: string, partnerName: string): Promise<boolean> {
    const native = getNative();
    if (!native) return false;
    try {
      return await native.showRequestNotification(sessionId, partnerName);
    } catch {
      return false;
    }
  }

  async clearRequestNotification(): Promise<boolean> {
    const native = getNative();
    if (!native) return false;
    try {
      return await native.clearRequestNotification();
    } catch {
      return false;
    }
  }
}

export class NoopRequestNotification implements RequestNotificationPort {
  async showRequestNotification(): Promise<boolean> { return false; }
  async clearRequestNotification(): Promise<boolean> { return false; }
}
