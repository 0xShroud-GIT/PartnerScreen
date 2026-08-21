import type { SessionState } from '../session/SessionState';

export function shouldOpenIncomingRequest(state: SessionState, sessionId: string): boolean {
  return state.type === 'IncomingRequest' && state.sessionId === sessionId;
}
