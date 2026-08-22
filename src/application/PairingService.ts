import type { DiagnosticEventKind } from '../domain/diagnostics/DiagnosticEvent';
import type { DiagnosticsRepository } from '../domain/diagnostics/DiagnosticsRepository';
import type { IdentityRepository } from '../domain/identity/IdentityRepository';
import type { LocalDeviceIdentity } from '../domain/identity/LocalDeviceIdentity';
import {
  PairTrustPersistenceError,
  PairTrustRepository,
  type PairTrustMetadata,
  type PendingPairTrust,
} from '../domain/pairing/PairTrustRepository';
import {
  buildPairingQrPayload,
  PairingQrError,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_QR_TTL_MS,
  parsePairingQr,
  type PairingQrPayload,
} from '../domain/pairing/PairingQr';
import {
  PairingProtocolError,
  PairingReplayGuard,
  pairingFrameAad,
  parseAckPayload,
  parseCancelPayload,
  parseCommitPayload,
  parseConfirmPayload,
  parseErrorPayload,
  parseHelloPayload,
  parseIdentityPayload,
  parsePairingEnvelope,
  parseSealedPairingFrame,
  type PairCommitPayload,
  type PairingFrameHeader,
  type PairingMessageEnvelope,
  type PairingMessageType,
} from '../domain/pairing/PairingProtocol';
import {
  canLocalConfirmPairing,
  initialPairingMachine,
  transitionPairingState,
  type PairingMachineState,
  type PairingRole,
} from '../domain/pairing/PairingStateMachine';
import type { PairingCrypto } from '../platform/pairing/ExpoPairingCrypto';
import {
  PairingTransportError,
  type PairingTransport,
} from '../platform/pairing/ExpoPairingTransport';
import { systemRuntimeScheduler, type RuntimeScheduler, type RuntimeTimer } from '../runtime/RuntimeScheduler';
import type { PairingTransportEvent } from '../../modules/chirp-pairing-transport';

export interface PairingPeerIdentity {
  deviceId: string;
  deviceName: string;
}

export type PairingUiState =
  | { kind: 'loading' }
  | { kind: 'unpaired' }
  | { kind: 'paired'; pair: PairTrustMetadata }
  | { kind: 'creator_qr'; qrPayload: string; expiresAt: string }
  | { kind: 'waiting_partner'; role: PairingRole; peer?: PairingPeerIdentity; message: string }
  | { kind: 'confirm_partner'; role: PairingRole; peer: PairingPeerIdentity }
  | { kind: 'finalizing'; role: PairingRole; peer: PairingPeerIdentity }
  | { kind: 'error'; message: string };

interface AttemptContext {
  role: PairingRole;
  machine: PairingMachineState;
  pairAttemptId: string;
  bootstrapKeyHex: string;
  local: LocalDeviceIdentity;
  qr?: PairingQrPayload;
  remote?: PairingPeerIdentity;
  remoteCandidateDeviceId?: string;
  listenerId?: string;
  connectionId?: string;
  outboundSequence: number;
  replay: PairingReplayGuard;
  commit?: PairCommitPayload;
  expiryTimer?: RuntimeTimer;
  durableConvergenceReached: boolean;
}

export class PairingService {
  private state: PairingUiState = { kind: 'loading' };
  private readonly listeners = new Set<() => void>();
  private attempt: AttemptContext | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribeTransport: () => void;

  constructor(
    private readonly identityRepository: IdentityRepository,
    private readonly trustRepository: PairTrustRepository,
    private readonly diagnosticsRepository: DiagnosticsRepository,
    private readonly transport: PairingTransport,
    private readonly crypto: PairingCrypto,
    private readonly now: () => Date = () => new Date(),
    private readonly scheduler: RuntimeScheduler = systemRuntimeScheduler,
  ) {
    this.unsubscribeTransport = this.transport.subscribe((event) => this.onTransportEvent(event));
  }

