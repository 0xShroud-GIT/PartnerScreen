import type { DiagnosticEvent } from '../domain/diagnostics/DiagnosticEvent';
import type { LocalDeviceIdentity } from '../domain/identity/LocalDeviceIdentity';
import type { MediaDiagnosticSnapshot } from '../media/MediaSession';

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
  media?: MediaDiagnosticSnapshot;
}

function value(input: number | string | undefined): string { return input === undefined ? 'n/a' : String(input); }

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const identitySuffix = input.identity?.deviceId.slice(-8) ?? 'unavailable';
  const media = input.media;
  const stats = media?.stats;
  const mediaLines = media ? [
    '',
    'lastMedia:',
    `state=${media.state}`,
    `role=${media.role ?? 'none'}`,
    `connectionState=${media.connectionState ?? 'n/a'}`,
    `iceConnectionState=${media.iceConnectionState ?? 'n/a'}`,
    `iceGatheringState=${media.iceGatheringState ?? 'n/a'}`,
    `signalingState=${media.signalingState ?? 'n/a'}`,
    `remoteTrackSeen=${media.remoteTrackSeen}`,
    `firstFrameSeen=${media.firstFrameSeen}`,
    `localCandidatesAccepted=${media.acceptedLocalCandidates}`,
    `localCandidatesRejected=${media.rejectedLocalCandidates}`,
    `remoteCandidatesAccepted=${media.acceptedRemoteCandidates}`,
    `remoteCandidatesRejected=${media.rejectedRemoteCandidates}`,
    `restartAttempts=${media.restartAttempts}`,
    `bitrateParametersApplied=${media.bitrateParametersApplied}`,
    `sendBitrateBps=${value(stats?.sendBitrateBps === undefined ? undefined : Math.round(stats.sendBitrateBps))}`,
    `receiveBitrateBps=${value(stats?.receiveBitrateBps === undefined ? undefined : Math.round(stats.receiveBitrateBps))}`,
    `framesPerSecond=${value(stats?.framesPerSecond)}`,
    `frameSize=${stats?.frameWidth && stats?.frameHeight ? `${stats.frameWidth}x${stats.frameHeight}` : 'n/a'}`,
    `framesEncoded=${value(stats?.framesEncoded)}`,
    `framesDecoded=${value(stats?.framesDecoded)}`,
    `framesDropped=${value(stats?.framesDropped)}`,
    `keyFramesEncoded=${value(stats?.keyFramesEncoded)}`,
    `keyFramesDecoded=${value(stats?.keyFramesDecoded)}`,
    `nackCount=${value(stats?.nackCount)}`,
    `pliCount=${value(stats?.pliCount)}`,
    `firCount=${value(stats?.firCount)}`,
    `packetsLost=${value(stats?.packetsLost)}`,
    `jitterMs=${value(stats?.jitterMs === undefined ? undefined : Math.round(stats.jitterMs))}`,
    `roundTripTimeMs=${value(stats?.roundTripTimeMs === undefined ? undefined : Math.round(stats.roundTripTimeMs))}`,
    `candidatePairState=${stats?.candidatePairState ?? 'n/a'}`,
    `codec=${stats?.codecMimeType ?? 'n/a'}`,
    `encoderImplementation=${stats?.encoderImplementation ?? 'n/a'}`,
    `decoderImplementation=${stats?.decoderImplementation ?? 'n/a'}`,
    `qualityLimitationReason=${stats?.qualityLimitationReason ?? 'n/a'}`,
  ] : [];

  return [
    'Chirp diagnostic report',
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
  ].join('\n');
}
