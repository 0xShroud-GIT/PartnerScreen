import { PermissionsAndroid, Platform } from 'react-native';
import PartnerScreenCaptureModule from '../../../modules/partner-screen-capture';
import type { PartnerScreenCaptureEvent } from '../../../modules/partner-screen-capture';
import type { ScreenCaptureNativeEvent, ScreenCapturePort } from '../../capture/ScreenCapturePort';

const SAFE_NATIVE_STATES = new Set(['idle', 'starting', 'capturing']);
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION_RE.test(value);
}

function parseEvent(value: unknown): PartnerScreenCaptureEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if ((event.type === 'starting' || event.type === 'started' || event.type === 'revoked')) {
    return validSession(event.sessionId) && Object.keys(event).every((key) => key === 'type' || key === 'sessionId')
      ? ({ type: event.type, sessionId: event.sessionId } as PartnerScreenCaptureEvent)
      : null;
  }
  if (event.type === 'stopped' && (event.reason === 'user' || event.reason === 'notification' || event.reason === 'service_destroyed') && Object.keys(event).every((key) => key === 'type' || key === 'reason' || key === 'sessionId')) {
    return validSession(event.sessionId)
      ? { type: 'stopped', reason: event.reason as 'user' | 'notification' | 'service_destroyed', sessionId: event.sessionId }
      : null;
  }
  if (event.type === 'error' && (event.code === 'capture_start_failed' || event.code === 'capture_unavailable') && Object.keys(event).every((key) => key === 'type' || key === 'code' || key === 'sessionId')) {
    return validSession(event.sessionId)
      ? { type: 'error', code: event.code as 'capture_start_failed' | 'capture_unavailable', sessionId: event.sessionId }
      : null;
  }
  return null;
}

export class ExpoScreenCapture implements ScreenCapturePort {
  private readonly listeners = new Set<(event: ScreenCaptureNativeEvent) => void>();
  private readonly nativeSubscription: { remove(): void };

  constructor() {
    this.nativeSubscription = PartnerScreenCaptureModule.addListener('onPartnerScreenCaptureEvent', (raw) => {
      const event = parseEvent(raw);
      if (!event) return;
      for (const listener of this.listeners) listener(event);
    });
  }

  subscribe(listener: (event: ScreenCaptureNativeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async ensureNotificationPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
    if (!Number.isFinite(apiLevel) || apiLevel < 33) return true;
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(permission)) return true;
    return (await PermissionsAndroid.request(permission)) === PermissionsAndroid.RESULTS.GRANTED;
  }

  async requestConsent(): Promise<boolean> {
    try { return await PartnerScreenCaptureModule.requestConsent(); }
    catch { return false; }
  }
  async start(sessionId: string): Promise<void> {
    if (!validSession(sessionId)) throw new Error('PartnerScreen could not start screen capture.');
    try { await PartnerScreenCaptureModule.startCapture(sessionId); } catch { throw new Error('PartnerScreen could not start screen capture.'); }
  }
  async stop(): Promise<void> {
    try {
      const stopped = await PartnerScreenCaptureModule.stopCapture();
      if (stopped === false) throw new Error('PartnerScreen could not stop screen capture cleanly.');
    } catch { throw new Error('PartnerScreen could not stop screen capture cleanly.'); }
  }
  getNativeState(): 'idle' | 'starting' | 'capturing' { const value = PartnerScreenCaptureModule.getState(); return SAFE_NATIVE_STATES.has(value) ? value as 'idle' | 'starting' | 'capturing' : 'idle'; }
  dispose(): void { this.nativeSubscription.remove(); this.listeners.clear(); }
}
