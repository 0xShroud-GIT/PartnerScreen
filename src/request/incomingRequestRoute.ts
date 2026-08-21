import type { SessionState } from '../session/SessionState';

const INCOMING_REQUEST_RE = /^partnerscreen:\/\/incoming-request\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\?.*)?$/i;

export function parseIncomingRequestSessionId(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 256) return null;
  const match = INCOMING_REQUEST_RE.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

export function shouldOpenIncomingRequest(state: SessionState, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return state.type === 'IncomingRequest' && state.sessionId.toLowerCase() === sessionId.toLowerCase();
}
