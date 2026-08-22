export interface ControlListenerEndpoint { listenerId: string; host: string; port: number; }
export type ChirpControlEvent =
  | { type: 'connected'; connectionId: string; direction: 'inbound' | 'outbound'; listenerId?: string }
  | { type: 'message'; connectionId: string; frame: string }
  | { type: 'closed'; connectionId: string }
  | { type: 'error'; code: string; connectionId?: string; listenerId?: string };
export type ChirpControlModuleEvents = { onChirpControlEvent: (event: ChirpControlEvent) => void };
