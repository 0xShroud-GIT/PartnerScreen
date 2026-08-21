import { NativeModule, requireNativeModule } from 'expo';
import type { PartnerScreenCaptureModuleEvents } from './PartnerScreenCapture.types';

declare class PartnerScreenCaptureModule extends NativeModule<PartnerScreenCaptureModuleEvents> {
  requestConsent(): Promise<boolean>;
  startCapture(sessionId: string): Promise<boolean>;
  stopCapture(): Promise<boolean>;
  getState(): string;
  prepareRequesterMedia(sessionId: string): Promise<boolean>;
  createPublisherOffer(sessionId: string): Promise<string>;
  acceptOffer(sessionId: string, sdp: string): Promise<string>;
  acceptAnswer(sessionId: string, sdp: string): Promise<boolean>;
  addIceCandidate(sessionId: string, sdpMid: string, sdpMLineIndex: number, candidate: string): Promise<boolean>;
  closeMedia(sessionId: string): Promise<boolean>;
  restartIce(sessionId: string): Promise<boolean>;
  getMediaStats(sessionId: string): Promise<Record<string, unknown> | null>;
}

export default requireNativeModule<PartnerScreenCaptureModule>('PartnerScreenCapture');
