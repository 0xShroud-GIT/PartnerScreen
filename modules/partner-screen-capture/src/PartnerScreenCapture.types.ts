export type CaptureStopReason = 'user' | 'notification' | 'service_destroyed';
export type PartnerScreenCaptureEvent =
  | { type: 'starting'; sessionId: string }
  | { type: 'started'; sessionId: string }
  | { type: 'stopped'; reason: CaptureStopReason; sessionId: string }
  | { type: 'revoked'; sessionId: string }
  | { type: 'error'; code: 'capture_start_failed' | 'capture_unavailable'; sessionId: string };

export type MediaConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export type PartnerScreenMediaEvent =
  | { type: 'ice_candidate'; sessionId: string; sdpMid: string; sdpMLineIndex: number; candidate: string }
  | { type: 'remote_track'; sessionId: string }
  | { type: 'connection_state'; sessionId: string; state: MediaConnectionState }
  | { type: 'ice_state'; sessionId: string; iceConnectionState: string; iceGatheringState: string }
  | { type: 'ice_classified'; sessionId: string; classification: Record<string, unknown> }
  | { type: 'renderer'; sessionId: string; attached: boolean; width?: number; height?: number; rotation?: number };

export type PartnerScreenCaptureModuleEvents = {
  onPartnerScreenCaptureEvent: (event: PartnerScreenCaptureEvent) => void;
  onPartnerScreenMediaEvent: (event: PartnerScreenMediaEvent) => void;
};
