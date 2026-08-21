import type { ScreenCaptureState } from '../capture/ScreenCaptureCoordinator';
import type { MediaSessionState } from '../media/MediaSessionController';
import type { SessionState } from '../session/SessionState';

export type ProductPhase =
  | 'unpaired'
  | 'offline'
  | 'available'
  | 'request_pending'
  | 'incoming_request'
  | 'connected'
  | 'awaiting_consent'
  | 'starting_capture'
  | 'sharing'
  | 'connecting_video'
  | 'waiting_first_frame'
  | 'reconnecting'
  | 'live'
  | 'error';

export type ProductTone = 'neutral' | 'positive' | 'attention' | 'danger';

export interface ProductPresentation {
  phase: ProductPhase;
  label: string;
  detail: string;
  tone: ProductTone;
}

export interface ProductPresentationInput {
  session: SessionState;
  capture: ScreenCaptureState;
  media: MediaSessionState;
}

const presentation = (phase: ProductPhase, label: string, detail: string, tone: ProductTone): ProductPresentation => ({ phase, label, detail, tone });

export function deriveProductPresentation(input: ProductPresentationInput): ProductPresentation {
  const { session, capture, media } = input;

  if (session.type === 'Error' || capture.type === 'error' || media.type === 'error') {
    return presentation('error', 'Session stopped with an error', 'PartnerScreen failed closed. Review the sanitized message below, then retry from an available partner.', 'danger');
  }

  switch (session.type) {
    case 'Unpaired':
      return presentation('unpaired', 'Not paired', 'Pair one trusted phone before requesting a screen.', 'neutral');
    case 'PairedOffline':
      return presentation('offline', 'Trusted partner offline', 'The trusted phone is saved, but authenticated Wi-Fi availability is not currently proven.', 'neutral');
    case 'PairedAvailable':
      return presentation('available', 'Trusted partner available', 'Authenticated discovery and reachability are proven. No screen session is connected yet.', 'positive');
    case 'OutgoingRequest':
      return presentation('request_pending', 'Screen request pending', 'Waiting for the trusted partner to accept or decline. No screen capture is active.', 'attention');
    case 'IncomingRequest':
      return presentation('incoming_request', 'Incoming screen request', 'Accept or decline explicitly. Accepting still requires Android system screen-capture consent.', 'attention');
    case 'Connected':
      if (media.type === 'reconnecting' && media.sessionId === session.sessionId) {
        return presentation('reconnecting', 'Reconnecting private video', 'LIVE is off while PartnerScreen performs bounded private-LAN recovery.', 'attention');
      }

      if (session.role === 'sharer') {
        if (capture.type === 'requesting_consent' && capture.sessionId === session.sessionId) {
          return presentation('awaiting_consent', 'Waiting for Android consent', 'Android system consent is required before any screen capture can begin.', 'attention');
        }
        if (capture.type === 'starting' && capture.sessionId === session.sessionId) {
          return presentation('starting_capture', 'Starting screen capture', 'Consent was granted. PartnerScreen is starting the foreground capture service.', 'attention');
        }
        if (capture.type === 'capturing' && capture.sessionId === session.sessionId) {
          return presentation('sharing', 'Screen capture active', media.type === 'publishing' || media.type === 'negotiating' ? 'Your screen is being captured; private-LAN video is still connecting.' : 'Your screen is being captured for the accepted trusted-partner session.', 'positive');
        }
        return presentation('connected', 'Request accepted — capture not active', 'The authenticated session exists, but Android screen capture has not started.', 'neutral');
      }

      if (media.type === 'live' && media.sessionId === session.sessionId) {
        return presentation('live', 'LIVE — remote screen visible', 'The native renderer has produced an actual remote video frame.', 'positive');
      }
      if (media.type === 'remote_track_attached' && media.sessionId === session.sessionId) {
        return presentation('waiting_first_frame', 'Remote track attached — not LIVE yet', 'Waiting for the native renderer to produce the first actual remote frame.', 'attention');
      }
      if (media.type === 'negotiating' && media.sessionId === session.sessionId) {
        return presentation('connecting_video', 'Connecting private video', 'The authenticated session is connected; private-LAN video negotiation is still in progress.', 'attention');
      }
      return presentation('connected', 'Authenticated session connected', 'Waiting for the sharing phone to start screen capture and private video.', 'neutral');
    default: {
      const exhaustive: never = session;
      return exhaustive;
    }
  }
}
