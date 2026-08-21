import { CONTROL_TIMESTAMP_TOLERANCE_MS, type AnyControlMessage } from '../protocol/ControlMessage';
import { ReplayGuard } from './ReplayGuard';

export type ControlValidationFailure =
  | 'wrong_partner'
  | 'wrong_session'
  | 'stale_timestamp'
  | 'replay_or_sequence';

export type ControlValidationResult = { ok: true } | { ok: false; reason: ControlValidationFailure };

export class MessageValidator {
  private readonly replay = new ReplayGuard();

  constructor(
    private readonly expectedPartnerDeviceId: string,
    private readonly sessionId: string,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  validate(message: AnyControlMessage): ControlValidationResult {
    if (message.senderDeviceId !== this.expectedPartnerDeviceId) return { ok: false, reason: 'wrong_partner' };
    if (message.sessionId !== this.sessionId) return { ok: false, reason: 'wrong_session' };
    const timestamp = Date.parse(message.timestamp);
    if (Number.isNaN(timestamp) || Math.abs(this.nowMs() - timestamp) > CONTROL_TIMESTAMP_TOLERANCE_MS) {
      return { ok: false, reason: 'stale_timestamp' };
    }
    if (!this.replay.accept(message.messageId, message.sequence)) return { ok: false, reason: 'replay_or_sequence' };
    return { ok: true };
  }

  reset(): void { this.replay.reset(); }
}
