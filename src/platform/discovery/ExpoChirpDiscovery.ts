import type {
  DiscoveryAdvertisementPreparation,
  DiscoveryRegistration,
  ChirpDiscovery,
  ChirpDiscoveryEvent,
  ResolvedPartnerService,
} from './ChirpDiscovery';
import type { ChirpDiscoveryModuleEvents } from '../../../modules/chirp-discovery';

type NativeDiscoveryModule = {
  prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation>;
  start(advertisementId: string, peerHint: string, proof: string): Promise<DiscoveryRegistration>;
  probe(host: string, port: number): Promise<void>;
  stop(): Promise<void>;
  addListener<EventName extends keyof ChirpDiscoveryModuleEvents>(
    eventName: EventName,
    listener: ChirpDiscoveryModuleEvents[EventName],
  ): { remove(): void };
};

declare const require: (modulePath: string) => { default: NativeDiscoveryModule };

const SERVICE_NAME_RE = /^[\x20-\x7e]{1,128}$/;
const HINT_RE = /^[0-9a-f]{32}$/i;
const NONCE_RE = /^[0-9a-f]{32}$/i;
const PROOF_RE = /^[0-9a-f]{64}$/i;
const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

let nativeModule: NativeDiscoveryModule | null = null;
function getNativeModule(): NativeDiscoveryModule {
  if (!nativeModule) nativeModule = require('../../../modules/chirp-discovery').default;
  return nativeModule;
}

function rawMessage(error: unknown): string { return error instanceof Error ? error.message : String(error ?? ''); }
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const first = octets[0]!;
  const second = octets[1]!;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function parseResolvedService(value: unknown): ResolvedPartnerService | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['serviceName', 'host', 'port', 'peerHint', 'nonce', 'proof'].includes(key))) return null;
  if (typeof item.serviceName !== 'string' || !SERVICE_NAME_RE.test(item.serviceName)) return null;
  if (typeof item.host !== 'string' || !isPrivateIpv4(item.host)) return null;
  if (typeof item.port !== 'number' || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) return null;
  if (typeof item.peerHint !== 'string' || !HINT_RE.test(item.peerHint)) return null;
  if (typeof item.nonce !== 'string' || !NONCE_RE.test(item.nonce)) return null;
  if (typeof item.proof !== 'string' || !PROOF_RE.test(item.proof)) return null;
  return {
    serviceName: item.serviceName,
    host: item.host,
    port: item.port,
    peerHint: item.peerHint.toLowerCase(),
    nonce: item.nonce.toLowerCase(),
    proof: item.proof.toLowerCase(),
  };
}

function parseEvent(value: unknown): ChirpDiscoveryEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.type === 'service_resolved') {
    if (Object.keys(item).some((key) => !['type', 'service'].includes(key))) return null;
    const service = parseResolvedService(item.service);
    return service ? { type: 'service_resolved', service } : null;
  }
  if (item.type === 'service_lost') {
    if (Object.keys(item).some((key) => !['type', 'serviceName'].includes(key))) return null;
    return typeof item.serviceName === 'string' && SERVICE_NAME_RE.test(item.serviceName) ? { type: 'service_lost', serviceName: item.serviceName } : null;
  }
  if (item.type === 'error') {
    if (Object.keys(item).some((key) => !['type', 'code'].includes(key))) return null;
    return typeof item.code === 'string' && ERROR_CODE_RE.test(item.code) ? { type: 'error', code: item.code } : null;
  }
  return null;
}

export class ExpoChirpDiscovery implements ChirpDiscovery {
  async prepareAdvertisement(): Promise<DiscoveryAdvertisementPreparation> {
    try {
      const value = await getNativeModule().prepareAdvertisement();
      if (
        !value || typeof value.advertisementId !== 'string' || value.advertisementId.length > 128 ||
        typeof value.host !== 'string' || !isPrivateIpv4(value.host) ||
        !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
        typeof value.nonce !== 'string' || !NONCE_RE.test(value.nonce)
      ) throw new Error('invalid_native_preparation');
      return { ...value, nonce: value.nonce.toLowerCase() };
    } catch (error) {
      const raw = rawMessage(error);
      if (/Wi-?Fi|private IPv4|active network/i.test(raw)) throw new Error('Trusted availability needs an active private IPv4 Wi-Fi network.');
      throw new Error('Chirp could not prepare local availability.');
    }
  }

  async start(advertisementId: string, peerHint: string, proof: string): Promise<DiscoveryRegistration> {
    try {
      const value = await getNativeModule().start(advertisementId, peerHint, proof);
      if (!value || typeof value.serviceName !== 'string' || !SERVICE_NAME_RE.test(value.serviceName)) throw new Error('invalid_native_registration');
      return value;
    } catch {
      throw new Error('Chirp could not advertise and discover trusted availability on this Wi-Fi.');
    }
  }

  async probe(host: string, port: number): Promise<void> {
    try { await getNativeModule().probe(host, port); }
    catch { throw new Error('The discovered trusted endpoint is not reachable on this Wi-Fi.'); }
  }

  async stop(): Promise<void> { await getNativeModule().stop(); }

  subscribe(listener: (event: ChirpDiscoveryEvent) => void): () => void {
    const subscription = getNativeModule().addListener('onChirpDiscoveryEvent', (event) => {
      const parsed = parseEvent(event);
      if (parsed) listener(parsed);
    });
    return () => subscription.remove();
  }
}
