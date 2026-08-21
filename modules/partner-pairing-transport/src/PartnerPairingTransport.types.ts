export type PairingTransportEvent =
  | { type: 'connected'; connectionId: string; listenerId?: string }
  | { type: 'message'; connectionId: string; frame: string }
  | { type: 'closed'; connectionId: string }
  | { type: 'error'; connectionId?: string; code: string };

export type PartnerPairingTransportModuleEvents = {
  onPairingTransportEvent: (event: PairingTransportEvent) => void;
};

export interface PairingListenerEndpoint {
  listenerId: string;
  host: string;
  port: number;
}
