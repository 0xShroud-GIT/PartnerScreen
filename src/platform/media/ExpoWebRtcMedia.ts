import PartnerScreenCaptureModule from '../../../modules/partner-screen-capture';
import type { PartnerScreenMediaEvent } from '../../../modules/partner-screen-capture';
import { UUID_V4_RE } from '../../protocol/ControlMessage';
import type { MediaConnectionState, WebRtcMediaNativeEvent, WebRtcMediaPort } from '../../media/WebRtcMediaPort';

const MAX_SDP_CHARS = 12 * 1024;
const MAX_CANDIDATE_CHARS = 2048;
const NATIVE_MEDIA_OPERATION_TIMEOUT_MS = 10_000;
const NATIVE_MEDIA_CLOSE_TIMEOUT_MS = 3_000;
const CONNECTION_STATES = new Set<MediaConnectionState>(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']);

function validSession(value: unknown): value is string { return typeof value === 'string' && UUID_V4_RE.test(value); }
function validVideoSdp(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= MAX_SDP_CHARS && value.includes('m=video') && !value.includes('m=audio') && !/\b(?:turn|turns|stun):/i.test(value); }
function validCandidate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > MAX_CANDIDATE_CHARS || /\r|\n/.test(value)) return false;
  const parts = value.trim().split(/\s+/); if (parts.length < 8 || parts[6] !== 'typ' || parts[7] !== 'host') return false;
  const host = parts[4] ?? ''; const octets = host.split('.').map(Number); if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseEvent(raw: unknown): WebRtcMediaNativeEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  if (!validSession(event.sessionId)) return null;
  if (event.type === 'remote_track' && Object.keys(event).every((key) => key === 'type' || key === 'sessionId')) return { type: 'remote_track', sessionId: event.sessionId };
  if (event.type === 'connection_state' && typeof event.state === 'string' && CONNECTION_STATES.has(event.state as MediaConnectionState) && Object.keys(event).every((key) => ['type', 'sessionId', 'state'].includes(key))) return { type: 'connection_state', sessionId: event.sessionId, state: event.state as MediaConnectionState };
  if (event.type === 'ice_candidate' && typeof event.sdpMid === 'string' && event.sdpMid.length <= 64 && Number.isInteger(event.sdpMLineIndex) && (event.sdpMLineIndex as number) >= 0 && (event.sdpMLineIndex as number) <= 32 && validCandidate(event.candidate) && Object.keys(event).every((key) => ['type', 'sessionId', 'sdpMid', 'sdpMLineIndex', 'candidate'].includes(key))) return { type: 'ice_candidate', sessionId: event.sessionId, sdpMid: event.sdpMid, sdpMLineIndex: event.sdpMLineIndex as number, candidate: event.candidate };
  return null;
}

export class ExpoWebRtcMedia implements WebRtcMediaPort {
  private readonly listeners = new Set<(event: WebRtcMediaNativeEvent) => void>();
  private readonly subscription: { remove(): void };

  constructor() {
    this.subscription = PartnerScreenCaptureModule.addListener('onPartnerScreenMediaEvent', (raw: PartnerScreenMediaEvent) => {
      const event = parseEvent(raw);
      if (event) for (const listener of this.listeners) listener(event);
    });
  }

  subscribe(listener: (event: WebRtcMediaNativeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async prepareRequester(sessionId: string): Promise<void> {
    if (!validSession(sessionId)) throw new Error('Remote video preparation failed.');
    const prepared = await withTimeout(PartnerScreenCaptureModule.prepareRequesterMedia(sessionId), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Remote video preparation timed out.');
    if (!prepared) throw new Error('Remote video preparation failed.');
  }

  async createPublisherOffer(sessionId: string): Promise<string> {
    if (!validSession(sessionId)) throw new Error('Media session is invalid.');
    const sdp = await withTimeout(PartnerScreenCaptureModule.createPublisherOffer(sessionId), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media offer creation timed out.');
    if (!validVideoSdp(sdp)) throw new Error('Media offer was rejected.');
    return sdp;
  }

  async acceptOffer(sessionId: string, sdp: string): Promise<string> {
    if (!validSession(sessionId) || !validVideoSdp(sdp)) throw new Error('Media offer is invalid.');
    const answer = await withTimeout(PartnerScreenCaptureModule.acceptOffer(sessionId, sdp), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media offer acceptance timed out.');
    if (!validVideoSdp(answer)) throw new Error('Media answer was rejected.');
    return answer;
  }

  async acceptAnswer(sessionId: string, sdp: string): Promise<void> {
    if (!validSession(sessionId) || !validVideoSdp(sdp)) throw new Error('Media answer was rejected.');
    const accepted = await withTimeout(PartnerScreenCaptureModule.acceptAnswer(sessionId, sdp), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media answer acceptance timed out.');
    if (!accepted) throw new Error('Media answer was rejected.');
  }

  async addIceCandidate(sessionId: string, sdpMid: string, sdpMLineIndex: number, candidate: string): Promise<void> {
    if (!validSession(sessionId) || sdpMid.length > 64 || !Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 32 || !validCandidate(candidate)) throw new Error('Media candidate was rejected.');
    const accepted = await withTimeout(PartnerScreenCaptureModule.addIceCandidate(sessionId, sdpMid, sdpMLineIndex, candidate), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media candidate handling timed out.');
    if (!accepted) throw new Error('Media candidate was rejected.');
  }

  async close(sessionId: string): Promise<void> {
    if (!validSession(sessionId)) return;
    await withTimeout(PartnerScreenCaptureModule.closeMedia(sessionId), NATIVE_MEDIA_CLOSE_TIMEOUT_MS, 'Media close timed out.').catch(() => undefined);
  }

  dispose(): void { this.subscription.remove(); this.listeners.clear(); }
}
