export type PairingTransportErrorCode =
  | 'wifi_unavailable'
  | 'partner_unreachable'
  | 'listener_failed'
  | 'connection_failed'
  | 'send_failed'
  | 'cleanup_failed';

/** Product-safe transport failure. Contains no native stack, endpoint, frame, or secret data. */
export class PairingTransportError extends Error {
  constructor(
    readonly code: PairingTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PairingTransportError';
  }
}
