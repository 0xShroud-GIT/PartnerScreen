import type { DiagnosticEvent } from '../domain/diagnostics/DiagnosticEvent';
import type { LocalDeviceIdentity } from '../domain/identity/LocalDeviceIdentity';

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
}

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const identitySuffix = input.identity?.deviceId.slice(-8) ?? 'unavailable';
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
    '',
    'events:',
    ...input.events.map((event) => `${event.at} ${event.kind}`),
  ];
  return lines.join('\n');
}
