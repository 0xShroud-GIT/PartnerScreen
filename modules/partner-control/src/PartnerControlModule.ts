import { NativeModule, requireNativeModule } from 'expo';
import type { ControlListenerEndpoint, PartnerControlModuleEvents } from './PartnerControl.types';

declare class PartnerControlModule extends NativeModule<PartnerControlModuleEvents> {
  startListener(): Promise<ControlListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
}

export default requireNativeModule<PartnerControlModule>('PartnerControl');
