import { NativeModule, requireNativeModule } from 'expo';
import type { ControlListenerEndpoint, ChirpControlModuleEvents } from './ChirpControl.types';

declare class ChirpControlModule extends NativeModule<ChirpControlModuleEvents> {
  startListener(): Promise<ControlListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
  startTrustedPresence(): Promise<boolean>;
  stopTrustedPresence(): Promise<boolean>;
  getActiveListener(): ControlListenerEndpoint | null;
}

export default requireNativeModule<ChirpControlModule>('ChirpControl');
