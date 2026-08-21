import { MAX_MEDIA_CANDIDATE_CHARS, MAX_MEDIA_SDP_CHARS } from './ControlMessage';

function isPrivateIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((value, index) => !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== parts[index])) {
    return false;
  }
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

export function isSafePrivateHostCandidate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > MAX_MEDIA_CANDIDATE_CHARS || /\r|\n/.test(value)) {
    return false;
  }
  const parts = value.trim().split(/\s+/);
  if (parts.length < 8 || parts[6]?.toLowerCase() !== 'typ' || parts[7]?.toLowerCase() !== 'host') return false;
  return isPrivateIpv4Literal(parts[4] ?? '');
}

export function isSafeVideoSdp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MEDIA_SDP_CHARS) return false;
  if (/\b(?:turn|turns|stun):/i.test(value)) return false;

  const lines = value.split(/\r\n|\n|\r/).map((line) => line.trim());
  if (!lines.some((line) => /^m=video(?:\s|$)/i.test(line))) return false;
  if (lines.some((line) => /^m=audio(?:\s|$)/i.test(line))) return false;

  for (const line of lines) {
    if (!/^a=candidate:/i.test(line)) continue;
    if (!isSafePrivateHostCandidate(line.slice(2))) return false;
  }
  return true;
}
