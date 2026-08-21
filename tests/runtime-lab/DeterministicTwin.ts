/**
 * Backward-compatible names for existing Runtime Laboratory tests.
 * PartnerScreenTwin itself now owns the deterministic flush policy and injected clock.
 */
export {
  PartnerScreenTwin as DeterministicPartnerScreenTwin,
  PartnerScreenTwin as PartnerScreenRuntimeLab,
} from './PartnerScreenTwin';
