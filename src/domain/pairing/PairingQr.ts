import { normalizeDeviceName } from '../identity/LocalDeviceIdentity';

export const PAIRING_PROTOCOL_VERSION = 1 as const;
export const PAIRING_QR_PREFIX = 'PS1:';
export const PAIRING_QR_TTL_MS = 120_000;
export const PAIRING_QR_MAX_TTL_MS = 180_000;
export const PAIRING_CLOCK_SKEW_MS = 30_000;
export const PAIRING_QR_MAX_CHARS = 8_192;

export interface PairingQrPayload {
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  pairAttemptId: string;
  creatorDeviceId: string;
  creatorDeviceName: string;
  host: string;
  port: number;
  bootstrapKeyHex: string;
  createdAt: string;
  expiresAt: string;
}

export class PairingQrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingQrError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^[0-9a-f]{64}$/i;

export function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts.some((part, index) => String(octets[index]) !== part)) return false;

  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return false;

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function buildPairingQrPayload(input: Omit<PairingQrPayload, 'protocolVersion'>): string {
  const payload = validatePairingQrObject({ protocolVersion: PAIRING_PROTOCOL_VERSION, ...input });
  const raw = `${PAIRING_QR_PREFIX}${JSON.stringify(payload)}`;
  if (raw.length > PAIRING_QR_MAX_CHARS) throw new PairingQrError('The pairing QR payload is too large.');
  return raw;
}

export function parsePairingQr(
  raw: string,
  options: { nowMs: number; localDeviceId: string; alreadyPaired: boolean },
): PairingQrPayload {
  if (raw.length > PAIRING_QR_MAX_CHARS) {
    throw new PairingQrError('The pairing QR code is too large.');
  }
  if (!raw.startsWith(PAIRING_QR_PREFIX)) {
    throw new PairingQrError('This is not a PartnerScreen pairing QR code.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(PAIRING_QR_PREFIX.length));
  } catch {
    throw new PairingQrError('The pairing QR code is malformed.');
  }

  const payload = validatePairingQrObject(parsed);
  const createdMs = Date.parse(payload.createdAt);
  const expiresMs = Date.parse(payload.expiresAt);

  if (options.alreadyPaired) {
    throw new PairingQrError('This phone is already paired. Forget the current partner first.');
  }
  if (payload.creatorDeviceId === options.localDeviceId) {
    throw new PairingQrError('A phone cannot pair with itself.');
  }
  if (createdMs > options.nowMs + PAIRING_CLOCK_SKEW_MS) {
    throw new PairingQrError('The pairing QR timestamp is invalid.');
  }
  if (expiresMs <= options.nowMs) {
    throw new PairingQrError('This pairing QR code has expired.');
  }
  if (expiresMs <= createdMs || expiresMs - createdMs > PAIRING_QR_MAX_TTL_MS) {
    throw new PairingQrError('The pairing QR validity window is invalid.');
  }

  return payload;
}

export function validatePairingQrObject(value: unknown): PairingQrPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PairingQrError('The pairing QR payload is invalid.');
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    'protocolVersion', 'pairAttemptId', 'creatorDeviceId', 'creatorDeviceName',
    'host', 'port', 'bootstrapKeyHex', 'createdAt', 'expiresAt',
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) {
    throw new PairingQrError('The pairing QR contains unsupported fields.');
  }
  if (item.protocolVersion !== PAIRING_PROTOCOL_VERSION) {
    throw new PairingQrError('This PartnerScreen pairing version is not supported.');
  }
  if (typeof item.pairAttemptId !== 'string' || !UUID_RE.test(item.pairAttemptId)) {
    throw new PairingQrError('The pairing attempt ID is invalid.');
  }
  if (typeof item.creatorDeviceId !== 'string' || !UUID_RE.test(item.creatorDeviceId)) {
    throw new PairingQrError('The creator identity is invalid.');
  }
  if (typeof item.creatorDeviceName !== 'string') {
    throw new PairingQrError('The creator device name is invalid.');
  }
  let creatorDeviceName: string;
  try {
    creatorDeviceName = normalizeDeviceName(item.creatorDeviceName);
  } catch {
    throw new PairingQrError('The creator device name is invalid.');
  }
  if (!creatorDeviceName || creatorDeviceName !== item.creatorDeviceName) {
    throw new PairingQrError('The creator device name is invalid.');
  }
  if (typeof item.host !== 'string' || !isPrivateIpv4(item.host)) {
    throw new PairingQrError('The pairing endpoint is not a private LAN address.');
  }
  if (typeof item.port !== 'number' || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) {
    throw new PairingQrError('The pairing endpoint port is invalid.');
  }
  if (typeof item.bootstrapKeyHex !== 'string' || !KEY_RE.test(item.bootstrapKeyHex)) {
    throw new PairingQrError('The pairing credential is invalid.');
  }
  if (typeof item.createdAt !== 'string' || Number.isNaN(Date.parse(item.createdAt))) {
    throw new PairingQrError('The pairing creation time is invalid.');
  }
  if (typeof item.expiresAt !== 'string' || Number.isNaN(Date.parse(item.expiresAt))) {
    throw new PairingQrError('The pairing expiry time is invalid.');
  }

  return {
    protocolVersion: PAIRING_PROTOCOL_VERSION,
    pairAttemptId: item.pairAttemptId,
    creatorDeviceId: item.creatorDeviceId,
    creatorDeviceName,
    host: item.host,
    port: item.port,
    bootstrapKeyHex: item.bootstrapKeyHex.toLowerCase(),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}
