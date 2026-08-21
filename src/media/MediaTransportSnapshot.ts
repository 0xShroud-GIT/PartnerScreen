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
  lastLocalType?: IceCandidateKind | undefined;
  lastRemoteType?: IceCandidateKind | undefined;
  lastLocalTransport?: IceTransportKind | undefined;
  lastRemoteTransport?: IceTransportKind | undefined;
  lastLocalAddressFamily?: IceAddressFamily | undefined;
  lastRemoteAddressFamily?: IceAddressFamily | undefined;
  lastRejectionReason?: IceRejectionReason | undefined;
  selectedPairCategory: SelectedPairCategory;
  framesCaptured: number;
  framesEnteringSender: number;
  framesEncoded?: number | undefined;
  framesDecoded?: number | undefined;
  bytesSent?: number | undefined;
  bytesReceived?: number | undefined;
  rendererAttached: boolean;
  rendererWidth?: number | undefined;
  rendererHeight?: number | undefined;
  rendererRotation?: number | undefined;
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
