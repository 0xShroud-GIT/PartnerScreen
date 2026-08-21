import { normalizeDeviceName } from '../identity/LocalDeviceIdentity';
import { isCanonicalPairingSealedWire } from './PairingCryptoWire';
import { PAIRING_PROTOCOL_VERSION } from './PairingQr';

export const PAIRING_MESSAGE_TYPES = [
  'PAIR_HELLO',
  'PAIR_IDENTITY',
  'PAIR_CONFIRM',
  'PAIR_COMMIT',
  'PAIR_COMMIT_ACK',
  'PAIR_CANCEL',
  'PAIR_ERROR',
] as const;

export type PairingMessageType = (typeof PAIRING_MESSAGE_TYPES)[number];

export type PairCommitAckPhase =
  | 'scanner_staged'
  | 'creator_ready'
  | 'scanner_committed'
  | 'creator_committed'
  | 'scanner_confirmed'
  | 'creator_confirmed'
  | 'converged';

export interface PairingMessageEnvelope {
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  messageId: string;
  type: PairingMessageType;
  senderDeviceId: string;
  timestamp: string;
  payload: unknown;
}

export interface PairingFrameHeader {
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  pairAttemptId: string;
  senderDeviceId: string;
  sequence: number;
}

export interface SealedPairingFrame extends PairingFrameHeader {
  sealed: string;
}

export interface PairHelloPayload {
  pairAttemptId: string;
}

export interface PairIdentityPayload {
  deviceId: string;
  deviceName: string;
}

export interface PairConfirmPayload {
  deviceId: string;
}

export interface PairCommitPayload {
  pairId: string;
  pairKeyHex: string;
  creatorDeviceId: string;
  scannerDeviceId: string;
  pairedAt: string;
}

export interface PairCommitAckPayload {
  phase: PairCommitAckPhase;
}

export interface PairCancelPayload {
  reason: 'user_cancelled';
}

export interface PairErrorPayload {
  code: 'pairing_failed';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^[0-9a-f]{64}$/i;
const MESSAGE_TOLERANCE_MS = 180_000;

export class PairingProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingProtocolError';
  }
}

function requireObject(payload: unknown, label: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PairingProtocolError(`Invalid ${label}.`);
  }
  return payload as Record<string, unknown>;
}

function requireExactKeys(item: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(item).some((key) => !allowed.has(key)) || keys.some((key) => !(key in item))) {
    throw new PairingProtocolError(`Unsupported ${label} fields.`);
  }
}

export function pairingFrameAad(header: PairingFrameHeader): string {
  return [header.protocolVersion, header.pairAttemptId, header.senderDeviceId, header.sequence].join('|');
}

export function parseSealedPairingFrame(raw: string): SealedPairingFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PairingProtocolError('Malformed pairing frame.');
  }
  const item = requireObject(parsed, 'pairing frame');
  requireExactKeys(item, ['protocolVersion', 'pairAttemptId', 'senderDeviceId', 'sequence', 'sealed'], 'pairing frame');
  if (item.protocolVersion !== PAIRING_PROTOCOL_VERSION) throw new PairingProtocolError('Unsupported pairing version.');
  if (typeof item.pairAttemptId !== 'string' || !UUID_RE.test(item.pairAttemptId)) throw new PairingProtocolError('Invalid pairing attempt.');
  if (typeof item.senderDeviceId !== 'string' || !UUID_RE.test(item.senderDeviceId)) throw new PairingProtocolError('Invalid pairing sender.');
  if (typeof item.sequence !== 'number' || !Number.isSafeInteger(item.sequence) || item.sequence < 1) throw new PairingProtocolError('Invalid pairing sequence.');
  if (!isCanonicalPairingSealedWire(item.sealed)) throw new PairingProtocolError('Invalid sealed pairing data.');
  return item as unknown as SealedPairingFrame;
}

export function parsePairingEnvelope(raw: string, nowMs: number): PairingMessageEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PairingProtocolError('Malformed pairing message.');
  }
  const item = requireObject(parsed, 'pairing message');
  requireExactKeys(item, ['protocolVersion', 'messageId', 'type', 'senderDeviceId', 'timestamp', 'payload'], 'pairing message');
  if (item.protocolVersion !== PAIRING_PROTOCOL_VERSION) throw new PairingProtocolError('Unsupported pairing message version.');
  if (typeof item.messageId !== 'string' || !UUID_RE.test(item.messageId)) throw new PairingProtocolError('Invalid pairing message ID.');
  if (typeof item.type !== 'string' || !PAIRING_MESSAGE_TYPES.includes(item.type as PairingMessageType)) throw new PairingProtocolError('Unsupported pairing message type.');
  if (typeof item.senderDeviceId !== 'string' || !UUID_RE.test(item.senderDeviceId)) throw new PairingProtocolError('Invalid pairing message sender.');
  if (typeof item.timestamp !== 'string' || Number.isNaN(Date.parse(item.timestamp))) throw new PairingProtocolError('Invalid pairing message timestamp.');
  if (Math.abs(nowMs - Date.parse(item.timestamp)) > MESSAGE_TOLERANCE_MS) throw new PairingProtocolError('Pairing message timestamp is outside tolerance.');
  return item as unknown as PairingMessageEnvelope;
}

