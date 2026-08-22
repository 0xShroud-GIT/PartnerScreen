export const DISCOVERY_PROTOCOL_VERSION = 1 as const;
export const DISCOVERY_HINT_HEX_LENGTH = 32;
export const DISCOVERY_PROOF_HEX_LENGTH = 64;

const SECRET_RE = /^[0-9a-f]{64}$/i;
const NONCE_RE = /^[0-9a-f]{32}$/i;
const HINT_RE = /^[0-9a-f]{32}$/i;
const PROOF_RE = /^[0-9a-f]{64}$/i;
const MAC_RE = /^[0-9a-f]{64}$/i;
const CONTROL_PORT_HEX_LENGTH = 4;

export interface HmacSha256 { macHex(keyHex: string, message: string): Promise<string>; }
export interface DiscoveryProofInput { nonce: string; host: string; port: number; controlPort: number; }

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168);
}
function validPort(value: number): boolean { return Number.isInteger(value) && value >= 1 && value <= 65535; }
function validateNonce(nonce: string): string { if (!NONCE_RE.test(nonce)) throw new Error('Discovery nonce is invalid.'); return nonce.toLowerCase(); }
function validateProofInput(input: DiscoveryProofInput): void {
  validateNonce(input.nonce);
  if (!isPrivateIpv4(input.host)) throw new Error('Discovery host must be a private IPv4 address.');
  if (!validPort(input.port)) throw new Error('Discovery port is invalid.');
  if (!validPort(input.controlPort)) throw new Error('Discovery control port is invalid.');
}
function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
function requireAscii(value: string): string {
  if (!value || value.length > 256) throw new Error('Discovery authentication message is invalid.');
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) > 0x7f) throw new Error('Discovery authentication message must be ASCII.');
  return value;
}
function controlPortHex(controlPort: number): string {
  if (!validPort(controlPort)) throw new Error('Discovery control port is invalid.');
  return controlPort.toString(16).padStart(CONTROL_PORT_HEX_LENGTH, '0');
}

export class HmacDiscoveryAuthenticator {
  constructor(private readonly hmacSha256: HmacSha256) {}

  async derivePeerHint(pairSecretHex: string, nonce: string): Promise<string> {
    const secret = this.requireSecret(pairSecretHex);
    const normalizedNonce = validateNonce(nonce);
    const message = requireAscii(`Chirp|discovery-hint|v1|${normalizedNonce}`);
    return (await this.mac(secret, message)).slice(0, DISCOVERY_HINT_HEX_LENGTH);
  }

  async createProof(pairSecretHex: string, input: DiscoveryProofInput): Promise<string> {
    validateProofInput(input);
    const secret = this.requireSecret(pairSecretHex);
    const portHex = controlPortHex(input.controlPort);
    const message = requireAscii(`Chirp|discovery-proof|v2|${input.nonce.toLowerCase()}|${input.host}|${input.port}|${input.controlPort}`);
    const mac = await this.mac(secret, message);
    return `${portHex}${mac.slice(CONTROL_PORT_HEX_LENGTH)}`;
  }

  extractControlPort(proofHex: string): number | null {
    if (!PROOF_RE.test(proofHex)) return null;
    const value = Number.parseInt(proofHex.slice(0, CONTROL_PORT_HEX_LENGTH), 16);
    return validPort(value) ? value : null;
  }

  async verifyProof(pairSecretHex: string, input: DiscoveryProofInput, proofHex: string): Promise<boolean> {
    if (!PROOF_RE.test(proofHex) || this.extractControlPort(proofHex) !== input.controlPort) return false;
    let expected: string;
    try { expected = await this.createProof(pairSecretHex, input); } catch { return false; }
    return constantTimeHexEqual(expected, proofHex.toLowerCase());
  }

  async verifyPeerHint(pairSecretHex: string, nonce: string, hintHex: string): Promise<boolean> {
    if (!HINT_RE.test(hintHex)) return false;
    let expected: string;
    try { expected = await this.derivePeerHint(pairSecretHex, nonce); } catch { return false; }
    return constantTimeHexEqual(expected, hintHex.toLowerCase());
  }

  private requireSecret(pairSecretHex: string): string {
    if (!SECRET_RE.test(pairSecretHex)) throw new Error('Pair secret is invalid.');
    return pairSecretHex.toLowerCase();
  }
  private async mac(keyHex: string, message: string): Promise<string> {
    const result = await this.hmacSha256.macHex(keyHex, message);
    if (!MAC_RE.test(result)) throw new Error('Discovery authentication primitive returned invalid output.');
    return result.toLowerCase();
  }
}
