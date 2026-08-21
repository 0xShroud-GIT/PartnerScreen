import type {
  PairingListenerEndpoint,
  PairingTransportEvent,
  PartnerPairingTransportModuleEvents,
} from '../../../modules/partner-pairing-transport';
import { PairingTransportError } from '../../domain/pairing/PairingTransportError';

export { PairingTransportError } from '../../domain/pairing/PairingTransportError';

export interface PairingTransport {
  startListener(): Promise<PairingListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
  subscribe(listener: (event: PairingTransportEvent) => void): () => void;
}

type NativePairingModule = {
  startListener(): Promise<PairingListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
  addListener<EventName extends keyof PartnerPairingTransportModuleEvents>(
    eventName: EventName,
    listener: PartnerPairingTransportModuleEvents[EventName],
  ): { remove(): void };
};

declare const require: (modulePath: string) => { default: NativePairingModule };

let nativeModule: NativePairingModule | null = null;
function getNativeModule(): NativePairingModule {
  if (!nativeModule) {
    // Keep Expo/native module evaluation behind the platform adapter. This file must remain safe
    // to import from Node headless tests that exercise the TypeScript pairing authority.
    nativeModule = require('../../../modules/partner-pairing-transport').default;
  }
  return nativeModule;
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function mapListenerError(error: unknown): PairingTransportError {
  const raw = rawErrorMessage(error);
  if (/Wi-?Fi|private IPv4/i.test(raw)) {
    return new PairingTransportError('wifi_unavailable', 'Pairing needs an active Wi-Fi connection with a local IPv4 address.');
  }
  return new PairingTransportError('listener_failed', 'PartnerScreen could not open the temporary pairing listener on Wi-Fi.');
}

function mapConnectError(error: unknown): PairingTransportError {
  const raw = rawErrorMessage(error);
  if (/Wi-?Fi|private IPv4|No active Wi-Fi route/i.test(raw)) {
    return new PairingTransportError('wifi_unavailable', 'Pairing needs an active Wi-Fi route to the other phone.');
  }
  if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNREFUSED|failed to connect|No route to host/i.test(raw)) {
    return new PairingTransportError(
      'partner_unreachable',
      'PartnerScreen could not reach the other phone over Wi-Fi. Keep both phones on the same normal Wi-Fi and scan a fresh QR code.',
    );
  }
  return new PairingTransportError('connection_failed', 'PartnerScreen could not open the temporary pairing connection.');
}

export class ExpoPairingTransport implements PairingTransport {
  async startListener(): Promise<PairingListenerEndpoint> {
    try {
      return await getNativeModule().startListener();
    } catch (error) {
      throw mapListenerError(error);
    }
  }

  async stopListener(listenerId: string): Promise<void> {
    try {
      await getNativeModule().stopListener(listenerId);
    } catch {
      throw new PairingTransportError('cleanup_failed', 'PartnerScreen could not close the temporary pairing listener.');
    }
  }

  async connect(host: string, port: number): Promise<string> {
    try {
      return await getNativeModule().connect(host, port);
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async send(connectionId: string, frame: string): Promise<void> {
    try {
      await getNativeModule().send(connectionId, frame);
    } catch {
      throw new PairingTransportError('send_failed', 'The temporary pairing connection could not send data.');
    }
  }

  async close(connectionId: string): Promise<void> {
    try {
      await getNativeModule().close(connectionId);
    } catch {
      throw new PairingTransportError('cleanup_failed', 'PartnerScreen could not close the temporary pairing connection.');
    }
  }

  subscribe(listener: (event: PairingTransportEvent) => void): () => void {
    const subscription = getNativeModule().addListener('onPairingTransportEvent', listener);
    return () => subscription.remove();
  }
}
