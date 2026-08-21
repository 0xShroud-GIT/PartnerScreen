import { NativeModule, requireNativeModule } from 'expo';

export type PipModeChangedEvent = { isInPictureInPictureMode: boolean };

declare class PartnerPipModule extends NativeModule<{ onPipModeChanged: (event: PipModeChangedEvent) => void }> {
  enterPip(width: number, height: number): Promise<boolean>;
  updatePipAspect(width: number, height: number): Promise<boolean>;
  exitPip(): Promise<boolean>;
  isInPip(): Promise<boolean>;
  supportsPip(): boolean;
  addListener(eventName: 'onPipModeChanged', listener: (event: PipModeChangedEvent) => void): { remove(): void };
}

export default requireNativeModule<PartnerPipModule>('PartnerPip');
