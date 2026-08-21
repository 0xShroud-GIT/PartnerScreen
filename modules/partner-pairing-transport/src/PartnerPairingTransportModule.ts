import { NativeModule, requireNativeModule } from 'expo';
import type {
  PairingListenerEndpoint,
  PairingTransportEvent,
  PartnerPairingTransportModuleEvents,
} from './PartnerPairingTransport.types';

declare class PartnerPairingTransportModule extends NativeModule<PartnerPairingTransportModuleEvents> {
  startListener(): Promise<PairingListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
}

export type { PairingListenerEndpoint, PairingTransportEvent };
export default requireNativeModule<PartnerPairingTransportModule>('PartnerPairingTransport');
