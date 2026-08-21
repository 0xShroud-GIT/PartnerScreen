export type IceCandidateKind = 'host' | 'srflx' | 'relay' | 'prflx' | 'other';
export type IceTransportKind = 'udp' | 'tcp' | 'other';
export type IceAddressFamily = 'ipv4' | 'ipv6' | 'mdns' | 'other';
export type IceRejectionReason =
  | 'malformed'
  | 'not_host'
  | 'not_private_ipv4'
  | 'ipv6'
  | 'mdns'
  | 'relay'
  | 'srflx'
  | 'public_address'
  | 'overflow'
  | 'stale_session';

export type SanitizedIceClassification = {
  direction: 'local' | 'remote';
  candidateType: IceCandidateKind;
  transport: IceTransportKind;
  addressFamily: IceAddressFamily;
  accepted: boolean;
  rejectionReason?: IceRejectionReason;
};

const FORBIDDEN_CLASSIFICATION_KEYS = new Set([
  'sdp', 'candidate', 'ice', 'ip', 'host', 'address', 'secret', 'token', 'password', 'fingerprint',
  'remoteIp', 'localIp', 'ipAddress', 'iceCandidate', 'usernameFragment', 'ufrag', 'pwd',
]);

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

function addressFamilyOf(address: string): IceAddressFamily {
  if (!address) return 'other';
  if (address.includes(':') && /[a-z]/i.test(address) && address.includes('.')) return 'mdns';
  if (address.toLowerCase().endsWith('.local')) return 'mdns';
  if (address.includes(':')) return 'ipv6';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return 'ipv4';
  return 'other';
}

function transportOf(protocol: string): IceTransportKind {
  const value = protocol.toLowerCase();
  if (value === 'udp') return 'udp';
  if (value === 'tcp') return 'tcp';
  return 'other';
}

function candidateTypeOf(type: string): IceCandidateKind {
  const value = type.toLowerCase();
  if (value === 'host' || value === 'srflx' || value === 'relay' || value === 'prflx') return value;
  return 'other';
}

function rejectionFor(type: IceCandidateKind, family: IceAddressFamily, address: string): IceRejectionReason | null {
  if (type === 'relay') return 'relay';
  if (type === 'srflx') return 'srflx';
  if (type !== 'host') return 'not_host';
  if (family === 'mdns') return 'mdns';
  if (family === 'ipv6') return 'ipv6';
  if (family !== 'ipv4') return 'not_private_ipv4';
  if (!isPrivateIpv4Literal(address)) return 'public_address';
  return null;
}

/** Classify an ICE candidate for telemetry. Never returns the candidate string or address. */
export function classifyIceCandidate(direction: 'local' | 'remote', candidate: unknown): SanitizedIceClassification {
  if (typeof candidate !== 'string' || candidate.length < 8 || candidate.length > 2048 || /[\r\n]/.test(candidate)) {
    return { direction, candidateType: 'other', transport: 'other', addressFamily: 'other', accepted: false, rejectionReason: 'malformed' };
  }
  const parts = candidate.trim().split(/\s+/);
  const typIndex = parts.findIndex((part) => part.toLowerCase() === 'typ');
  if (parts.length < 8 || typIndex < 6 || !parts[typIndex + 1]) {
    return { direction, candidateType: 'other', transport: 'other', addressFamily: 'other', accepted: false, rejectionReason: 'malformed' };
  }
  const transport = transportOf(parts[2] ?? '');
  const address = parts[4] ?? '';
  const family = addressFamilyOf(address);
  const candidateType = candidateTypeOf(parts[typIndex + 1] ?? '');
  const rejection = rejectionFor(candidateType, family, address);
  if (rejection) {
    return { direction, candidateType, transport, addressFamily: family, accepted: false, rejectionReason: rejection };
  }
  return { direction, candidateType, transport, addressFamily: family, accepted: true };
}

export function sanitizeIceClassification(raw: unknown): SanitizedIceClassification | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_CLASSIFICATION_KEYS.has(key) || /sdp|secret|token|password|fingerprint/i.test(key) || /(^|[^a-z])ip([^a-z]|$)/i.test(key)) {
      return null;
    }
  }
  if (input.direction !== 'local' && input.direction !== 'remote') return null;
  if (input.candidateType !== 'host' && input.candidateType !== 'srflx' && input.candidateType !== 'relay' && input.candidateType !== 'prflx' && input.candidateType !== 'other') return null;
  if (input.transport !== 'udp' && input.transport !== 'tcp' && input.transport !== 'other') return null;
  if (input.addressFamily !== 'ipv4' && input.addressFamily !== 'ipv6' && input.addressFamily !== 'mdns' && input.addressFamily !== 'other') return null;
  if (typeof input.accepted !== 'boolean') return null;
  const rejection = input.rejectionReason;
  if (rejection !== undefined && (
    rejection !== 'malformed' && rejection !== 'not_host' && rejection !== 'not_private_ipv4' && rejection !== 'ipv6'
    && rejection !== 'mdns' && rejection !== 'relay' && rejection !== 'srflx' && rejection !== 'public_address'
    && rejection !== 'overflow' && rejection !== 'stale_session'
  )) return null;
  return {
    direction: input.direction,
    candidateType: input.candidateType,
    transport: input.transport,
    addressFamily: input.addressFamily,
    accepted: input.accepted,
    ...(rejection === undefined ? {} : { rejectionReason: rejection }),
  };
}
