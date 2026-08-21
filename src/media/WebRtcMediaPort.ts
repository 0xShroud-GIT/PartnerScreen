import type { SanitizedMediaStats } from './MediaStats';

export type MediaConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export type WebRtcMediaNativeEvent =
  | { type: 'ice_candidate'; sessionId: string; sdpMid: string; sdpMLineIndex: number; candidate: string }
  | { type: 'remote_track'; sessionId: string }
  | { type: 'connection_state'; sessionId: string; state: MediaConnectionState };

export interface WebRtcMediaPort {
  subscribe(listener: (event: WebRtcMediaNativeEvent) => void): () => void;
  prepareRequester(sessionId: string): Promise<void>;
  createPublisherOffer(sessionId: string): Promise<string>;
  acceptOffer(sessionId: string, sdp: string): Promise<string>;
  acceptAnswer(sessionId: string, sdp: string): Promise<void>;
  addIceCandidate(sessionId: string, sdpMid: string, sdpMLineIndex: number, candidate: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  getStats(sessionId: string): Promise<SanitizedMediaStats | null>;
}
