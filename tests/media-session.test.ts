import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEDIA_INITIAL_USABLE_VIDEO_DEADLINE_MS,
  MEDIA_RECONNECT_ATTEMPT_TIMEOUT_MS,
  MEDIA_RECONNECT_MAX_ATTEMPTS,
  MEDIA_STATS_POLL_INTERVAL_MS,
  MediaSessionController,
  type CaptureStateSource,
  type MediaRecoveryScheduler,
  type MediaSessionAuthority,
  type RecoveryTimer,
} from '../src/media/MediaSessionController';
import type { SanitizedMediaStats } from '../src/media/MediaStats';
import type { WebRtcMediaNativeEvent, WebRtcMediaPort } from '../src/media/WebRtcMediaPort';
import type { AnyMediaControlMessage, ControlPayloadMap, MediaControlMessageType } from '../src/protocol/ControlMessage';
import type { ScreenCaptureState } from '../src/capture/ScreenCaptureCoordinator';
import type { SessionState } from '../src/session/SessionState';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';
import type { DiagnosticEventKind } from '../src/domain/diagnostics/DiagnosticEvent';

const sessionId = '33333333-3333-4333-8333-333333333333';
const partnerId = '22222222-2222-4222-8222-222222222222';
const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '44444444-4444-4444-8444-444444444444', partnerDeviceId: partnerId, partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };
const safeSdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n';
const safeCandidate = 'candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0';

