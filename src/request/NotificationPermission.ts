export type NotificationPermissionState =
  | 'unknown'
  | 'requestable'
  | 'prompting'
  | 'granted'
  | 'denied'
  | 'dismissed'
  | 'channel_disabled';

export interface NotificationPermissionPort {
  readState(): Promise<NotificationPermissionState>;
  requestFromForeground(): Promise<NotificationPermissionState>;
}

export function canPromptNotificationPermission(state: NotificationPermissionState): boolean {
  return state === 'unknown' || state === 'requestable' || state === 'dismissed';
}

export function notificationsAreAvailable(state: NotificationPermissionState): boolean {
  return state === 'granted';
}
