import { NativeModule, requireNativeModule } from 'expo';

declare class PartnerRequestNotificationModule extends NativeModule {
  showRequestNotification(sessionId: string, partnerName: string): Promise<boolean>;
  clearRequestNotification(): Promise<boolean>;
  hasNotificationPermission(): boolean;
}

export default requireNativeModule<PartnerRequestNotificationModule>('PartnerRequestNotification');
