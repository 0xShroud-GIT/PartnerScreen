import PartnerScreenCaptureModule from '../../../modules/partner-screen-capture';
import type { PartnerScreenMediaEvent } from '../../../modules/partner-screen-capture';
import { UUID_V4_RE } from '../../protocol/ControlMessage';
import { isSafePrivateHostCandidate, isSafeVideoSdp } from '../../protocol/MediaValidation';
import { sanitizeIceClassification } from '../../media/IceCandidateClassification';
import { sanitizeMediaStats, type SanitizedMediaStats } from '../../media/MediaStats';
import type { MediaIceConnectionState, MediaIceGatheringState } from '../../media/MediaTransportSnapshot';
import type { MediaConnectionState, WebRtcMediaNativeEvent, WebRtcMediaPort } from '../../media/WebRtcMediaPort';

const NATIVE_MEDIA_OPERATION_TIMEOUT_MS = 10_000;
const NATIVE_MEDIA_CLOSE_TIMEOUT_MS = 3_000;
const CONNECTION_STATES = new Set<MediaConnectionState>(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']);
const ICE_CONNECTION_STATES = new Set<MediaIceConnectionState>(['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed']);
const ICE_GATHERING_STATES = new Set<MediaIceGatheringState>(['new', 'gathering', 'complete']);
const RENDERER_ROTATIONS = new Set([0, 90, 180, 270]);

function validSession(value: unknown): value is string { return typeof value === 'string' && UUID_V4_RE.test(value); }
function boundedRendererDimension(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16_384;
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
  if (event.type === 'ice_state'
    && typeof event.iceConnectionState === 'string'
    && typeof event.iceGatheringState === 'string'
    && ICE_CONNECTION_STATES.has(event.iceConnectionState as MediaIceConnectionState)
    && ICE_GATHERING_STATES.has(event.iceGatheringState as MediaIceGatheringState)
    && Object.keys(event).every((key) => ['type', 'sessionId', 'iceConnectionState', 'iceGatheringState'].includes(key))) {
    return {
      type: 'ice_state',
      sessionId: event.sessionId,
      iceConnectionState: event.iceConnectionState as MediaIceConnectionState,
      iceGatheringState: event.iceGatheringState as MediaIceGatheringState,
    };
  }
  if (event.type === 'ice_classified' && Object.keys(event).every((key) => ['type', 'sessionId', 'classification'].includes(key))) {
    const classification = sanitizeIceClassification(event.classification);
    return classification ? { type: 'ice_classified', sessionId: event.sessionId, classification } : null;
  }
  if (event.type === 'renderer'
    && typeof event.attached === 'boolean'
    && Object.keys(event).every((key) => ['type', 'sessionId', 'attached', 'width', 'height', 'rotation'].includes(key))) {
    const width = event.width;
    const height = event.height;
    const rotation = event.rotation;
    if ((width === undefined) !== (height === undefined)) return null;
    if ((width === undefined) !== (rotation === undefined)) return null;
    if (width === undefined) return { type: 'renderer', sessionId: event.sessionId, attached: event.attached };
    if (!boundedRendererDimension(width) || !boundedRendererDimension(height) || !Number.isInteger(rotation) || !RENDERER_ROTATIONS.has(rotation as number)) return null;
    return { type: 'renderer', sessionId: event.sessionId, attached: event.attached, width, height, rotation: rotation as number };
  }
  if (event.type === 'ice_candidate' && typeof event.sdpMid === 'string' && event.sdpMid.length <= 64 && Number.isInteger(event.sdpMLineIndex) && (event.sdpMLineIndex as number) >= 0 && (event.sdpMLineIndex as number) <= 32 && isSafePrivateHostCandidate(event.candidate) && Object.keys(event).every((key) => ['type', 'sessionId', 'sdpMid', 'sdpMLineIndex', 'candidate'].includes(key))) return { type: 'ice_candidate', sessionId: event.sessionId, sdpMid: event.sdpMid, sdpMLineIndex: event.sdpMLineIndex as number, candidate: event.candidate };
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
    if (!isSafeVideoSdp(sdp)) throw new Error('Media offer was rejected.');
    return sdp;
  }

  async acceptOffer(sessionId: string, sdp: string): Promise<string> {
    if (!validSession(sessionId) || !isSafeVideoSdp(sdp)) throw new Error('Media offer is invalid.');
    const answer = await withTimeout(PartnerScreenCaptureModule.acceptOffer(sessionId, sdp), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media offer acceptance timed out.');
    if (!isSafeVideoSdp(answer)) throw new Error('Media answer was rejected.');
    return answer;
  }

  async acceptAnswer(sessionId: string, sdp: string): Promise<void> {
    if (!validSession(sessionId) || !isSafeVideoSdp(sdp)) throw new Error('Media answer was rejected.');
    const accepted = await withTimeout(PartnerScreenCaptureModule.acceptAnswer(sessionId, sdp), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media answer acceptance timed out.');
    if (!accepted) throw new Error('Media answer was rejected.');
  }

  async addIceCandidate(sessionId: string, sdpMid: string, sdpMLineIndex: number, candidate: string): Promise<void> {
    if (!validSession(sessionId) || sdpMid.length > 64 || !Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 32 || !isSafePrivateHostCandidate(candidate)) throw new Error('Media candidate was rejected.');
    const accepted = await withTimeout(PartnerScreenCaptureModule.addIceCandidate(sessionId, sdpMid, sdpMLineIndex, candidate), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media candidate handling timed out.');
    if (!accepted) throw new Error('Media candidate was rejected.');
  }

  async close(sessionId: string): Promise<void> {
    if (!validSession(sessionId)) return;
    await withTimeout(PartnerScreenCaptureModule.closeMedia(sessionId), NATIVE_MEDIA_CLOSE_TIMEOUT_MS, 'Media close timed out.').catch(() => undefined);
  }

  async restartIce(sessionId: string): Promise<boolean> {
    if (!validSession(sessionId)) return false;
    try {
      return await withTimeout(PartnerScreenCaptureModule.restartIce(sessionId), NATIVE_MEDIA_CLOSE_TIMEOUT_MS, 'ICE restart timed out.');
    } catch {
      return false;
    }
  }

  async getStats(sessionId: string): Promise<SanitizedMediaStats | null> {
    if (!validSession(sessionId)) return null;
    try {
      const raw = await withTimeout(PartnerScreenCaptureModule.getMediaStats(sessionId), NATIVE_MEDIA_OPERATION_TIMEOUT_MS, 'Media stats timed out.');
      return sanitizeMediaStats(raw);
    } catch {
      return null;
    }
  }

  dispose(): void { this.subscription.remove(); this.listeners.clear(); }
}