class FakeNative implements WebRtcMediaPort {
  listeners = new Set<(event: WebRtcMediaNativeEvent) => void>(); prepared: string[] = []; offers = 0; offerSessions: string[] = []; acceptedOffers = 0; acceptedAnswers = 0; candidates = 0; closed: string[] = [];
  deferCreatePublisher = false;
  deferAcceptOffer = false;
  private readonly pendingCreatePublisher: Array<{ resolve: (sdp: string) => void; reject: (error: Error) => void }> = [];
  private readonly pendingAcceptOffer: Array<{ resolve: (sdp: string) => void; reject: (error: Error) => void }> = [];
  subscribe(listener: (event: WebRtcMediaNativeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async prepareRequester(id: string): Promise<void> { this.prepared.push(id); }
  async createPublisherOffer(id: string): Promise<string> {
    this.offers += 1; this.offerSessions.push(id);
    if (this.deferCreatePublisher) return new Promise<string>((resolve, reject) => this.pendingCreatePublisher.push({ resolve, reject }));
    return safeSdp;
  }
  resolveCreatePublisher(sdp: string): void { const pending = this.pendingCreatePublisher.shift(); if (pending) pending.resolve(sdp); }
  rejectCreatePublisher(): void { const pending = this.pendingCreatePublisher.shift(); if (pending) pending.reject(new Error('delayed native offer failure')); }
  pendingCreatePublisherCount(): number { return this.pendingCreatePublisher.length; }
  async acceptOffer(id: string, sdp: string): Promise<string> {
    this.acceptedOffers += 1;
    if (this.deferAcceptOffer) return new Promise<string>((resolve, reject) => this.pendingAcceptOffer.push({ resolve, reject }));
    return safeSdp;
  }
  resolveAcceptOffer(sdp: string): void { const pending = this.pendingAcceptOffer.shift(); if (pending) pending.resolve(sdp); }
  pendingAcceptOfferCount(): number { return this.pendingAcceptOffer.length; }
  async acceptAnswer(): Promise<void> { this.acceptedAnswers += 1; }
  async addIceCandidate(): Promise<void> { this.candidates += 1; }
  async close(id: string): Promise<void> { this.closed.push(id); }
  stats: SanitizedMediaStats | null = null;
  async getStats(): Promise<SanitizedMediaStats | null> { return this.stats; }
  emit(event: WebRtcMediaNativeEvent): void { for (const listener of this.listeners) listener(event); }
}
class FakeSession implements MediaSessionAuthority {
  state: SessionState = { type: 'Connected', pair, sessionId, role: 'requester' };
  listeners = new Set<() => void>(); mediaListeners = new Set<(message: AnyMediaControlMessage) => void>(); sent: Array<{ sessionId: string; type: MediaControlMessageType; payload: unknown }> = []; failed = 0; failedSessionIds: string[] = [];
  getSnapshot = (): SessionState => this.state;
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeMedia(listener: (message: AnyMediaControlMessage) => void): () => void { this.mediaListeners.add(listener); return () => this.mediaListeners.delete(listener); }
  async sendMedia<T extends MediaControlMessageType>(expectedSessionId: string, type: T, payload: ControlPayloadMap[T]): Promise<void> { this.sent.push({ sessionId: expectedSessionId, type, payload }); }
  async mediaFailed(expectedSessionId: string): Promise<void> { this.failed += 1; this.failedSessionIds.push(expectedSessionId); }
  setState(state: SessionState): void { this.state = state; for (const listener of this.listeners) listener(); }
  emit(message: AnyMediaControlMessage): void { for (const listener of this.mediaListeners) listener(message); }
}
class FakeCapture implements CaptureStateSource {
  state: ScreenCaptureState = { type: 'idle' }; listeners = new Set<() => void>();
  getSnapshot = (): ScreenCaptureState => this.state;
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setState(state: ScreenCaptureState): void { this.state = state; for (const listener of this.listeners) listener(); }
}
class Diagnostics { events: DiagnosticEventKind[] = []; async append(kind: DiagnosticEventKind): Promise<void> { this.events.push(kind); } }
class FakeScheduler implements MediaRecoveryScheduler {
  tasks: Array<{ delay: number; task: () => void; cancelled: boolean }> = [];
  schedule(delay: number, task: () => void): RecoveryTimer {
    const entry = { delay, task, cancelled: false }; this.tasks.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  }
  runNext(): void {
    const entry = this.tasks.find((task) => !task.cancelled);
    assert.ok(entry, 'expected scheduled recovery task'); entry.cancelled = true; entry.task();
  }
  pending(): number { return this.tasks.filter((task) => !task.cancelled).length; }
}
async function settle(): Promise<void> { for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }
function msg<T extends MediaControlMessageType>(type: T, payload: ControlPayloadMap[T]): AnyMediaControlMessage { return { version: 1, messageId: '55555555-5555-4555-8555-555555555555', type, sessionId, senderDeviceId: partnerId, sequence: 1, timestamp: '2026-08-19T00:00:00.000Z', payload } as AnyMediaControlMessage; }
function harness(nowMs?: () => number) { const native = new FakeNative(), session = new FakeSession(), capture = new FakeCapture(), diagnostics = new Diagnostics(), scheduler = new FakeScheduler(); const media = new MediaSessionController(native, session, capture, diagnostics, scheduler, nowMs); return { native, session, capture, diagnostics, scheduler, media }; }

async function makeLive(h: ReturnType<typeof harness>): Promise<void> {
  await settle(); h.native.emit({ type: 'remote_track', sessionId }); await settle();
  const state = h.media.getSnapshot();
  if (state.type === 'remote_track_attached') await h.media.rendererFirstFrame(sessionId, state.trackEpoch);
  assert.equal(h.media.getSnapshot().type, 'live');
}

test('requester prepares native peer but connected/ICE state never becomes LIVE', async () => {
  const h = harness(); await settle(); assert.deepEqual(h.native.prepared, [sessionId]); assert.equal(h.media.getSnapshot().type, 'negotiating');
  h.native.emit({ type: 'connection_state', sessionId, state: 'connected' }); await settle(); assert.notEqual(h.media.getSnapshot().type, 'live'); h.media.dispose();
});

test('remote track alone is not LIVE and renderer callback before track is ignored', async () => {
  const h = harness(); await settle(); await h.media.rendererFirstFrame(sessionId, 0); assert.notEqual(h.media.getSnapshot().type, 'live');
  h.native.emit({ type: 'remote_track', sessionId }); await settle(); assert.equal(h.media.getSnapshot().type, 'remote_track_attached'); h.media.dispose();
});

test('LIVE requires remote track attached plus actual renderer first-frame callback', async () => {
  const h = harness(); await makeLive(h); assert.ok(h.diagnostics.events.includes('media_first_frame')); h.media.dispose();
});

test('capturing sharer creates offer only after capture is active', async () => {
  const h = harness(); h.session.setState({ type: 'Connected', pair, sessionId, role: 'sharer' }); await settle(); assert.equal(h.native.offers, 0);
  h.capture.setState({ type: 'capturing', sessionId }); await settle(); assert.equal(h.native.offers, 1); assert.equal(h.session.sent.at(-1)?.type, 'SDP_OFFER'); assert.equal(h.media.getSnapshot().type, 'publishing'); h.media.dispose();
});

test('authenticated offer/answer and private host ICE are routed through session authority', async () => {
  const h = harness(); await settle(); h.session.emit(msg('SDP_OFFER', { sdp: safeSdp })); await settle(); assert.equal(h.native.acceptedOffers, 1); assert.equal(h.session.sent.at(-1)?.type, 'SDP_ANSWER');
  h.session.emit(msg('ICE_CANDIDATE', { sdpMid: '0', sdpMLineIndex: 0, candidate: safeCandidate })); await settle(); assert.equal(h.native.candidates, 1); h.media.dispose();
});

test('requester disconnect removes LIVE immediately and starts bounded authenticated recovery', async () => {
  const h = harness(); await makeLive(h); h.native.emit({ type: 'connection_state', sessionId, state: 'disconnected' }); await settle();
  const state = h.media.getSnapshot(); assert.equal(state.type, 'reconnecting'); if (state.type === 'reconnecting') assert.equal(state.attempt, 1); assert.equal(h.scheduler.pending(), 1); assert.ok(h.diagnostics.events.includes('media_degraded')); assert.ok(h.diagnostics.events.includes('media_reconnect_attempt'));
  h.scheduler.runNext(); await settle(); assert.equal(h.session.sent.at(-1)?.type, 'MEDIA_RESTART_REQUEST'); assert.ok(h.native.closed.includes(sessionId)); assert.ok(h.native.prepared.length >= 2); h.media.dispose();
});

test('requester re-earns LIVE only after a new remote track and new renderer frame', async () => {
  const h = harness(); await makeLive(h); h.native.emit({ type: 'connection_state', sessionId, state: 'disconnected' }); await settle(); h.scheduler.runNext(); await settle();
  h.session.emit(msg('SDP_OFFER', { sdp: safeSdp })); await settle(); assert.equal(h.session.sent.at(-1)?.type, 'SDP_ANSWER'); assert.notEqual(h.media.getSnapshot().type, 'live');
  h.native.emit({ type: 'remote_track', sessionId }); await settle(); assert.equal(h.media.getSnapshot().type, 'remote_track_attached'); assert.notEqual(h.media.getSnapshot().type, 'live');
  const reEpoch = (h.media.getSnapshot() as { trackEpoch: number }).trackEpoch;
  await h.media.rendererFirstFrame(sessionId, reEpoch); assert.equal(h.media.getSnapshot().type, 'live'); assert.ok(h.diagnostics.events.includes('media_reconnected')); h.media.dispose();
});

test('recovered remote track without rendered frame advances bounded recovery', async () => {
  const h = harness(); await makeLive(h); h.native.emit({ type: 'connection_state', sessionId, state: 'disconnected' }); await settle(); h.scheduler.runNext(); await settle();
  h.session.emit(msg('SDP_OFFER', { sdp: safeSdp })); await settle();
  h.native.emit({ type: 'remote_track', sessionId }); await settle(); assert.equal(h.media.getSnapshot().type, 'remote_track_attached'); assert.equal(h.scheduler.pending(), 1);
  h.native.emit({ type: 'connection_state', sessionId, state: 'connected' }); await settle(); assert.equal(h.media.getSnapshot().type, 'remote_track_attached'); assert.equal(h.scheduler.pending(), 1);
  h.scheduler.runNext(); await settle(); const state = h.media.getSnapshot(); assert.equal(state.type, 'reconnecting'); if (state.type === 'reconnecting') assert.equal(state.attempt, 2); assert.equal(h.scheduler.pending(), 1); assert.notEqual(state.type, 'live'); h.media.dispose();
});

test('sharer is the only restart offer authority and returns to publishing when connected', async () => {
  const h = harness(); h.session.setState({ type: 'Connected', pair, sessionId, role: 'sharer' }); h.capture.setState({ type: 'capturing', sessionId }); await settle(); const initialOffers = h.native.offers;
  h.session.emit(msg('MEDIA_RESTART_REQUEST', { reason: 'connection_lost' })); await settle(); assert.equal(h.media.getSnapshot().type, 'reconnecting'); h.scheduler.runNext(); await settle(); assert.equal(h.native.offers, initialOffers + 1); assert.equal(h.session.sent.at(-1)?.type, 'SDP_OFFER');
  h.native.emit({ type: 'connection_state', sessionId, state: 'connected' }); await settle(); const state = h.media.getSnapshot(); assert.equal(state.type, 'publishing'); if (state.type === 'publishing') assert.equal(state.quality, 'good'); assert.ok(h.diagnostics.events.includes('media_reconnected')); h.media.dispose();
});

test('requester cannot turn a restart request into competing offer authority', async () => {
  const h = harness(); await settle(); h.session.emit(msg('MEDIA_RESTART_REQUEST', { reason: 'connection_lost' })); await settle(); assert.equal(h.session.failed, 1); assert.equal(h.media.getSnapshot().type, 'error'); assert.equal(h.native.offers, 0); h.media.dispose();
});

test('planned native close during reconnect does not become a phantom failure', async () => {
  const h = harness(); await makeLive(h); h.native.emit({ type: 'connection_state', sessionId, state: 'disconnected' }); await settle(); h.native.emit({ type: 'connection_state', sessionId, state: 'closed' }); await settle(); assert.equal(h.session.failed, 0); assert.equal(h.media.getSnapshot().type, 'reconnecting'); h.media.dispose();
});

test('recovery is capped and fails closed after the configured attempts', async () => {
  const h = harness(); await makeLive(h); h.native.emit({ type: 'connection_state', sessionId, state: 'failed' }); await settle();
  for (let attempt = 0; attempt < MEDIA_RECONNECT_MAX_ATTEMPTS; attempt += 1) {
    if (h.scheduler.pending()) { h.scheduler.runNext(); await settle(); }
    if (attempt < MEDIA_RECONNECT_MAX_ATTEMPTS - 1) { h.native.emit({ type: 'connection_state', sessionId, state: 'failed' }); await settle(); }
  }
  h.native.emit({ type: 'connection_state', sessionId, state: 'failed' }); await settle(); assert.equal(h.media.getSnapshot().type, 'error'); assert.equal(h.session.failed, 1); h.media.dispose();
});

test('session teardown cancels recovery and closes media idempotently', async () => {
  const h = harness(); await makeLive(h); h.native.emit({ type: 'connection_state', sessionId, state: 'disconnected' }); await settle(); assert.equal(h.scheduler.pending(), 1);
  h.session.setState({ type: 'PairedOffline', pair }); await settle(); assert.equal(h.media.getSnapshot().type, 'idle'); assert.equal(h.scheduler.pending(), 0); const closes = h.native.closed.length;
  await h.media.reconcile(); await settle(); assert.equal(h.native.closed.length, closes); h.media.dispose();
});

test('authenticated RTC message with a wrong sessionId is ignored and never routed to native media nor terminates the current session', async () => {
  const h = harness(); await settle();
  const wrongSession = '99999999-9999-4999-8999-999999999999';
  h.session.emit({ version: 1, messageId: '55555555-5555-4555-8555-555555555555', type: 'SDP_OFFER', sessionId: wrongSession, senderDeviceId: partnerId, sequence: 1, timestamp: '2026-08-19T00:00:00.000Z', payload: { sdp: safeSdp } } as AnyMediaControlMessage);
  await settle();
  assert.equal(h.native.acceptedOffers, 0); // stale offer never reached native
  assert.equal(h.session.failed, 0);        // current session untouched
  assert.notEqual(h.media.getSnapshot().type, 'error');
  h.media.dispose();
});

test('first-frame callback for a wrong session or a duplicate after LIVE is ignored and cannot re-enter LIVE', async () => {
  const h = harness(); await makeLive(h); const before = h.diagnostics.events.filter((e) => e === 'media_first_frame').length;
  await h.media.rendererFirstFrame('99999999-9999-4999-8999-999999999999', 0); // wrong session
  const liveEpoch = (h.media.getSnapshot() as { trackEpoch: number }).trackEpoch;
  await h.media.rendererFirstFrame(sessionId, liveEpoch); // duplicate after LIVE
  await settle();
  assert.equal(h.media.getSnapshot().type, 'live');
  const after = h.diagnostics.events.filter((e) => e === 'media_first_frame').length;
  assert.equal(after, before); // no second LIVE entry, no duplicate record
  h.media.dispose();
});

test('stale native media callbacks after the product session is terminal cannot mutate state or re-enter LIVE', async () => {
  const h = harness(); await makeLive(h);
  h.session.setState({ type: 'PairedOffline', pair }); await settle();
  assert.equal(h.media.getSnapshot().type, 'idle');
  // Late native events for the dead session must be discarded, not applied.
  h.native.emit({ type: 'remote_track', sessionId }); await settle();
  h.native.emit({ type: 'connection_state', sessionId, state: 'connected' }); await settle();
  h.native.emit({ type: 'connection_state', sessionId, state: 'failed' }); await settle();
  await h.media.rendererFirstFrame(sessionId, 0); await settle();
  assert.equal(h.media.getSnapshot().type, 'idle'); // never remote_track_attached, reconnecting, or live
  assert.equal(h.session.failed, 0); // terminal session not re-entered
  h.media.dispose();
});

test('a replacement product session discards the old media session and prepares fresh native resources', async () => {
  const h = harness(); await settle(); assert.ok(h.native.prepared.includes(sessionId));
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  h.session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'requester' }); await settle();
  assert.ok(h.native.closed.includes(sessionId));             // old media closed, never resurrected
  assert.ok(h.native.prepared.includes(replacementSessionId)); // fresh native peer for replacement
  // A stale remote-track callback from the old session cannot mark the replacement remote_track_attached.
  h.native.emit({ type: 'remote_track', sessionId }); await settle();
  assert.notEqual(h.media.getSnapshot().type, 'remote_track_attached');
  h.media.dispose();
});

