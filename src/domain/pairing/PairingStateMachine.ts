export type PairingRole = 'creator' | 'scanner';

export type PairingPhase =
  | 'idle'
  | 'creating_qr'
  | 'connecting'
  | 'waiting_remote_identity'
  | 'waiting_scanner_confirmation'
  | 'scanner_can_confirm'
  | 'waiting_creator_confirmation'
  | 'creator_can_confirm'
  | 'finalizing'
  | 'paired'
  | 'cancelled'
  | 'failed';

export interface PairingMachineState {
  role: PairingRole;
  phase: PairingPhase;
}

export type PairingMachineEvent =
  | 'QR_READY'
  | 'CONNECTED'
  | 'REMOTE_AUTHENTICATED'
  | 'LOCAL_CONFIRM'
  | 'REMOTE_CONFIRM'
  | 'FINALIZE'
  | 'CONVERGED'
  | 'CANCEL'
  | 'FAIL';

export class PairingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingStateError';
  }
}

export function initialPairingMachine(role: PairingRole): PairingMachineState {
  return { role, phase: role === 'creator' ? 'creating_qr' : 'connecting' };
}

export function transitionPairingState(
  state: PairingMachineState,
  event: PairingMachineEvent,
): PairingMachineState {
  if (event === 'CANCEL') return { ...state, phase: 'cancelled' };
  if (event === 'FAIL') return { ...state, phase: 'failed' };

  const next = (() => {
    if (state.role === 'creator') {
      switch (`${state.phase}:${event}`) {
        case 'creating_qr:QR_READY': return 'waiting_remote_identity';
        case 'waiting_remote_identity:CONNECTED': return 'waiting_remote_identity';
        case 'waiting_remote_identity:REMOTE_AUTHENTICATED': return 'waiting_scanner_confirmation';
        case 'waiting_scanner_confirmation:REMOTE_CONFIRM': return 'creator_can_confirm';
        case 'creator_can_confirm:LOCAL_CONFIRM': return 'finalizing';
        case 'finalizing:CONVERGED': return 'paired';
        default: return null;
      }
    }
    switch (`${state.phase}:${event}`) {
      case 'connecting:CONNECTED': return 'waiting_remote_identity';
      case 'waiting_remote_identity:REMOTE_AUTHENTICATED': return 'scanner_can_confirm';
      case 'scanner_can_confirm:LOCAL_CONFIRM': return 'waiting_creator_confirmation';
      case 'waiting_creator_confirmation:REMOTE_CONFIRM': return 'finalizing';
      case 'finalizing:CONVERGED': return 'paired';
      default: return null;
    }
  })();

  if (!next) {
    throw new PairingStateError(`Invalid ${state.role} pairing transition: ${state.phase} + ${event}`);
  }
  return { ...state, phase: next as PairingPhase };
}

export function canLocalConfirmPairing(state: PairingMachineState): boolean {
  return (
    (state.role === 'scanner' && state.phase === 'scanner_can_confirm') ||
    (state.role === 'creator' && state.phase === 'creator_can_confirm')
  );
}