export function parseHelloPayload(payload: unknown): PairHelloPayload {
  const item = requireObject(payload, 'PAIR_HELLO payload');
  requireExactKeys(item, ['pairAttemptId'], 'PAIR_HELLO payload');
  if (typeof item.pairAttemptId !== 'string' || !UUID_RE.test(item.pairAttemptId)) {
    throw new PairingProtocolError('Invalid PAIR_HELLO attempt.');
  }
  return { pairAttemptId: item.pairAttemptId };
}

export function parseIdentityPayload(payload: unknown): PairIdentityPayload {
  const item = requireObject(payload, 'identity payload');
  requireExactKeys(item, ['deviceId', 'deviceName'], 'identity payload');
  if (typeof item.deviceId !== 'string' || !UUID_RE.test(item.deviceId)) throw new PairingProtocolError('Invalid remote identity.');
  if (typeof item.deviceName !== 'string') throw new PairingProtocolError('Invalid remote device name.');
  let deviceName: string;
  try {
    deviceName = normalizeDeviceName(item.deviceName);
  } catch {
    throw new PairingProtocolError('Invalid remote device name.');
  }
  if (deviceName !== item.deviceName) throw new PairingProtocolError('Invalid remote device name.');
  return { deviceId: item.deviceId, deviceName };
}

export function parseConfirmPayload(payload: unknown): PairConfirmPayload {
  const item = requireObject(payload, 'PAIR_CONFIRM payload');
  requireExactKeys(item, ['deviceId'], 'PAIR_CONFIRM payload');
  if (typeof item.deviceId !== 'string' || !UUID_RE.test(item.deviceId)) {
    throw new PairingProtocolError('Invalid pair confirmation identity.');
  }
  return { deviceId: item.deviceId };
}

export function parseCommitPayload(payload: unknown): PairCommitPayload {
  const item = requireObject(payload, 'pair commit payload');
  requireExactKeys(item, ['pairId', 'pairKeyHex', 'creatorDeviceId', 'scannerDeviceId', 'pairedAt'], 'pair commit payload');
  for (const field of ['pairId', 'creatorDeviceId', 'scannerDeviceId'] as const) {
    if (typeof item[field] !== 'string' || !UUID_RE.test(item[field] as string)) throw new PairingProtocolError(`Invalid ${field}.`);
  }
  if (typeof item.pairKeyHex !== 'string' || !KEY_RE.test(item.pairKeyHex)) throw new PairingProtocolError('Invalid durable pair key.');
  if (typeof item.pairedAt !== 'string' || Number.isNaN(Date.parse(item.pairedAt))) throw new PairingProtocolError('Invalid pair time.');
  return {
    pairId: item.pairId as string,
    pairKeyHex: (item.pairKeyHex as string).toLowerCase(),
    creatorDeviceId: item.creatorDeviceId as string,
    scannerDeviceId: item.scannerDeviceId as string,
    pairedAt: item.pairedAt as string,
  };
}

export function parseAckPayload(payload: unknown): PairCommitAckPayload {
  const item = requireObject(payload, 'pair acknowledgement');
  requireExactKeys(item, ['phase'], 'pair acknowledgement');
  const phase = item.phase;
  const phases: PairCommitAckPhase[] = [
    'scanner_staged', 'creator_ready', 'scanner_committed', 'creator_committed',
    'scanner_confirmed', 'creator_confirmed', 'converged',
  ];
  if (typeof phase !== 'string' || !phases.includes(phase as PairCommitAckPhase)) throw new PairingProtocolError('Invalid pair acknowledgement phase.');
  return { phase: phase as PairCommitAckPhase };
}

export function parseCancelPayload(payload: unknown): PairCancelPayload {
  const item = requireObject(payload, 'PAIR_CANCEL payload');
  requireExactKeys(item, ['reason'], 'PAIR_CANCEL payload');
  if (item.reason !== 'user_cancelled') throw new PairingProtocolError('Invalid pair cancellation reason.');
  return { reason: 'user_cancelled' };
}

export function parseErrorPayload(payload: unknown): PairErrorPayload {
  const item = requireObject(payload, 'PAIR_ERROR payload');
  requireExactKeys(item, ['code'], 'PAIR_ERROR payload');
  if (item.code !== 'pairing_failed') throw new PairingProtocolError('Invalid pair error code.');
  return { code: 'pairing_failed' };
}

export class PairingReplayGuard {
  private readonly seenMessageIds = new Set<string>();
  private lastSequence = 0;

  accept(sequence: number, messageId: string): void {
    if (sequence !== this.lastSequence + 1) throw new PairingProtocolError('Pairing frame sequence is invalid or replayed.');
    if (this.seenMessageIds.has(messageId)) throw new PairingProtocolError('Duplicate pairing message rejected.');
    this.lastSequence = sequence;
    this.seenMessageIds.add(messageId);
  }
}
