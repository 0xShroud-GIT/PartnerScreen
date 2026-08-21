import {
  CONTROL_PROTOCOL_VERSION,
  MAC_HEX_RE,
  NONCE_HEX_RE,
  UUID_V4_RE,
  type AnyControlMessage,
  type Hello1Frame,
  type Hello2Frame,
  type SealedControlFrame,
} from '../protocol/ControlMessage';
import { decodeControlMessage, encodeControlMessage } from '../protocol/ControlCodec';
import {
  SignalingCryptoError,
  type AesGcmPrimitive,
  type ControlSessionKeyContext,
  type HmacSha256Primitive,
} from './SignalingCipher';

const SECRET_RE = /^[0-9a-f]{64}$/i;

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function requireAscii(value: string): string {
  if (!value || value.length > 512) throw new SignalingCryptoError('invalid_input', 'Control authentication input is invalid.');
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) throw new SignalingCryptoError('invalid_input', 'Control authentication input is invalid.');
  }
  return value;
}

function requireSecret(secret: string): string {
  if (!SECRET_RE.test(secret)) throw new SignalingCryptoError('invalid_input', 'Control trust secret is invalid.');
  return secret.toLowerCase();
}

function requireUuid(value: string): string {
  if (!UUID_V4_RE.test(value)) throw new SignalingCryptoError('invalid_input', 'Control identity input is invalid.');
  return value.toLowerCase();
}

function requireNonce(value: string): string {
  if (!NONCE_HEX_RE.test(value)) throw new SignalingCryptoError('invalid_input', 'Control nonce input is invalid.');
  return value.toLowerCase();
}

export class AuthenticatedSignalingCipher {
  constructor(
    private readonly aes: AesGcmPrimitive,
    private readonly hmac: HmacSha256Primitive,
  ) {}

  assertRuntimeCompatible(): Promise<void> { return this.aes.assertRuntimeCompatible(); }
  randomId(): string { return this.aes.randomId(); }
  randomNonceHex(): Promise<string> { return this.aes.randomNonceHex(16); }

  async hello1Mac(pairSecretHex: string, frame: Omit<Hello1Frame, 'mac'>): Promise<string> {
    const message = requireAscii(
      `PartnerScreen|control-hello1|v1|${requireUuid(frame.helloId)}|${requireUuid(frame.sessionId)}|${requireUuid(frame.senderDeviceId)}|${requireNonce(frame.nonce)}|${frame.timestamp}`,
    );
    return this.mac(requireSecret(pairSecretHex), message);
  }

  async verifyHello1(pairSecretHex: string, frame: Hello1Frame): Promise<boolean> {
    if (!MAC_HEX_RE.test(frame.mac)) return false;
    const { mac: _mac, ...unsigned } = frame;
    try { return constantTimeHexEqual(await this.hello1Mac(pairSecretHex, unsigned), frame.mac.toLowerCase()); }
    catch { return false; }
  }

  async hello2Mac(pairSecretHex: string, frame: Omit<Hello2Frame, 'mac'>): Promise<string> {
    const message = requireAscii(
      `PartnerScreen|control-hello2|v1|${requireUuid(frame.helloId)}|${requireUuid(frame.sessionId)}|${requireUuid(frame.senderDeviceId)}|${requireNonce(frame.nonce)}|${requireNonce(frame.echoNonce)}|${requireUuid(frame.initiatorDeviceId)}|${frame.timestamp}`,
    );
    return this.mac(requireSecret(pairSecretHex), message);
  }

  async verifyHello2(pairSecretHex: string, frame: Hello2Frame): Promise<boolean> {
    if (!MAC_HEX_RE.test(frame.mac)) return false;
    const { mac: _mac, ...unsigned } = frame;
    try { return constantTimeHexEqual(await this.hello2Mac(pairSecretHex, unsigned), frame.mac.toLowerCase()); }
    catch { return false; }
  }

  async deriveSessionKey(pairSecretHex: string, context: ControlSessionKeyContext): Promise<string> {
    const message = requireAscii(
      `PartnerScreen|control-session-key|v1|${requireUuid(context.sessionId)}|${requireUuid(context.initiatorDeviceId)}|${requireUuid(context.responderDeviceId)}|${requireNonce(context.initiatorNonce)}|${requireNonce(context.responderNonce)}`,
    );
    return this.mac(requireSecret(pairSecretHex), message);
  }

  async sealMessage(sessionKeyHex: string, message: AnyControlMessage): Promise<SealedControlFrame> {
    const aad = this.aad(message.sessionId, message.senderDeviceId, message.sequence, message.type);
    try {
      return {
        kind: 'sealed',
        version: CONTROL_PROTOCOL_VERSION,
        sessionId: message.sessionId,
        senderDeviceId: message.senderDeviceId,
        sequence: message.sequence,
        type: message.type,
        sealed: await this.aes.seal(sessionKeyHex, aad, encodeControlMessage(message)),
      };
    } catch (error) {
      if (error instanceof SignalingCryptoError) throw error;
      throw new SignalingCryptoError('seal', 'Authenticated control encryption failed.');
    }
  }

  async openMessage(sessionKeyHex: string, frame: SealedControlFrame): Promise<AnyControlMessage> {
    const aad = this.aad(frame.sessionId, frame.senderDeviceId, frame.sequence, frame.type);
    let plaintext: string;
    try { plaintext = await this.aes.open(sessionKeyHex, aad, frame.sealed); }
    catch { throw new SignalingCryptoError('authentication', 'Authenticated control message was rejected.'); }
    const message = decodeControlMessage(plaintext);
    if (
      message.version !== CONTROL_PROTOCOL_VERSION ||
      message.sessionId !== frame.sessionId ||
      message.senderDeviceId !== frame.senderDeviceId ||
      message.sequence !== frame.sequence ||
      message.type !== frame.type
    ) throw new SignalingCryptoError('authentication', 'Authenticated control message header mismatch.');
    return message;
  }

  private aad(sessionId: string, senderDeviceId: string, sequence: number, type: string): string {
    return requireAscii(`PartnerScreen|control-message|v1|${requireUuid(sessionId)}|${requireUuid(senderDeviceId)}|${sequence}|${type}`);
  }

  private async mac(keyHex: string, message: string): Promise<string> {
    const value = await this.hmac.macHex(keyHex, message);
    if (!MAC_HEX_RE.test(value)) throw new SignalingCryptoError('runtime', 'Control authentication primitive returned invalid output.');
    return value.toLowerCase();
  }
}
