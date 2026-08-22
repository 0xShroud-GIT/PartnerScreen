import { NativeModule, requireNativeModule } from 'expo';

declare class PartnerRuntimeLabModule extends NativeModule<Record<string, never>> {
  consumePairingQr(): Promise<string | null>;
}

export default requireNativeModule<PartnerRuntimeLabModule>('PartnerRuntimeLab');
