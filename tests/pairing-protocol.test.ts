import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingReplayGuard } from '../src/domain/pairing/PairingProtocol';
import {
  canLocalConfirmPairing,
  initialPairingMachine,
  transitionPairingState,
} from '../src/domain/pairing/PairingStateMachine';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';

test('scanner confirms before creator can confirm', () => {
  let scanner = initialPairingMachine('scanner');
  scanner = transitionPairingState(scanner, 'CONNECTED');
  scanner = transitionPairingState(scanner, 'REMOTE_AUTHENTICATED');
  assert.equal(canLocalConfirmPairing(scanner), true);
  scanner = transitionPairingState(scanner, 'LOCAL_CONFIRM');
  assert.equal(scanner.phase, 'waiting_creator_confirmation');

  let creator = initialPairingMachine('creator');
  creator = transitionPairingState(creator, 'QR_READY');
  creator = transitionPairingState(creator, 'REMOTE_AUTHENTICATED');
  assert.equal(canLocalConfirmPairing(creator), false);
  creator = transitionPairingState(creator, 'REMOTE_CONFIRM');
  assert.equal(canLocalConfirmPairing(creator), true);
  creator = transitionPairingState(creator, 'LOCAL_CONFIRM');
  assert.equal(creator.phase, 'finalizing');
});

test('creator cannot confirm before scanner confirmation', () => {
  let creator = initialPairingMachine('creator');
  creator = transitionPairingState(creator, 'QR_READY');
  creator = transitionPairingState(creator, 'REMOTE_AUTHENTICATED');
  assert.throws(() => transitionPairingState(creator, 'LOCAL_CONFIRM'), /Invalid creator pairing transition/);
});

test('replay guard accepts exact ordered messages and rejects duplicates/out-of-order', () => {
  const guard = new PairingReplayGuard();
  guard.accept(1, M1);
  assert.throws(() => guard.accept(1, M1), /sequence|replayed/i);
  assert.throws(() => guard.accept(3, M2), /sequence/i);
  guard.accept(2, M2);
});

test('cancel is terminal from every provisional pairing phase', () => {
  const states = [
    initialPairingMachine('creator'),
    { role: 'creator', phase: 'waiting_remote_identity' },
    { role: 'creator', phase: 'waiting_scanner_confirmation' },
    { role: 'creator', phase: 'creator_can_confirm' },
    { role: 'creator', phase: 'finalizing' },
    initialPairingMachine('scanner'),
    { role: 'scanner', phase: 'waiting_remote_identity' },
    { role: 'scanner', phase: 'scanner_can_confirm' },
    { role: 'scanner', phase: 'waiting_creator_confirmation' },
    { role: 'scanner', phase: 'finalizing' },
  ] as const;
  for (const state of states) {
    assert.equal(transitionPairingState(state, 'CANCEL').phase, 'cancelled');
  }
});
