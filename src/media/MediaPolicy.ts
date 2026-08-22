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
// Android MediaProjection consent must settle (grant or deny) within a bounded window. A prompt
// that never delivers an ActivityResult (activity recreation, OS quirk) must fail closed instead of
// leaving the sharer stuck on "waiting for permission" forever and blocking the media operation queue.
export const MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS = 60_000;

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
 * Delay before the requester's next MEDIA_KEYFRAME_REQUEST while it has a track but no decoded frame.
 *
 * This is the *keyframe* recovery clock only. It never escalates to an ICE restart: after the bounded
 * first-frame retries it degrades to a steady retry so the decoder can still receive a fresh intra-frame.
 * A missing first frame must not be reclassified as broken ICE/transport.
 */
export function keyframeRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) attempt = 0;
  if (attempt < MEDIA_KEYFRAME_REQUEST_DELAYS_MS.length) return MEDIA_KEYFRAME_REQUEST_DELAYS_MS[attempt]!;
  return MEDIA_KEYFRAME_STEADY_RETRY_MS;
}

export type SenderBitratePatch = {
  encodings: Array<Record<string, unknown>>;
  degradationPreference: 'maintain-resolution';
  applicable: boolean;
};

/**
 * Builds the sender parameter patch that encodes Chirp's high-quality LAN screen-share profile.
 *
 * It intentionally returns `applicable: false` when the sender reports no encodings yet. Fabricating a
 * `[{}]` encoding here would desynchronize the JS encodings array from the native libwebrtc encoding list
 * (react-native-webrtc rejects setParameters when the arrays differ in size), which would abort the share.
 * In that case the caller should leave bitrate unconfigured (a quality preference, never session-fatal).
 */
export function senderBitrateParameters(
  encodings: ReadonlyArray<Record<string, unknown>> | null | undefined,
): SenderBitratePatch {
  if (!Array.isArray(encodings) || encodings.length === 0) {
    return { encodings: [], degradationPreference: 'maintain-resolution', applicable: false };
  }
  return {
    encodings: encodings.map((encoding) => ({
      ...(encoding && typeof encoding === 'object' ? encoding : {}),
      minBitrate: SCREEN_MIN_BITRATE_BPS,
      maxBitrate: SCREEN_MAX_BITRATE_BPS,
      maxFramerate: SCREEN_FPS,
      scaleResolutionDownBy: 1,
      active: true,
    })),
    degradationPreference: 'maintain-resolution',
    applicable: true,
  };
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
