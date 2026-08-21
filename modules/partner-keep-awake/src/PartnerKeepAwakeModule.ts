import { NativeModule, requireNativeModule } from 'expo';

declare class PartnerKeepAwakeModule extends NativeModule {
  enable(): Promise<boolean>;
  disable(): Promise<boolean>;
  isEnabled(): boolean;
}

export default requireNativeModule<PartnerKeepAwakeModule>('PartnerKeepAwake');
