import type { DiagnosticEvent } from '../domain/diagnostics/DiagnosticEvent';
import type { LocalDeviceIdentity } from '../domain/identity/LocalDeviceIdentity';
import type { PhysicalMediaDiagnosticSnapshot } from '../platform/media/ExpoWebRtcMedia';

export interface DiagnosticBuildMetadata {
  appVersion: string;
  buildCommit: string | null;
  platform: string;
  platformVersion: string;
}

export interface DiagnosticReportInput {
  generatedAt: string;
  identity: LocalDeviceIdentity | null;
  events: DiagnosticEvent[];
  build: DiagnosticBuildMetadata;
  media?: PhysicalMediaDiagnosticSnapshot;
}

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const identitySuffix = input.identity?.deviceId.slice(-8) ?? 'unavailable';
  const media = input.media;
  const mediaLines = media?.observed ? [
    '',
    'lastMedia:',
    `peerConnectionState=${media.peerConnectionState}`,
    `iceConnectionState=${media.iceConnectionState}`,
    `iceGatheringState=${media.iceGatheringState}`,
    `everPeerConnected=${media.everPeerConnected}`,
    `everIceConnected=${media.everIceConnected}`,
    `remoteTrackSeen=${media.remoteTrackSeen}`,
    `localCandidatesGenerated=${media.localCandidatesGenerated}`,
    `localCandidatesAccepted=${media.localAccepted}`,
    `localCandidatesRejected=${media.localRejected}`,
    `remoteCandidatesAccepted=${media.remoteAccepted}`,
    `remoteCandidatesRejected=${media.remoteRejected}`,
    `lastLocalCandidate=${candidateSummary(media.lastLocalType, media.lastLocalTransport, media.lastLocalAddressFamily)}`,
    `lastRemoteCandidate=${candidateSummary(media.lastRemoteType, media.lastRemoteTransport, media.lastRemoteAddressFamily)}`,
    `lastCandidateRejection=${media.lastRejectionReason ?? 'none'}`,
    `rendererAttached=${media.rendererAttached}`,
    `rendererEverAttached=${media.rendererEverAttached}`,
    `rendererGeometry=${rendererGeometry(media)}`,
  ] : [];
  const lines = [
    'PartnerScreen diagnostic report',
    `generatedAt=${input.generatedAt}`,
    `appVersion=${input.build.appVersion}`,
    `buildCommit=${input.build.buildCommit ?? 'development'}`,
    `platform=${input.build.platform}`,
    `platformVersion=${input.build.platformVersion}`,
    `identityConfigured=${input.identity !== null}`,
    `deviceNameConfigured=${Boolean(input.identity?.deviceName)}`,
    `deviceIdSuffix=${identitySuffix}`,
    `eventCount=${input.events.length}`,
    ...mediaLines,
    '',
    'events:',
    ...input.events.map((event) => `${event.at} ${event.kind}`),
  ];
  return lines.join('\n');
}

function candidateSummary(
  type: PhysicalMediaDiagnosticSnapshot['lastLocalType'] | undefined,
  transport: PhysicalMediaDiagnosticSnapshot['lastLocalTransport'] | undefined,
  family: PhysicalMediaDiagnosticSnapshot['lastLocalAddressFamily'] | undefined,
): string {
  if (!type && !transport && !family) return 'none';
  return `${type ?? 'other'}/${transport ?? 'other'}/${family ?? 'other'}`;
}

function rendererGeometry(media: PhysicalMediaDiagnosticSnapshot): string {
  if (media.rendererWidth === undefined || media.rendererHeight === undefined || media.rendererRotation === undefined) return 'none';
  return `${media.rendererWidth}x${media.rendererHeight}@${media.rendererRotation}`;
}
