export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_EVENTS = 100;

export type DiagnosticEventKind =
  | 'app_started'
  | 'identity_created'
  | 'identity_loaded'
  | 'device_name_updated'
  | 'identity_validation_rejected'
  | 'identity_storage_error'
  | 'pairing_started'
  | 'pairing_scanned'
  | 'pairing_cancelled'
  | 'pairing_failed'
  | 'pairing_crypto_selftest_failed'
  | 'pairing_crypto_failed'
  | 'pairing_protocol_failed'
  | 'pairing_transport_failed'
  | 'pairing_storage_failed'
  | 'pairing_completed'
  | 'pairing_revoked'
  | 'availability_started'
  | 'availability_partner_found'
  | 'availability_partner_lost'
  | 'availability_probe_failed'
  | 'availability_failed'
  | 'availability_stopped'
  | 'session_requested'
  | 'session_request_received'
  | 'session_accepted'
  | 'session_declined'
  | 'session_cancelled'
  | 'session_timeout'
  | 'session_connected'
  | 'session_ended'
  | 'session_error'
  | 'control_auth_failed'
  | 'control_transport_failed'
  | 'capture_consent_requested'
  | 'capture_consent_denied'
  | 'capture_started'
  | 'capture_stopped'
  | 'capture_revoked'
  | 'capture_failed'
  | 'media_negotiation_started'
  | 'media_remote_track'
  | 'media_first_frame'
  | 'media_bitrate_parameters_failed'
  | 'media_degraded'
  | 'media_reconnect_attempt'
  | 'media_reconnected'
  | 'media_failed'
  | 'media_stats'
  | 'notification_shown'
  | 'notification_cleared';

export type LegacyDiagnosticEventKind =
  | 'media_keyframe_requested'
  | 'media_keyframe_forced';

export type StoredDiagnosticEventKind = DiagnosticEventKind | LegacyDiagnosticEventKind;

export interface DiagnosticEvent {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  at: string;
  kind: StoredDiagnosticEventKind;
}

const CURRENT_KINDS = new Set<DiagnosticEventKind>([
  'app_started', 'identity_created', 'identity_loaded', 'device_name_updated',
  'identity_validation_rejected', 'identity_storage_error', 'pairing_started', 'pairing_scanned', 'pairing_cancelled',
  'pairing_failed', 'pairing_crypto_selftest_failed', 'pairing_crypto_failed',
  'pairing_protocol_failed', 'pairing_transport_failed', 'pairing_storage_failed',
  'pairing_completed', 'pairing_revoked', 'availability_started',
  'availability_partner_found', 'availability_partner_lost', 'availability_probe_failed',
  'availability_failed', 'availability_stopped', 'session_requested',
  'session_request_received', 'session_accepted', 'session_declined', 'session_cancelled',
  'session_timeout', 'session_connected', 'session_ended', 'session_error',
  'control_auth_failed', 'control_transport_failed', 'capture_consent_requested',
  'capture_consent_denied', 'capture_started', 'capture_stopped', 'capture_revoked',
  'capture_failed', 'media_negotiation_started', 'media_remote_track', 'media_first_frame',
  'media_bitrate_parameters_failed', 'media_degraded', 'media_reconnect_attempt',
  'media_reconnected', 'media_failed', 'media_stats', 'notification_shown', 'notification_cleared',
]);

const LEGACY_READABLE_KINDS = new Set<LegacyDiagnosticEventKind>([
  'media_keyframe_requested',
  'media_keyframe_forced',
]);

export function isDiagnosticEvent(value: unknown): value is DiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'at', 'kind']);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return false;
  if (candidate.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) return false;
  if (typeof candidate.at !== 'string' || Number.isNaN(Date.parse(candidate.at))) return false;
  if (typeof candidate.kind !== 'string') return false;
  return CURRENT_KINDS.has(candidate.kind as DiagnosticEventKind) ||
    LEGACY_READABLE_KINDS.has(candidate.kind as LegacyDiagnosticEventKind);
}