  getSnapshot = (): PairingUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) this.initPromise = this.initializeOnce();
    return this.initPromise;
  }

  startCreator(): Promise<void> {
    return this.enqueueOperation(() => this.startCreatorNow());
  }

  startScanner(rawQr: string): Promise<void> {
    return this.enqueueOperation(() => this.startScannerNow(rawQr));
  }

  confirmPartner(): Promise<void> {
    return this.enqueueOperation(() => this.confirmPartnerNow());
  }

  cancel(): Promise<void> {
    return this.enqueueOperation(() => this.cancelNow());
  }

  revokePair(): Promise<void> {
    return this.enqueueOperation(() => this.revokePairNow());
  }

  resetError(): Promise<void> {
    return this.enqueueOperation(() => this.resetErrorNow());
  }

  dispose(): void {
    this.unsubscribeTransport();
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startCreatorNow(): Promise<void> {
    await this.initialize();
    this.ensureNoActiveAttempt();
    let unownedListenerId: string | undefined;

    try {
      const pair = await this.trustRepository.loadConfirmed();
      if (pair) throw new Error('This phone is already paired.');
      const local = await this.requireNamedLocalIdentity();
      const endpoint = await this.transport.startListener();
      unownedListenerId = endpoint.listenerId;

      const now = this.now();
      const expiresAt = new Date(now.getTime() + PAIRING_QR_TTL_MS);
      const pairAttemptId = this.crypto.randomId();
      const bootstrapKeyHex = await this.crypto.generateKeyHex();
      let machine = initialPairingMachine('creator');
      machine = transitionPairingState(machine, 'QR_READY');

      const qrPayload = buildPairingQrPayload({
        pairAttemptId,
        creatorDeviceId: local.deviceId,
        creatorDeviceName: local.deviceName!,
        host: endpoint.host,
        port: endpoint.port,
        bootstrapKeyHex,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      this.attempt = {
        role: 'creator',
        machine,
        pairAttemptId,
        bootstrapKeyHex,
        local,
        listenerId: endpoint.listenerId,
        outboundSequence: 0,
        replay: new PairingReplayGuard(),
        durableConvergenceReached: false,
      };
      unownedListenerId = undefined;
      this.scheduleExpiry(expiresAt.getTime());
      await this.record('pairing_started');
      this.setState({ kind: 'creator_qr', qrPayload, expiresAt: expiresAt.toISOString() });
    } catch (error) {
      if (this.attempt) {
        await this.failAttempt(this.safeMessage(error, 'Could not start pairing.'), false);
      } else {
        if (unownedListenerId) {
          try { await this.transport.stopListener(unownedListenerId); } catch { /* safe error state below */ }
        }
        await this.record('pairing_failed');
        this.setState({ kind: 'error', message: this.safeMessage(error, 'Could not start pairing.') });
      }
      throw error;
    }
  }

  private async startScannerNow(rawQr: string): Promise<void> {
    await this.initialize();
    this.ensureNoActiveAttempt();

    try {
      const pair = await this.trustRepository.loadConfirmed();
      const local = await this.requireNamedLocalIdentity();
      const qr = parsePairingQr(rawQr, {
        nowMs: this.now().getTime(),
        localDeviceId: local.deviceId,
        alreadyPaired: pair !== null,
      });

      this.attempt = {
        role: 'scanner',
        machine: initialPairingMachine('scanner'),
        pairAttemptId: qr.pairAttemptId,
        bootstrapKeyHex: qr.bootstrapKeyHex,
        local,
        qr,
        remoteCandidateDeviceId: qr.creatorDeviceId,
        outboundSequence: 0,
        replay: new PairingReplayGuard(),
        durableConvergenceReached: false,
      };
      this.scheduleExpiry(Date.parse(qr.expiresAt));
      this.setState({ kind: 'waiting_partner', role: 'scanner', message: 'Connecting securely to the other phone…' });

      const connectionId = await this.transport.connect(qr.host, qr.port);
      if (!this.attempt || this.attempt.pairAttemptId !== qr.pairAttemptId) {
        try { await this.transport.close(connectionId); } catch { /* stale connection has no product ownership */ }
        return;
      }
      this.attempt.connectionId = connectionId;
      this.attempt.machine = transitionPairingState(this.attempt.machine, 'CONNECTED');
      await this.record('pairing_scanned');
      this.setState({ kind: 'waiting_partner', role: 'scanner', message: 'Authenticating the other phone…' });
      await this.sendMessage('PAIR_HELLO', { pairAttemptId: qr.pairAttemptId });
    } catch (error) {
      if (this.attempt) {
        await this.failAttempt(this.safeMessage(error, 'Could not connect to the pairing phone.'), false);
      } else {
        await this.record('pairing_failed');
        this.setState({ kind: 'error', message: this.safeMessage(error, 'Could not read the pairing QR code.') });
      }
      throw error;
    }
  }

  private async confirmPartnerNow(): Promise<void> {
    try {
      const attempt = this.requireAttempt();
      if (!attempt.remote || !canLocalConfirmPairing(attempt.machine)) {
        throw new Error('Partner confirmation is not allowed in the current pairing state.');
      }

      if (attempt.role === 'scanner') {
        attempt.machine = transitionPairingState(attempt.machine, 'LOCAL_CONFIRM');
        this.setState({
          kind: 'waiting_partner',
          role: 'scanner',
          peer: attempt.remote,
          message: 'Confirmed. Waiting for the other phone to confirm…',
        });
        await this.sendMessage('PAIR_CONFIRM', { deviceId: attempt.local.deviceId });
        return;
      }

      const pairId = this.crypto.randomId();
      const pairKeyHex = await this.crypto.generateKeyHex();
      const pairedAt = this.now().toISOString();
      const commit: PairCommitPayload = {
        pairId,
        pairKeyHex,
        creatorDeviceId: attempt.local.deviceId,
        scannerDeviceId: attempt.remote.deviceId,
        pairedAt,
      };
      const pending: PendingPairTrust = {
        schemaVersion: 1,
        protocolVersion: PAIRING_PROTOCOL_VERSION,
        pairId,
        partnerDeviceId: attempt.remote.deviceId,
        partnerDeviceName: attempt.remote.deviceName,
        pairedAt,
      };

      await this.trustRepository.stage(pending, pairKeyHex);
      if (this.attempt !== attempt) return;
      attempt.commit = commit;
      attempt.machine = transitionPairingState(attempt.machine, 'LOCAL_CONFIRM');
      this.setState({ kind: 'finalizing', role: 'creator', peer: attempt.remote });
      await this.sendMessage('PAIR_CONFIRM', { deviceId: attempt.local.deviceId });
      await this.sendMessage('PAIR_COMMIT', commit);
    } catch (error) {
      if (this.attempt) await this.failAttempt(this.safeMessage(error, 'Could not finalize pairing.'), true);
      throw error;
    }
  }

  private async cancelNow(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;

    if (attempt.connectionId) {
      try { await this.sendMessage('PAIR_CANCEL', { reason: 'user_cancelled' }); } catch { /* best effort */ }
    }
    await this.record('pairing_cancelled');
    try {
      await this.cleanupAttempt();
      this.setState({ kind: 'unpaired' });
    } catch (error) {
      this.setState({ kind: 'error', message: this.safeMessage(error, 'Pairing stopped, but local cleanup could not be verified. Restart Chirp before trying again.') });
      throw error;
    }
  }

  private async revokePairNow(): Promise<void> {
    await this.initialize();
    try {
      if (this.attempt) await this.cancelNow();
      await this.trustRepository.revoke();
      await this.record('pairing_revoked');
      this.setState({ kind: 'unpaired' });
    } catch (error) {
      this.setState({ kind: 'error', message: this.safeMessage(error, 'Chirp could not safely forget the trusted partner.') });
      throw error;
    }
  }

  private async resetErrorNow(): Promise<void> {
    try {
      if (this.attempt) await this.cleanupAttempt();
      await this.trustRepository.discardIncomplete();
      const pair = await this.trustRepository.loadConfirmed();
      this.setState(pair ? { kind: 'paired', pair } : { kind: 'unpaired' });
    } catch (error) {
      this.setState({ kind: 'error', message: this.safeMessage(error, 'Pair trust storage is unavailable.') });
    }
  }

  private async initializeOnce(): Promise<void> {
    try {
      await this.trustRepository.discardIncomplete();
      const pair = await this.trustRepository.loadConfirmed();
      this.initialized = true;
      this.setState(pair ? { kind: 'paired', pair } : { kind: 'unpaired' });
    } catch (error) {
      this.initialized = true;
      this.setState({ kind: 'error', message: this.safeMessage(error, 'Pair trust storage is unavailable.') });
    }
  }

  private onTransportEvent(event: PairingTransportEvent): void {
    const observedAttempt = this.attempt;
    if (!observedAttempt) return;
    const expectedAttemptId = observedAttempt.pairAttemptId;

    void this.enqueueOperation(async () => {
      const attempt = this.attempt;
      if (!attempt || attempt.pairAttemptId !== expectedAttemptId) return;

      if (event.type === 'connected') {
        if (attempt.role === 'creator' && event.listenerId === attempt.listenerId) {
          if (!attempt.connectionId) {
            attempt.connectionId = event.connectionId;
            if (attempt.machine.phase === 'waiting_remote_identity') {
              attempt.machine = transitionPairingState(attempt.machine, 'CONNECTED');
            }
          } else if (event.connectionId !== attempt.connectionId) {
            try { await this.transport.close(event.connectionId); } catch { /* extra socket never gains product ownership */ }
          }
        }
        return;
      }

      if (event.type === 'message') {
        if (event.connectionId !== attempt.connectionId) return;
        try {
          await this.handleFrame(event.frame, expectedAttemptId, event.connectionId);
        } catch (error) {
          const current = this.attempt;
          if (!current || current.pairAttemptId !== expectedAttemptId || current.connectionId !== event.connectionId) return;
          await this.failAttempt(this.safeMessage(error, 'Authenticated pairing failed. Start again with a fresh QR code.'), true);
        }
        return;
      }

      if (event.type === 'error' && !event.connectionId && attempt.role === 'creator') {
        await this.failAttempt('The temporary pairing listener stopped unexpectedly.', false);
        return;
      }

      if ((event.type === 'closed' || event.type === 'error') && event.connectionId === attempt.connectionId) {
        await this.failAttempt('The pairing connection ended before pairing completed.', false);
      }
    }).catch(() => undefined);
  }

  private async handleFrame(rawFrame: string, expectedAttemptId: string, expectedConnectionId: string): Promise<void> {
    const attempt = this.requireAttempt();
    if (attempt.pairAttemptId !== expectedAttemptId || attempt.connectionId !== expectedConnectionId) return;

    const frame = parseSealedPairingFrame(rawFrame);
    if (frame.pairAttemptId !== attempt.pairAttemptId) throw new PairingProtocolError('Pairing attempt mismatch.');
    if (frame.senderDeviceId === attempt.local.deviceId) throw new PairingProtocolError('Self-pairing message rejected.');
    if (attempt.remoteCandidateDeviceId && frame.senderDeviceId !== attempt.remoteCandidateDeviceId) {
      throw new PairingProtocolError('Pairing sender identity changed.');
    }

    const header: PairingFrameHeader = {
      protocolVersion: frame.protocolVersion,
      pairAttemptId: frame.pairAttemptId,
      senderDeviceId: frame.senderDeviceId,
      sequence: frame.sequence,
    };
    const opened = await this.crypto.open(attempt.bootstrapKeyHex, pairingFrameAad(header), frame.sealed);
    if (this.attempt !== attempt) return;
    const envelope = parsePairingEnvelope(opened, this.now().getTime());
    if (envelope.senderDeviceId !== frame.senderDeviceId) throw new PairingProtocolError('Pairing sender authentication mismatch.');
    attempt.replay.accept(frame.sequence, envelope.messageId);

    if (!attempt.remoteCandidateDeviceId) attempt.remoteCandidateDeviceId = frame.senderDeviceId;
    await this.routeMessage(envelope, attempt);
  }

  private async routeMessage(message: PairingMessageEnvelope, attempt: AttemptContext): Promise<void> {
    if (this.attempt !== attempt) return;

    switch (message.type) {
      case 'PAIR_HELLO': {
        if (attempt.role !== 'creator' || attempt.machine.phase !== 'waiting_remote_identity') throw new PairingProtocolError('Unexpected PAIR_HELLO.');
        const payload = parseHelloPayload(message.payload);
        if (payload.pairAttemptId !== attempt.pairAttemptId) throw new PairingProtocolError('PAIR_HELLO attempt mismatch.');
        await this.sendMessage('PAIR_IDENTITY', {
          deviceId: attempt.local.deviceId,
          deviceName: attempt.local.deviceName,
        });
        return;
      }
      case 'PAIR_IDENTITY': {
        const remote = parseIdentityPayload(message.payload);
        if (remote.deviceId !== message.senderDeviceId || remote.deviceId === attempt.local.deviceId) throw new PairingProtocolError('Remote identity mismatch.');
        if (attempt.role === 'scanner') {
          if (!attempt.qr || remote.deviceId !== attempt.qr.creatorDeviceId || remote.deviceName !== attempt.qr.creatorDeviceName) {
            throw new PairingProtocolError('Authenticated creator identity does not match the QR code.');
          }
          attempt.remote = remote;
          await this.sendMessage('PAIR_IDENTITY', {
            deviceId: attempt.local.deviceId,
            deviceName: attempt.local.deviceName,
          });
          if (this.attempt !== attempt) return;
          attempt.machine = transitionPairingState(attempt.machine, 'REMOTE_AUTHENTICATED');
          this.setState({ kind: 'confirm_partner', role: 'scanner', peer: remote });
          return;
        }
        if (attempt.remoteCandidateDeviceId !== remote.deviceId) throw new PairingProtocolError('Authenticated scanner identity mismatch.');
        attempt.remote = remote;
        attempt.machine = transitionPairingState(attempt.machine, 'REMOTE_AUTHENTICATED');
        this.setState({
          kind: 'waiting_partner',
          role: 'creator',
          peer: remote,
          message: 'Partner authenticated. Waiting for them to confirm first…',
        });
        return;
      }
      case 'PAIR_CONFIRM': {
        if (!attempt.remote) throw new PairingProtocolError('Confirmation arrived before authenticated identity.');
        const payload = parseConfirmPayload(message.payload);
        if (payload.deviceId !== attempt.remote.deviceId) throw new PairingProtocolError('Pair confirmation identity mismatch.');
        attempt.machine = transitionPairingState(attempt.machine, 'REMOTE_CONFIRM');
        if (attempt.role === 'creator') {
          this.setState({ kind: 'confirm_partner', role: 'creator', peer: attempt.remote });
        } else {
          this.setState({ kind: 'finalizing', role: 'scanner', peer: attempt.remote });
        }
        return;
      }
      case 'PAIR_COMMIT': {
        if (attempt.role !== 'scanner' || !attempt.remote || attempt.machine.phase !== 'finalizing') throw new PairingProtocolError('Unexpected PAIR_COMMIT.');
        const commit = parseCommitPayload(message.payload);
        if (commit.creatorDeviceId !== attempt.remote.deviceId || commit.scannerDeviceId !== attempt.local.deviceId) {
          throw new PairingProtocolError('Pair commit identity mismatch.');
        }

        const pending: PendingPairTrust = {
          schemaVersion: 1,
          protocolVersion: PAIRING_PROTOCOL_VERSION,
          pairId: commit.pairId,
          partnerDeviceId: attempt.remote.deviceId,
          partnerDeviceName: attempt.remote.deviceName,
          pairedAt: commit.pairedAt,
        };
        await this.trustRepository.stage(pending, commit.pairKeyHex);
        if (this.attempt !== attempt) return;
        attempt.commit = commit;
        await this.sendMessage('PAIR_COMMIT_ACK', { phase: 'scanner_staged' });
        return;
      }
      case 'PAIR_COMMIT_ACK': {
        await this.handleCommitAck(attempt, parseAckPayload(message.payload).phase);
        return;
      }
      case 'PAIR_CANCEL': {
        parseCancelPayload(message.payload);
        await this.record('pairing_cancelled');
        try {
          await this.cleanupAttempt();
          this.setState({ kind: 'unpaired' });
        } catch (error) {
          this.setState({
            kind: 'error',
            message: this.safeMessage(error, 'The other phone cancelled, but local cleanup could not be verified. Restart Chirp before trying again.'),
          });
        }
        return;
      }
      case 'PAIR_ERROR': {
        parseErrorPayload(message.payload);
        await this.failAttempt('The other phone rejected the pairing attempt.', false);
        return;
      }
      default:
        throw new PairingProtocolError('Unsupported pairing message.');
    }
  }

  private async handleCommitAck(attempt: AttemptContext, phase: string): Promise<void> {
    if (this.attempt !== attempt) return;
    if (!attempt.remote || attempt.machine.phase !== 'finalizing') throw new PairingProtocolError('Unexpected pair finalization acknowledgement.');

    if (attempt.role === 'creator') {
      if (phase === 'scanner_staged') {
        await this.sendMessage('PAIR_COMMIT_ACK', { phase: 'creator_ready' });
        return;
      }
      if (phase === 'scanner_committed') {
        await this.trustRepository.installCommitted();
        if (this.attempt !== attempt) return;
        await this.sendMessage('PAIR_COMMIT_ACK', { phase: 'creator_committed' });
        return;
      }
      if (phase === 'scanner_confirmed') {
        await this.trustRepository.markConfirmed();
        if (this.attempt !== attempt) return;
        attempt.durableConvergenceReached = true;
        await this.sendMessage('PAIR_COMMIT_ACK', { phase: 'creator_confirmed' });
        this.setState({ kind: 'finalizing', role: 'creator', peer: attempt.remote });
        return;
      }
      if (phase === 'converged') {
        await this.completeConvergedAttempt();
        return;
      }
      throw new PairingProtocolError('Unexpected creator finalization phase.');
    }

    if (phase === 'creator_ready') {
      await this.trustRepository.installCommitted();
      if (this.attempt !== attempt) return;
      await this.sendMessage('PAIR_COMMIT_ACK', { phase: 'scanner_committed' });
      return;
    }
    if (phase === 'creator_committed') {
      await this.trustRepository.markConfirmed();
      if (this.attempt !== attempt) return;
      await this.sendMessage('PAIR_COMMIT_ACK', { phase: 'scanner_confirmed' });
      this.setState({ kind: 'finalizing', role: 'scanner', peer: attempt.remote });
      return;
    }
    if (phase === 'creator_confirmed') {
      const pair = await this.trustRepository.loadConfirmed();
      if (this.attempt !== attempt) return;
      if (!pair) throw new PairingProtocolError('Scanner pair trust was not confirmed.');
      attempt.durableConvergenceReached = true;
      attempt.machine = transitionPairingState(attempt.machine, 'CONVERGED');
      await this.sendMessage('PAIR_COMMIT_ACK', { phase: 'converged' });
      // Pairing owns its temporary socket until cleanup is attempted. Do not start availability/control
      // while the QR transport is still live on the scanner role.
      try {
        await this.cleanupAttempt({ keepDurablePair: true, preserveState: true });
      } catch {
        // Durable trust already converged; transport cleanup is best effort, but ownership is released.
      }
      await this.record('pairing_completed');
      this.setState({ kind: 'paired', pair });
      return;
    }
    throw new PairingProtocolError('Unexpected scanner finalization phase.');
  }

  private async completeConvergedAttempt(): Promise<void> {
    const attempt = this.requireAttempt();
    const pair = await this.trustRepository.loadConfirmed();
    if (!pair) throw new PairingProtocolError('Pair trust was not confirmed.');
    if (attempt.machine.phase === 'finalizing') {
      attempt.machine = transitionPairingState(attempt.machine, 'CONVERGED');
    }
    // Creator follows the same ownership boundary: finish the temporary pairing transport before
    // publishing paired state, which is what activates control listener + trusted discovery.
    try {
      await this.cleanupAttempt({ keepDurablePair: true, preserveState: true });
    } catch {
      // Confirmed pair truth must not be rolled back because closing an already-terminal socket failed.
    }
    await this.record('pairing_completed');
    this.setState({ kind: 'paired', pair });
  }

  private async sendMessage(type: PairingMessageType, payload: unknown): Promise<void> {
    const attempt = this.requireAttempt();
    if (!attempt.connectionId) throw new Error('Pairing connection is not ready.');
    const sequence = ++attempt.outboundSequence;
    const header: PairingFrameHeader = {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      pairAttemptId: attempt.pairAttemptId,
      senderDeviceId: attempt.local.deviceId,
      sequence,
    };
    const envelope: PairingMessageEnvelope = {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      messageId: this.crypto.randomId(),
      type,
      senderDeviceId: attempt.local.deviceId,
      timestamp: this.now().toISOString(),
      payload,
    };
    const sealed = await this.crypto.seal(
      attempt.bootstrapKeyHex,
      pairingFrameAad(header),
      JSON.stringify(envelope),
    );
    if (this.attempt !== attempt) return;
    await this.transport.send(attempt.connectionId, JSON.stringify({ ...header, sealed }));
  }

  private async failAttempt(message: string, notifyPeer: boolean): Promise<void> {
    const attempt = this.attempt;
    if (attempt?.durableConvergenceReached) {
      try {
        await this.completeConvergedAttempt();
        return;
      } catch {
        // If confirmed trust cannot be reloaded, fall through to fail-closed cleanup.
      }
    }

    if (notifyPeer && attempt?.connectionId) {
      try { await this.sendMessage('PAIR_ERROR', { code: 'pairing_failed' }); } catch { /* best effort */ }
    }
    await this.record('pairing_failed');
    try {
      await this.cleanupAttempt();
      this.setState({ kind: 'error', message });
    } catch (cleanupError) {
      this.setState({
        kind: 'error',
        message: this.safeMessage(
          cleanupError,
          'Pairing failed and local cleanup could not be verified. Restart Chirp before trying again.',
        ),
      });
    }
  }

  private async cleanupAttempt(options?: { keepDurablePair?: boolean; preserveState?: boolean; closeConnection?: boolean }): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    attempt.expiryTimer?.cancel();

    const cleanupErrors: unknown[] = [];
    if (!options?.keepDurablePair) {
      try { await this.trustRepository.abortPairAttempt(); } catch (error) { cleanupErrors.push(error); }
    }
    if (attempt.connectionId && options?.closeConnection !== false) {
      try { await this.transport.close(attempt.connectionId); } catch (error) { cleanupErrors.push(error); }
    }
    if (attempt.listenerId) {
      try { await this.transport.stopListener(attempt.listenerId); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw cleanupErrors[0];
    if (!options?.preserveState) this.setState({ kind: 'unpaired' });
  }

  private scheduleExpiry(expiresAtMs: number): void {
    const attempt = this.requireAttempt();
    const pairAttemptId = attempt.pairAttemptId;
    const delay = Math.max(1, expiresAtMs - this.now().getTime());
    attempt.expiryTimer = this.scheduler.schedule(delay, () => {
      void this.enqueueOperation(async () => {
        if (!this.attempt || this.attempt.pairAttemptId !== pairAttemptId) return;
        await this.failAttempt('The pairing attempt expired. Start again with a new QR code.', true);
      }).catch(() => undefined);
    });
  }

  private async requireNamedLocalIdentity(): Promise<LocalDeviceIdentity> {
    const identity = (await this.identityRepository.bootstrap()).identity;
    if (!identity.deviceName) throw new Error('Set this phone’s device name before pairing.');
    return identity;
  }

  private requireAttempt(): AttemptContext {
    if (!this.attempt) throw new Error('No pairing attempt is active.');
    return this.attempt;
  }

  private ensureNoActiveAttempt(): void {
    if (this.attempt) throw new Error('A pairing attempt is already active.');
  }

  private setState(next: PairingUiState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  private async record(kind: DiagnosticEventKind): Promise<void> {
    try { await this.diagnosticsRepository.append(kind); } catch { /* diagnostics never controls pairing */ }
  }

  private safeMessage(error: unknown, fallback: string): string {
    if (error instanceof PairingTransportError || error instanceof PairingQrError) return error.message;
    if (error instanceof PairTrustPersistenceError) {
      return 'Chirp could not safely update local pairing trust. Restart the app before trying again.';
    }
    if (error instanceof PairingProtocolError) {
      return 'Authenticated pairing failed. Start again with a fresh QR code.';
    }
    if (error instanceof Error) {
      const safeMessages = new Set([
        'This phone is already paired.',
        'Set this phone’s device name before pairing.',
        'A pairing attempt is already active.',
        'Partner confirmation is not allowed in the current pairing state.',
      ]);
      if (safeMessages.has(error.message)) return error.message;
    }
    return fallback;
  }
}
