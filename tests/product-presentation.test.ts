import assert from 'node:assert/strict';
import test from 'node:test';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import { deriveProductPresentation } from '../src/presentation/ProductPresentation';

const pair: PairTrustMetadata = {
  schemaVersion: 1,
  protocolVersion: 1,
  status: 'committed',
  pairId: '11111111-1111-4111-8111-111111111111',
  partnerDeviceId: '22222222-2222-4222-8222-222222222222',
  partnerDeviceName: 'Partner',
  pairedAt: '2026-08-19T00:00:00.000Z',
};
const sessionId = '33333333-3333-4333-8333-333333333333';

const derive = (
  session: Parameters<typeof deriveProductPresentation>[0]['session'],
  capture: Parameters<typeof deriveProductPresentation>[0]['capture'] = { type: 'idle' },
  media: Parameters<typeof deriveProductPresentation>[0]['media'] = { type: 'idle' },
) => deriveProductPresentation({ session, capture, media });

test('unpaired and offline states do not imply availability or connection', () => {
  assert.equal(derive({ type: 'Unpaired' }).phase, 'unpaired');
  const offline = derive({ type: 'PairedOffline', pair });
  assert.equal(offline.phase, 'offline');
  assert.match(offline.detail, /not currently proven/i);
});

test('available explicitly remains pre-session', () => {
  const state = derive({ type: 'PairedAvailable', pair, endpoint: { host: '192.168.1.20', port: 34567 } });
  assert.equal(state.phase, 'available');
  assert.match(state.detail, /No screen session is connected yet/i);
});

test('outgoing and incoming requests remain explicit pre-capture states', () => {
  const outgoing = derive({ type: 'OutgoingRequest', pair, sessionId, expiresAt: '2026-08-19T00:01:00.000Z' });
  assert.equal(outgoing.phase, 'request_pending');
  assert.match(outgoing.detail, /No screen capture is active/i);
  const incoming = derive({ type: 'IncomingRequest', pair, sessionId, expiresAt: '2026-08-19T00:01:00.000Z' });
  assert.equal(incoming.phase, 'incoming_request');
  assert.match(incoming.detail, /Android system screen-capture consent/i);
});

test('sharer distinguishes accepted, consent, starting and active capture', () => {
  const connected = { type: 'Connected', pair, sessionId, role: 'sharer' } as const;
  assert.equal(derive(connected).phase, 'connected');
  assert.equal(derive(connected, { type: 'requesting_consent', sessionId }).phase, 'awaiting_consent');
  assert.equal(derive(connected, { type: 'starting', sessionId }).phase, 'starting_capture');
  assert.equal(derive(connected, { type: 'capturing', sessionId }).phase, 'sharing');
});

test('remote track attachment is explicitly not LIVE', () => {
  const requester = { type: 'Connected', pair, sessionId, role: 'requester' } as const;
  const state = derive(requester, { type: 'idle' }, { type: 'remote_track_attached', sessionId, quality: 'good', trackEpoch: 1 });
  assert.equal(state.phase, 'waiting_first_frame');
  assert.match(state.label, /not LIVE yet/i);
  assert.match(state.detail, /first actual remote frame/i);
});

test('reconnecting removes LIVE truth', () => {
  const requester = { type: 'Connected', pair, sessionId, role: 'requester' } as const;
  const state = derive(requester, { type: 'idle' }, { type: 'reconnecting', sessionId, role: 'requester', attempt: 2, quality: 'reconnecting' });
  assert.equal(state.phase, 'reconnecting');
  assert.match(state.detail, /LIVE is off/i);
});

test('LIVE requires authoritative media live state', () => {
  const requester = { type: 'Connected', pair, sessionId, role: 'requester' } as const;
  const state = derive(requester, { type: 'idle' }, { type: 'live', sessionId, quality: 'good', trackEpoch: 1 });
  assert.equal(state.phase, 'live');
  assert.match(state.detail, /actual remote video frame/i);
});

test('encoder bitrate warning is omitted for viewers and applied senders', () => {
  const requester = { type: 'Connected', pair, sessionId, role: 'requester' } as const;
  const viewerFailed = deriveProductPresentation({
    session: requester,
    capture: { type: 'idle' },
    media: { type: 'live', sessionId, quality: 'good', trackEpoch: 1 },
    mediaStats: { measuredBitrateBps: 400_000, bitrateParametersState: 'failed' },
  });
  assert.equal(viewerFailed.phase, 'live');
  assert.doesNotMatch(viewerFailed.detail, /encoder bitrate cap/i);

  const sharer = { type: 'Connected', pair, sessionId, role: 'sharer' } as const;
  const applied = deriveProductPresentation({
    session: sharer,
    capture: { type: 'capturing', sessionId },
    media: { type: 'publishing', sessionId, quality: 'good' },
    mediaStats: { bitrateParametersState: 'applied' },
  });
  assert.equal(applied.phase, 'sharing');
  assert.doesNotMatch(applied.detail, /encoder bitrate cap/i);

  const failed = deriveProductPresentation({
    session: sharer,
    capture: { type: 'capturing', sessionId },
    media: { type: 'publishing', sessionId, quality: 'good' },
    mediaStats: { bitrateParametersState: 'failed' },
  });
  assert.equal(failed.phase, 'sharing');
  assert.match(failed.detail, /encoder bitrate cap was not applied/i);
});

test('any authoritative error fails closed in presentation', () => {
  assert.equal(derive({ type: 'Error', pair, message: 'safe' }).phase, 'error');
  assert.equal(derive({ type: 'PairedOffline', pair }, { type: 'error', message: 'safe' }).phase, 'error');
  assert.equal(derive({ type: 'PairedOffline', pair }, { type: 'idle' }, { type: 'error', message: 'safe' }).phase, 'error');
});
