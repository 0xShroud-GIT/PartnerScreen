export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const CONTROL_TIMESTAMP_TOLERANCE_MS = 120_000;
export const MAX_MEDIA_SDP_CHARS = 12 * 1024;
export const MAX_MEDIA_CANDIDATE_CHARS = 2048;

export type MediaControlMessageType =
  | 'SDP_OFFER'
  | 'SDP_ANSWER'
  | 'ICE_CANDIDATE'
  | 'MEDIA_KEYFRAME_REQUEST'
  | 'MEDIA_RESTART_REQUEST';
export type ControlMessageType =
  | 'REQUEST_SCREEN'
  | 'REQUEST_CANCEL'
  | 'ACCEPT_SCREEN'
  | 'DECLINE_SCREEN'
  | 'CAPTURE_DENIED'
  | MediaControlMessageType
  | 'SESSION_END'
  | 'SESSION_ERROR';

export type RequestScreenPayload = { expiresAt: string };
export type RequestCancelPayload = { reason: 'user' | 'timeout' };
export type AcceptScreenPayload = Record<string, never>;
export type DeclineScreenPayload = { reason: 'declined' | 'busy' };
export type CaptureDeniedPayload = { reason: 'system_denied' | 'notifications_denied' };
export type SdpPayload = { sdp: string };
export type IceCandidatePayload = { sdpMid: string; sdpMLineIndex: number; candidate: string };
export type MediaKeyframeRequestPayload = { reason: 'first_frame' };
export type MediaRestartRequestPayload = { reason: 'connection_lost' };
export type SessionEndPayload = { reason: 'user' | 'disconnect' | 'timeout' };
export type SessionErrorPayload = { reason: 'busy' | 'invalid_transition' | 'timeout' | 'auth_failed' | 'capture_failed' | 'capture_revoked' | 'media_failed' };

export interface ControlPayloadMap {
  REQUEST_SCREEN: RequestScreenPayload;
  REQUEST_CANCEL: RequestCancelPayload;
  ACCEPT_SCREEN: AcceptScreenPayload;
  DECLINE_SCREEN: DeclineScreenPayload;
  CAPTURE_DENIED: CaptureDeniedPayload;
  SDP_OFFER: SdpPayload;
  SDP_ANSWER: SdpPayload;
  ICE_CANDIDATE: IceCandidatePayload;
  MEDIA_KEYFRAME_REQUEST: MediaKeyframeRequestPayload;
  MEDIA_RESTART_REQUEST: MediaRestartRequestPayload;
  SESSION_END: SessionEndPayload;
  SESSION_ERROR: SessionErrorPayload;
}

export interface ControlMessage<T extends ControlMessageType = ControlMessageType> {
  version: typeof CONTROL_PROTOCOL_VERSION;
  messageId: string;
  type: T;
  sessionId: string;
  senderDeviceId: string;
  sequence: number;
  timestamp: string;
  payload: ControlPayloadMap[T];
}

export type AnyControlMessage = { [K in ControlMessageType]: ControlMessage<K> }[ControlMessageType];
export type AnyMediaControlMessage = { [K in MediaControlMessageType]: ControlMessage<K> }[MediaControlMessageType];

export interface Hello1Frame {
  kind: 'hello1'; version: typeof CONTROL_PROTOCOL_VERSION; helloId: string; sessionId: string; senderDeviceId: string; nonce: string; timestamp: string; mac: string;
}
export interface Hello2Frame {
  kind: 'hello2'; version: typeof CONTROL_PROTOCOL_VERSION; helloId: string; sessionId: string; senderDeviceId: string; nonce: string; echoNonce: string; initiatorDeviceId: string; timestamp: string; mac: string;
}
export type ControlHandshakeFrame = Hello1Frame | Hello2Frame;
export interface SealedControlFrame {
  kind: 'sealed'; version: typeof CONTROL_PROTOCOL_VERSION; sessionId: string; senderDeviceId: string; sequence: number; type: ControlMessageType; sealed: string;
}

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const NONCE_HEX_RE = /^[0-9a-f]{32}$/i;
export const MAC_HEX_RE = /^[0-9a-f]{64}$/i;

export function isMediaControlMessageType(value: unknown): value is MediaControlMessageType {
  return value === 'SDP_OFFER' ||
    value === 'SDP_ANSWER' ||
    value === 'ICE_CANDIDATE' ||
    value === 'MEDIA_KEYFRAME_REQUEST' ||
    value === 'MEDIA_RESTART_REQUEST';
}
export function isControlMessageType(value: unknown): value is ControlMessageType {
  return value === 'REQUEST_SCREEN' || value === 'REQUEST_CANCEL' || value === 'ACCEPT_SCREEN' || value === 'DECLINE_SCREEN' || value === 'CAPTURE_DENIED' || isMediaControlMessageType(value) || value === 'SESSION_END' || value === 'SESSION_ERROR';
}
