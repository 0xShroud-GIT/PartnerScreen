export type SanitizedMediaStats = {
  bytesSent?: number;
  bytesReceived?: number;
  packetsLost?: number;
  framesEncoded?: number;
  framesDecoded?: number;
  framesPerSecond?: number;
  jitter?: number;
  roundTripTime?: number;
  frameWidth?: number;
  frameHeight?: number;
  candidatePairState?: 'succeeded';
  bitrateParametersApplied?: boolean;
  measuredBitrateBps?: number;
};

const NUMERIC_KEYS = [
  'bytesSent',
  'bytesReceived',
  'packetsLost',
  'framesEncoded',
  'framesDecoded',
  'framesPerSecond',
  'jitter',
  'roundTripTime',
  'frameWidth',
  'frameHeight',
  'measuredBitrateBps',
] as const;

const FORBIDDEN_KEYS = new Set([
  'sdp', 'candidate', 'ice', 'ip', 'host', 'address', 'secret', 'token', 'password', 'fingerprint',
  'remoteIp', 'localIp', 'ipAddress', 'iceCandidate',
]);

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

export function sanitizeMediaStats(raw: unknown): SanitizedMediaStats | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.has(key) || /sdp|secret|token|password|fingerprint/i.test(key) || /(^|[^a-z])ip([^a-z]|$)/i.test(key)) return null;
  }
  const stats: SanitizedMediaStats = {};
  for (const key of NUMERIC_KEYS) {
    const value = finiteNumber(input[key]);
    if (value !== undefined) stats[key] = value;
  }
  if (input.candidatePairState === 'succeeded') stats.candidatePairState = 'succeeded';
  if (typeof input.bitrateParametersApplied === 'boolean') stats.bitrateParametersApplied = input.bitrateParametersApplied;
  return Object.keys(stats).length > 0 ? stats : null;
}

export function qualityFromStats(stats: SanitizedMediaStats | null, previousPacketsLost?: number): 'good' | 'degraded' {
  if (!stats) return 'good';
  const rtt = stats.roundTripTime;
  const jitter = stats.jitter;
  const lost = stats.packetsLost;
  const rttBad = typeof rtt === 'number' && rtt > 0.3;
  const jitterBad = typeof jitter === 'number' && jitter > 0.05;
  const lossDelta = typeof lost === 'number' && typeof previousPacketsLost === 'number' ? lost - previousPacketsLost : 0;
  const lossBad = lossDelta > 8;
  return rttBad || jitterBad || lossBad ? 'degraded' : 'good';
}

export function measuredBitrateBps(previous: { bytesSent: number; atMs: number } | null, bytesSent: number, atMs: number): number | undefined {
  if (!previous || atMs <= previous.atMs || bytesSent < previous.bytesSent) return undefined;
  const elapsedSec = (atMs - previous.atMs) / 1000;
  if (elapsedSec < 0.4) return undefined;
  return Math.round(((bytesSent - previous.bytesSent) * 8) / elapsedSec);
}
