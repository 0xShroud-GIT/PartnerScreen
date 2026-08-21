import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIceCandidate, sanitizeIceClassification } from '../src/media/IceCandidateClassification';
import { MediaSessionController, type CaptureStateSource, type MediaRecoveryScheduler, type MediaSessionAuthority, type RecoveryTimer } from '../src/media/MediaSessionController';
import type { SanitizedMediaStats } from '../src/media/MediaStats';
import type { WebRtcMediaNativeEvent, WebRtcMediaPort } from '../src/media/WebRtcMediaPort';
import type { AnyMediaControlMessage, ControlPayloadMap, MediaControlMessageType } from '../src/protocol/ControlMessage';
import type { ScreenCaptureState } from '../src/capture/ScreenCaptureCoordinator';
import type { SessionState } from '../src/session/SessionState';
import type { PairTrustMetadata } from '../src/domain/pairing/PairTrustRepository';

const sessionId = '33333333-3333-4333-8333-333333333333';
const pair: PairTrustMetadata = { schemaVersion: 1, protocolVersion: 1, status: 'confirmed', pairId: '44444444-4444-4444-8444-444444444444', partnerDeviceId: '22222222-2222-4222-8222-222222222222', partnerDeviceName: 'Claire', pairedAt: '2026-08-18T12:00:00.000Z' };

