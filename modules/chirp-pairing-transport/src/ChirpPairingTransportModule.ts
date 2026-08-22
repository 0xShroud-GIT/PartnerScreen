import { NativeModule, requireNativeModule } from 'expo';
import type {
  PairingListenerEndpoint,
  PairingTransportEvent,
  ChirpPairingTransportModuleEvents,
} from './ChirpPairingTransport.types';

declare class ChirpPairingTransportModule extends NativeModule<ChirpPairingTransportModuleEvents> {
  startListener(): Promise<PairingListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
}

export type { PairingListenerEndpoint, PairingTransportEvent };
export default requireNativeModule<ChirpPairingTransportModule>('ChirpPairingTransport');
