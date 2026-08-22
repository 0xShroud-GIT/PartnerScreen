export const SCREEN_LONG_EDGE_PX = 1600;
export const SCREEN_FPS = 30;
export const SCREEN_MIN_BITRATE_BPS = 1_000_000;
export const SCREEN_MAX_BITRATE_BPS = 8_000_000;
export const MEDIA_DISCONNECTED_GRACE_MS = 3_000;
export const MEDIA_RESTART_DELAYS_MS = [500, 1_000, 2_000] as const;
export const MEDIA_SIGNAL_RETRY_MS = 1_000;
export const MEDIA_KEYFRAME_REQUEST_DELAYS_MS = [500, 1_500, 3_000] as const;
export const MEDIA_KEYFRAME_STEADY_RETRY_MS = 5_000;
export const MEDIA_KEYFRAME_TOGGLE_MS = 80;
export const MEDIA_STATS_INTERVAL_MS = 2_000;

export type CandidateDecision = {
  accepted: boolean;
  protocol: 'udp' | 'tcp' | 'unknown';
  addressFamily: 'ipv4' | 'ipv6' | 'unknown';
  candidateType: 'host' | 'srflx' | 'relay' | 'prflx' | 'unknown';
  reason: 'private_ipv4_host_udp' | 'non_host' | 'non_udp' | 'non_ipv4' | 'non_private_ipv4' | 'malformed';
};

export function captureResolutionScale(widthPx: number, heightPx: number): number {
  const longEdge = Math.max(widthPx, heightPx);
  if (!Number.isFinite(longEdge) || longEdge <= 0) return 1;
  return Math.max(0.1, Math.min(1, SCREEN_LONG_EDGE_PX / longEdge));
}

/**
 * Distinguish the user declining Android's MediaProjection consent from a technical
 * capture failure. react-native-webrtc surfaces the native getDisplayMedia rejection as
 * a DOMException whose name string is `NotAllowedError` for user denial and `AbortError`
 * (or an arbitrary runtime message) for capture/start failures. Denial is a product
 * outcome; a technical failure is a capture failure and must be reported as such, not
 * misreported to the partner as "permission not granted".
 */
export function classifyDisplayMediaError(error: unknown): 'user_denied' | 'capture_failed' {
  if (!error || typeof error !== 'object') return 'capture_failed';
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const mentionsNotAllowed = name === 'NotAllowedError' || message === 'NotAllowedError' || message.includes('NotAllowedError') || code === 'NotAllowedError';
  return mentionsNotAllowed ? 'user_denied' : 'capture_failed';
}

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function classifyIceCandidate(candidate: string): CandidateDecision {
  const parts = candidate.trim().split(/\s+/);
  if (parts.length < 8 || !parts[0]?.startsWith('candidate:')) return { accepted: false, protocol: 'unknown', addressFamily: 'unknown', candidateType: 'unknown', reason: 'malformed' };
  const protocol = parts[2]?.toLowerCase() === 'udp' ? 'udp' : parts[2]?.toLowerCase() === 'tcp' ? 'tcp' : 'unknown';
  const address = parts[4] ?? '';
  const typeIndex = parts.indexOf('typ');
  const rawType = typeIndex >= 0 ? parts[typeIndex + 1] : undefined;
  const candidateType = rawType === 'host' || rawType === 'srflx' || rawType === 'relay' || rawType === 'prflx' ? rawType : 'unknown';
  const addressFamily = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ? 'ipv4' : address.includes(':') ? 'ipv6' : 'unknown';
  if (candidateType !== 'host') return { accepted: false, protocol, addressFamily, candidateType, reason: 'non_host' };
  if (protocol !== 'udp') return { accepted: false, protocol, addressFamily, candidateType, reason: 'non_udp' };
  if (addressFamily !== 'ipv4') return { accepted: false, protocol, addressFamily, candidateType, reason: 'non_ipv4' };
  if (!isPrivateIpv4(address)) return { accepted: false, protocol, addressFamily, candidateType, reason: 'non_private_ipv4' };
  return { accepted: true, protocol, addressFamily, candidateType, reason: 'private_ipv4_host_udp' };
}
