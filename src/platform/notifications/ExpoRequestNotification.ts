import { PermissionsAndroid, Platform } from 'react-native';
import { canPromptNotificationPermission, type NotificationPermissionState } from '../../request/NotificationPermission';

export type IncomingRequestOpenEvent = { sessionId: string };

export interface RequestNotificationPort {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
  readPermissionState(): Promise<NotificationPermissionState>;
  requestPermissionFromForeground(): Promise<NotificationPermissionState>;
  consumeLaunchSessionId(): Promise<string | null>;
  subscribeOpened(listener: (sessionId: string) => void): () => void;
}

type NativeNotificationCapability = 'granted' | 'runtime_permission_required' | 'app_disabled' | 'channel_disabled';

type NativeModule = {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
  hasNotificationPermission(): boolean;
  notificationCapability?(): NativeNotificationCapability | string;
  consumeLaunchSessionId(): Promise<string | null>;
  addListener(eventName: 'onIncomingRequestOpened', listener: (event: IncomingRequestOpenEvent) => void): { remove(): void };
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
  private openedListeners = new Set<(sessionId: string) => void>();
  private nativeSub: { remove(): void } | null = null;
  private lastPromptResult: NotificationPermissionState | null = null;

  constructor() {
    const native = getNative();
    if (native?.addListener) {
      try {
        this.nativeSub = native.addListener('onIncomingRequestOpened', (event) => {
          if (typeof event?.sessionId === 'string' && event.sessionId.length > 0) {
            for (const listener of this.openedListeners) listener(event.sessionId);
          }
        });
      } catch {
        // ignore
      }
    }
  }

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

  async readPermissionState(): Promise<NotificationPermissionState> {
    if (Platform.OS !== 'android') return 'denied';
    const native = getNative();
    if (native?.notificationCapability) {
      try {
        const capability = native.notificationCapability();
        if (capability === 'granted') {
          this.lastPromptResult = null;
          return 'granted';
        }
        if (capability === 'channel_disabled') return 'channel_disabled';
        if (capability === 'app_disabled') return 'denied';
        if (capability === 'runtime_permission_required') {
          if (this.lastPromptResult === 'denied' || this.lastPromptResult === 'dismissed') return this.lastPromptResult;
          return 'requestable';
        }
      } catch {
        // Fall back to the React Native permission API below.
      }
    }

    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
    if (!Number.isFinite(apiLevel) || apiLevel < 33) return 'granted';
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    try {
      if (await PermissionsAndroid.check(permission)) {
        this.lastPromptResult = null;
        return 'granted';
      }
      if (this.lastPromptResult === 'denied' || this.lastPromptResult === 'dismissed') return this.lastPromptResult;
      return 'requestable';
    } catch {
      return 'unknown';
    }
  }

  async requestPermissionFromForeground(): Promise<NotificationPermissionState> {
    const current = await this.readPermissionState();
    if (current === 'granted') return current;
    if (!canPromptNotificationPermission(current)) return current;
    if (Platform.OS !== 'android') return 'denied';
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    try {
      const result = await PermissionsAndroid.request(permission);
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        this.lastPromptResult = null;
        return 'granted';
      }
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        this.lastPromptResult = 'denied';
        return 'denied';
      }
      this.lastPromptResult = 'dismissed';
      return 'dismissed';
    } catch {
      this.lastPromptResult = 'unknown';
      return 'unknown';
    }
  }

  async consumeLaunchSessionId(): Promise<string | null> {
    const native = getNative();
    if (!native?.consumeLaunchSessionId) return null;
    try {
      const sessionId = await native.consumeLaunchSessionId();
      return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
    } catch {
      return null;
    }
  }

  subscribeOpened(listener: (sessionId: string) => void): () => void {
    this.openedListeners.add(listener);
    return () => this.openedListeners.delete(listener);
  }

  dispose(): void {
    this.nativeSub?.remove();
    this.openedListeners.clear();
  }
}

export class NoopRequestNotification implements RequestNotificationPort {
  async showRequestNotification(): Promise<boolean> { return false; }
  async clearRequestNotification(): Promise<boolean> { return false; }
  async readPermissionState(): Promise<NotificationPermissionState> { return 'denied'; }
  async requestPermissionFromForeground(): Promise<NotificationPermissionState> { return 'denied'; }
  async consumeLaunchSessionId(): Promise<string | null> { return null; }
  subscribeOpened(): () => void { return () => undefined; }
}
