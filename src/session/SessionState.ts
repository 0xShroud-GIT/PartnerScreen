import type { PairTrustMetadata } from '../domain/pairing/PairTrustRepository';

export type SessionRole = 'requester' | 'sharer';

export type SessionState =
  | { type: 'Unpaired' }
  | { type: 'PairedOffline'; pair: PairTrustMetadata }
  | { type: 'PairedAvailable'; pair: PairTrustMetadata; endpoint: { host: string; port: number } }
  | { type: 'OutgoingRequest'; pair: PairTrustMetadata; sessionId: string; expiresAt: string }
  | { type: 'IncomingRequest'; pair: PairTrustMetadata; sessionId: string; expiresAt: string }
  | { type: 'Connected'; pair: PairTrustMetadata; sessionId: string; role: SessionRole }
  | { type: 'Error'; pair: PairTrustMetadata; message: string };

export function isBasePairedState(state: SessionState): state is Extract<SessionState, { type: 'PairedOffline' | 'PairedAvailable' }> {
  return state.type === 'PairedOffline' || state.type === 'PairedAvailable';
}