test('a delayed publisher offer from a replaced sharer session is never signaled over the fresh session', async () => {
  const h = harness();
  h.session.setState({ type: 'Connected', pair, sessionId, role: 'sharer' }); await settle();
  h.native.deferCreatePublisher = true;
  h.capture.setState({ type: 'capturing', sessionId }); await settle();
  assert.equal(h.native.pendingCreatePublisherCount(), 1); // session A offer in flight
  h.native.deferCreatePublisher = false;
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  h.session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'sharer' });
  h.capture.setState({ type: 'capturing', sessionId: replacementSessionId }); await settle();
  h.native.resolveCreatePublisher(safeSdp); // delayed A offer result
  await settle();
  assert.equal(h.session.sent.some((m) => m.type === 'SDP_OFFER' && m.sessionId === sessionId), false); // A never signaled
  assert.equal(h.session.sent.some((m) => m.type === 'SDP_OFFER' && m.sessionId === replacementSessionId), true); // B signaled fresh
  assert.equal(h.session.failed, 0); // A's delay never terminated B
  h.media.dispose();
});

test('a delayed offer failure from a replaced sharer session cannot terminate the fresh session', async () => {
  const h = harness();
  h.session.setState({ type: 'Connected', pair, sessionId, role: 'sharer' }); await settle();
  h.native.deferCreatePublisher = true;
  h.capture.setState({ type: 'capturing', sessionId }); await settle();
  assert.equal(h.native.pendingCreatePublisherCount(), 1);
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  h.native.deferCreatePublisher = false;
  h.session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'sharer' });
  h.capture.setState({ type: 'capturing', sessionId: replacementSessionId }); await settle();
  h.native.rejectCreatePublisher(); // delayed A failure
  await settle();
  assert.equal(h.session.failed, 0); // stale failure must not terminate B
  assert.equal(h.media.getSnapshot().type, 'publishing'); // B still publishing
  h.media.dispose();
});

