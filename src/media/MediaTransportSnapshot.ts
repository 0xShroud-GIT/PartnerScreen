import type { IceAddressFamily, IceCandidateKind, IceRejectionReason, IceTransportKind } from './IceCandidateClassification';

export type MediaPeerConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export type MediaIceConnectionState = 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed';
export type MediaIceGatheringState = 'new' | 'gathering' | 'complete';
export type SelectedPairCategory = 'host_udp_ipv4' | 'none' | 'other';

export type MediaTransportSnapshot = {
  peerConnectionState: MediaPeerConnectionState | 'unknown';
  iceConnectionState: MediaIceConnectionState | 'unknown';
  iceGatheringState: MediaIceGatheringState | 'unknown';
  localCandidatesGenerated: number;
  localAccepted: number;
  localRejected: number;
  remoteAccepted: number;
  remoteRejected: number;
  lastLocalType?: IceCandidateKind;
  lastRemoteType?: IceCandidateKind;
  lastLocalTransport?: IceTransportKind;
  lastRemoteTransport?: IceTransportKind;
  lastLocalAddressFamily?: IceAddressFamily;
  lastRemoteAddressFamily?: IceAddressFamily;
  lastRejectionReason?: IceRejectionReason;
  selectedPairCategory: SelectedPairCategory;
  framesCaptured: number;
  framesEnteringSender: number;
  framesEncoded?: number;
  framesDecoded?: number;
  bytesSent?: number;
  bytesReceived?: number;
  rendererAttached: boolean;
  rendererWidth?: number;
  rendererHeight?: number;
  rendererRotation?: number;
  firstRenderedFrame: boolean;
};

export function emptyMediaTransportSnapshot(): MediaTransportSnapshot {
  return {
    peerConnectionState: 'unknown',
    iceConnectionState: 'unknown',
    iceGatheringState: 'unknown',
    localCandidatesGenerated: 0,
    localAccepted: 0,
    localRejected: 0,
    remoteAccepted: 0,
    remoteRejected: 0,
    selectedPairCategory: 'none',
    framesCaptured: 0,
    framesEnteringSender: 0,
    rendererAttached: false,
    firstRenderedFrame: false,
  };
}
