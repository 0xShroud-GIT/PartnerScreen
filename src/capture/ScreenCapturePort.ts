export type CaptureStopReason = 'user' | 'notification' | 'service_destroyed';
export type ScreenCaptureNativeEvent =
  | { type: 'starting'; sessionId: string }
  | { type: 'started'; sessionId: string }
  | { type: 'stopped'; reason: CaptureStopReason; sessionId: string }
  | { type: 'revoked'; sessionId: string }
  | { type: 'error'; code: 'capture_start_failed' | 'capture_unavailable'; sessionId: string };

export interface ScreenCapturePort {
  subscribe(listener: (event: ScreenCaptureNativeEvent) => void): () => void;
  ensureNotificationPermission(): Promise<boolean>;
  requestConsent(): Promise<boolean>;
  start(sessionId: string): Promise<void>;
  stop(): Promise<void>;
  getNativeState(): 'idle' | 'starting' | 'capturing';
}