test('a delayed answer from a replaced requester session is never signaled over the fresh session', async () => {
  const h = harness(); await settle();
  h.native.deferAcceptOffer = true;
  h.session.emit(msg('SDP_OFFER', { sdp: safeSdp })); await settle();
  assert.equal(h.native.pendingAcceptOfferCount(), 1); // session A answer in flight
  h.native.deferAcceptOffer = false;
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  h.session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'requester' }); await settle();
  h.native.resolveAcceptOffer(safeSdp); // delayed A answer result
  await settle();
  assert.equal(h.session.sent.some((m) => m.type === 'SDP_ANSWER' && m.sessionId === sessionId), false); // A answer never sent
  assert.equal(h.session.failed, 0); // A's delay never terminated B
  h.media.dispose();
});

test('a stale native failure event from a replaced media session cannot terminate the fresh session', async () => {
  const h = harness();
  h.session.setState({ type: 'Connected', pair, sessionId, role: 'sharer' }); await settle();
  h.capture.setState({ type: 'capturing', sessionId }); await settle();
  assert.equal(h.native.offers, 1);
  const replacementSessionId = '88888888-8888-4888-8888-888888888888';
  h.session.setState({ type: 'Connected', pair, sessionId: replacementSessionId, role: 'sharer' });
  h.capture.setState({ type: 'capturing', sessionId: replacementSessionId }); await settle();
  h.native.emit({ type: 'connection_state', sessionId, state: 'failed' }); await settle(); // stale A failure
  assert.equal(h.session.failed, 0);
  assert.notEqual(h.media.getSnapshot().type, 'error');
  h.media.dispose();
});

