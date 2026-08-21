import { NativeModule, requireNativeModule } from 'expo';

export type IncomingRequestOpenedEvent = { sessionId: string };

declare class PartnerRequestNotificationModule extends NativeModule<{ onIncomingRequestOpened: (event: IncomingRequestOpenedEvent) => void }> {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
  hasNotificationPermission(): boolean;
  consumeLaunchSessionId(): Promise<string | null>;
  addListener(eventName: 'onIncomingRequestOpened', listener: (event: IncomingRequestOpenedEvent) => void): { remove(): void };
}

export default requireNativeModule<PartnerRequestNotificationModule>('PartnerRequestNotification');