class FakeNative implements WebRtcMediaPort {
  listeners = new Set<(event: WebRtcMediaNativeEvent) => void>();
  subscribe(listener: (event: WebRtcMediaNativeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async prepareRequester(): Promise<void> {}
  async createPublisherOffer(): Promise<string> { return 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'; }
  async acceptOffer(): Promise<string> { return 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'; }
  async acceptAnswer(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  async close(): Promise<void> {}
  async getStats(): Promise<SanitizedMediaStats | null> { return { framesEncoded: 12, framesDecoded: 9, bytesSent: 100, bytesReceived: 80, framesCaptured: 20, framesEnteringSender: 18 }; }
  emit(event: WebRtcMediaNativeEvent): void { for (const listener of this.listeners) listener(event); }
}
class FakeSession implements MediaSessionAuthority {
  state: SessionState = { type: 'Connected', pair, sessionId, role: 'requester' };
  getSnapshot = (): SessionState => this.state;
  subscribe(): () => void { return () => undefined; }
  subscribeMedia(): () => void { return () => undefined; }
  async sendMedia<T extends MediaControlMessageType>(_id: string, _type: T, _payload: ControlPayloadMap[T]): Promise<void> {}
  async mediaFailed(): Promise<void> {}
}
class FakeCapture implements CaptureStateSource {
  getSnapshot = (): ScreenCaptureState => ({ type: 'idle' });
  subscribe(): () => void { return () => undefined; }
}
class Diagnostics { async append(): Promise<void> {} }
class ImmediateScheduler implements MediaRecoveryScheduler {
  schedule(_delayMs: number, _task: () => void): RecoveryTimer { return { cancel() {} }; }
}
async function settle(): Promise<void> { for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }

test('candidate classification never returns addresses, SDP, or credentials', () => {
  const host = classifyIceCandidate('local', 'candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0');
  assert.equal(host.accepted, true);
  assert.equal(host.candidateType, 'host');
  assert.equal(host.transport, 'udp');
  assert.equal(host.addressFamily, 'ipv4');
  assert.equal(JSON.stringify(host).includes('192.168'), false);
  assert.equal(JSON.stringify(host).includes('candidate:'), false);

  const relay = classifyIceCandidate('remote', 'candidate:2 1 udp 100 203.0.113.10 3478 typ relay raddr 203.0.113.10 rport 3478');
  assert.equal(relay.accepted, false);
  assert.equal(relay.rejectionReason, 'relay');
  assert.equal(JSON.stringify(relay).includes('203.0.113'), false);

  const srflx = classifyIceCandidate('remote', 'candidate:3 1 udp 100 203.0.113.11 9 typ srflx raddr 10.0.0.1 rport 9');
  assert.equal(srflx.accepted, false);
  assert.equal(srflx.rejectionReason, 'srflx');

  const v6 = classifyIceCandidate('local', 'candidate:4 1 udp 100 fd00::1 9 typ host generation 0');
  assert.equal(v6.accepted, false);
  assert.equal(v6.rejectionReason, 'ipv6');

  const mdns = classifyIceCandidate('local', 'candidate:5 1 udp 100 abcdef.local 9 typ host generation 0');
  assert.equal(mdns.accepted, false);
  assert.equal(mdns.rejectionReason, 'mdns');

  const publicHost = classifyIceCandidate('local', 'candidate:6 1 udp 100 8.8.8.8 9 typ host generation 0');
  assert.equal(publicHost.accepted, false);
  assert.equal(publicHost.rejectionReason, 'public_address');
});

test('classification sanitizer rejects secret-bearing payloads', () => {
  assert.equal(sanitizeIceClassification({
    direction: 'local',
    candidateType: 'host',
    transport: 'udp',
    addressFamily: 'ipv4',
    accepted: true,
    candidate: 'candidate:1 1 udp 1 192.168.1.20 9 typ host',
  }), null);
  assert.equal(sanitizeIceClassification({
    direction: 'remote',
    candidateType: 'host',
    transport: 'udp',
    addressFamily: 'ipv4',
    accepted: true,
    ip: '192.168.1.20',
  }), null);
  const clean = sanitizeIceClassification({
    direction: 'remote',
    candidateType: 'host',
    transport: 'udp',
    addressFamily: 'ipv4',
    accepted: true,
  });
  assert.equal(clean?.accepted, true);
  assert.equal((clean as { candidate?: unknown } | null)?.candidate, undefined);
});

test('media transport snapshot records ICE and renderer events without becoming LIVE', async () => {
  const native = new FakeNative();
  const media = new MediaSessionController(native, new FakeSession(), new FakeCapture(), new Diagnostics(), new ImmediateScheduler());
  await settle();
  native.emit({ type: 'ice_state', sessionId, iceConnectionState: 'checking', iceGatheringState: 'gathering' });
  native.emit({
    type: 'ice_classified',
    sessionId,
    classification: { direction: 'local', candidateType: 'srflx', transport: 'udp', addressFamily: 'ipv4', accepted: false, rejectionReason: 'srflx' },
  });
  native.emit({
    type: 'ice_classified',
    sessionId,
    classification: { direction: 'local', candidateType: 'host', transport: 'udp', addressFamily: 'ipv4', accepted: true },
  });
  native.emit({
    type: 'ice_classified',
    sessionId,
    classification: { direction: 'remote', candidateType: 'relay', transport: 'udp', addressFamily: 'ipv4', accepted: false, rejectionReason: 'relay' },
  });
  native.emit({ type: 'renderer', sessionId, attached: true, width: 1280, height: 720, rotation: 0 });
  native.emit({ type: 'connection_state', sessionId, state: 'connected' });
  await settle();
  const snap = media.getTransportSnapshot();
  assert.equal(snap.iceConnectionState, 'checking');
  assert.equal(snap.iceGatheringState, 'gathering');
  assert.equal(snap.peerConnectionState, 'connected');
  assert.equal(snap.localCandidatesGenerated, 2);
  assert.equal(snap.localAccepted, 1);
  assert.equal(snap.localRejected, 1);
  assert.equal(snap.remoteRejected, 1);
  assert.equal(snap.lastRejectionReason, 'relay');
  assert.equal(snap.rendererAttached, true);
  assert.equal(snap.rendererWidth, 1280);
  assert.equal(snap.firstRenderedFrame, false);
  assert.notEqual(media.getSnapshot().type, 'live');
  const serialized = JSON.stringify(snap);
  assert.equal(/192\.168|candidate:|sdp|fingerprint|token/i.test(serialized), false);
  media.dispose();
});