test('a stale first-frame callback from a replaced renderer epoch cannot make the new track LIVE', async () => {
  const h = harness(); await settle();
  h.native.emit({ type: 'remote_track', sessionId }); await settle(); // track A -> epoch 1
  const epochA = (h.media.getSnapshot() as { trackEpoch: number }).trackEpoch;
  h.native.emit({ type: 'remote_track', sessionId }); await settle(); // track B replaces -> epoch 2
  const epochB = (h.media.getSnapshot() as { trackEpoch: number }).trackEpoch;
  assert.notEqual(epochA, epochB);
  await h.media.rendererFirstFrame(sessionId, epochA); await settle(); // stale renderer A callback
  assert.notEqual(h.media.getSnapshot().type, 'live');
  await h.media.rendererFirstFrame(sessionId, epochB); await settle(); // renderer B first frame
  assert.equal(h.media.getSnapshot().type, 'live');
  h.media.dispose();
});

test('initial usable-video deadline fails closed when no first frame arrives', async () => {
  const h = harness(); await settle();
  assert.equal(h.media.getSnapshot().type, 'negotiating');
  assert.ok(h.scheduler.tasks.some((task) => !task.cancelled && task.delay === MEDIA_INITIAL_USABLE_VIDEO_DEADLINE_MS));
  h.scheduler.runNext(); await settle();
  assert.equal(h.media.getSnapshot().type, 'error');
  assert.equal(h.session.failed, 1);
  h.media.dispose();
});

test('sharer reconnect attempt has an unconditional timeout when ICE never connects', async () => {
  const h = harness();
  h.session.setState({ type: 'Connected', pair, sessionId, role: 'sharer' });
  h.capture.setState({ type: 'capturing', sessionId }); await settle();
  h.session.emit(msg('MEDIA_RESTART_REQUEST', { reason: 'connection_lost' })); await settle();
  h.scheduler.runNext(); await settle();
  assert.equal(h.media.getSnapshot().type, 'reconnecting');
  assert.ok(h.scheduler.tasks.some((task) => !task.cancelled && task.delay === MEDIA_RECONNECT_ATTEMPT_TIMEOUT_MS));
  h.scheduler.runNext(); await settle();
  const state = h.media.getSnapshot();
  assert.equal(state.type, 'reconnecting');
  if (state.type === 'reconnecting') assert.equal(state.attempt, 2);
  h.media.dispose();
});

test('production media stats are sanitized, measured, and can mark publishing degraded', async () => {
  let now = 1_000;
  const h = harness(() => now);
  h.session.setState({ type: 'Connected', pair, sessionId, role: 'sharer' });
  h.capture.setState({ type: 'capturing', sessionId }); await settle();
  h.native.emit({ type: 'connection_state', sessionId, state: 'connected' }); await settle();
  assert.equal(h.media.getSnapshot().type, 'publishing');
  h.native.stats = { bytesSent: 10_000, packetsLost: 0, framesPerSecond: 20, bitrateParametersApplied: true };
  assert.ok(h.scheduler.tasks.some((task) => !task.cancelled && task.delay === MEDIA_STATS_POLL_INTERVAL_MS));
  h.scheduler.runNext(); await settle();
  assert.equal(h.media.getStatsSnapshot()?.bytesSent, 10_000);
  assert.equal((h.media.getStatsSnapshot() as { sdp?: unknown } | null)?.sdp, undefined);
  now = 2_500;
  h.native.stats = { bytesSent: 80_000, packetsLost: 24, roundTripTime: 0.45, bitrateParametersApplied: false };
  h.scheduler.runNext(); await settle();
  const publishing = h.media.getSnapshot();
  assert.equal(publishing.type, 'publishing');
  if (publishing.type === 'publishing') assert.equal(publishing.quality, 'degraded');
  assert.ok((h.media.getStatsSnapshot()?.measuredBitrateBps ?? 0) > 0);
  assert.equal(h.media.getStatsSnapshot()?.bitrateParametersApplied, false);
  assert.ok(h.diagnostics.events.includes('media_stats'));
  h.media.dispose();
});
