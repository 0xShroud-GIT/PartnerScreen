export interface ControlListenerEndpoint { listenerId: string; host: string; port: number; }
export type ControlTransportEvent =
  | { type: 'connected'; connectionId: string; direction: 'inbound' | 'outbound'; listenerId?: string }
  | { type: 'message'; connectionId: string; frame: string }
  | { type: 'closed'; connectionId: string }
  | { type: 'error'; code: string; connectionId?: string; listenerId?: string };
export interface ControlTransport {
  startListener(): Promise<ControlListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
  subscribe(listener: (event: ControlTransportEvent) => void): () => void;
}
type NativeControlModule = {
  startListener(): Promise<ControlListenerEndpoint>;
  stopListener(listenerId: string): Promise<void>;
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, frame: string): Promise<void>;
  close(connectionId: string): Promise<void>;
  addListener(eventName: 'onPartnerControlEvent', listener: (event: unknown) => void): { remove(): void };
};
declare const require: (modulePath: string) => { default: NativeControlModule };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_RE = /^[a-z0-9_]{1,64}$/;
const MAX_FRAME_CHARS = 48 * 1024;
const NATIVE_CONTROL_CONNECT_TIMEOUT_MS = 10_000;
const NATIVE_CONTROL_IO_TIMEOUT_MS = 5_000;
const NATIVE_CONTROL_CLEANUP_TIMEOUT_MS = 3_000;
let nativeModule: NativeControlModule | null = null;
function module(): NativeControlModule { if (!nativeModule) nativeModule = require('../../../modules/partner-control').default; return nativeModule; }
export class ControlTransportError extends Error { constructor(readonly code: 'wifi_unavailable' | 'busy' | 'connect_failed' | 'send_failed' | 'cleanup_failed', message: string) { super(message); this.name = 'ControlTransportError'; } }
function raw(error: unknown): string { return error instanceof Error ? error.message : String(error ?? ''); }
function validPort(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535; }
function privateIpv4(value: unknown): value is string {
  if (typeof value !== 'string') return false; const p = value.split('.').map(Number); if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function parseEvent(value: unknown): ControlTransportEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const item = value as Record<string, unknown>;
  if (item.type === 'connected') {
    if (Object.keys(item).some((key) => !['type', 'connectionId', 'direction', 'listenerId'].includes(key))) return null;
    if (typeof item.connectionId !== 'string' || !UUID_RE.test(item.connectionId) || (item.direction !== 'inbound' && item.direction !== 'outbound')) return null;
    if (item.listenerId !== undefined && (typeof item.listenerId !== 'string' || !UUID_RE.test(item.listenerId))) return null;
    return item.listenerId === undefined ? { type: 'connected', connectionId: item.connectionId, direction: item.direction } : { type: 'connected', connectionId: item.connectionId, direction: item.direction, listenerId: item.listenerId };
  }
  if (item.type === 'message') {
    if (Object.keys(item).some((key) => !['type', 'connectionId', 'frame'].includes(key))) return null;
    if (typeof item.connectionId !== 'string' || !UUID_RE.test(item.connectionId) || typeof item.frame !== 'string' || !item.frame || item.frame.length > MAX_FRAME_CHARS) return null;
    return { type: 'message', connectionId: item.connectionId, frame: item.frame };
  }
  if (item.type === 'closed') {
    if (Object.keys(item).some((key) => !['type', 'connectionId'].includes(key)) || typeof item.connectionId !== 'string' || !UUID_RE.test(item.connectionId)) return null;
    return { type: 'closed', connectionId: item.connectionId };
  }
  if (item.type === 'error') {
    if (Object.keys(item).some((key) => !['type', 'code', 'connectionId', 'listenerId'].includes(key)) || typeof item.code !== 'string' || !ERROR_RE.test(item.code)) return null;
    if (item.connectionId !== undefined && (typeof item.connectionId !== 'string' || !UUID_RE.test(item.connectionId))) return null;
    if (item.listenerId !== undefined && (typeof item.listenerId !== 'string' || !UUID_RE.test(item.listenerId))) return null;
    return {
      type: 'error',
      code: item.code,
      ...(item.connectionId === undefined ? {} : { connectionId: item.connectionId }),
      ...(item.listenerId === undefined ? {} : { listenerId: item.listenerId }),
    };
  }
  return null;
}

export class ExpoControlTransport implements ControlTransport {
  async startListener(): Promise<ControlListenerEndpoint> {
    try {
      const value = await withTimeout(module().startListener(), NATIVE_CONTROL_CONNECT_TIMEOUT_MS, 'Control listener start timed out.');
      if (!value || !UUID_RE.test(value.listenerId) || !privateIpv4(value.host) || !validPort(value.port)) throw new Error('invalid');
      return value;
    }
    catch (error) { if (/Wi-?Fi|private IPv4/i.test(raw(error))) throw new ControlTransportError('wifi_unavailable', 'Control connection needs active Wi-Fi.'); throw new ControlTransportError('connect_failed', 'PartnerScreen could not open its local control listener.'); }
  }
  async stopListener(listenerId: string): Promise<void> {
    try { await withTimeout(module().stopListener(listenerId), NATIVE_CONTROL_CLEANUP_TIMEOUT_MS, 'Control listener stop timed out.'); }
    catch { throw new ControlTransportError('cleanup_failed', 'PartnerScreen could not close its control listener.'); }
  }
  async connect(host: string, port: number): Promise<string> {
    try {
      const id = await withTimeout(module().connect(host, port), NATIVE_CONTROL_CONNECT_TIMEOUT_MS, 'Control connection timed out.');
      if (!UUID_RE.test(id)) throw new Error('invalid connection id');
      return id;
    }
    catch (error) { const message = raw(error); if (/Wi-?Fi|private IPv4|route/i.test(message)) throw new ControlTransportError('wifi_unavailable', 'Control connection needs a reachable trusted phone on Wi-Fi.'); if (/busy|already active/i.test(message)) throw new ControlTransportError('busy', 'A PartnerScreen control session is already active.'); throw new ControlTransportError('connect_failed', 'PartnerScreen could not connect to the trusted phone.'); }
  }
  async send(connectionId: string, frame: string): Promise<void> {
    try { await withTimeout(module().send(connectionId, frame), NATIVE_CONTROL_IO_TIMEOUT_MS, 'Control send timed out.'); }
    catch { throw new ControlTransportError('send_failed', 'The authenticated control channel could not send data.'); }
  }
  async close(connectionId: string): Promise<void> {
    try { await withTimeout(module().close(connectionId), NATIVE_CONTROL_CLEANUP_TIMEOUT_MS, 'Control close timed out.'); }
    catch { throw new ControlTransportError('cleanup_failed', 'PartnerScreen could not close the control channel cleanly.'); }
  }
  subscribe(listener: (event: ControlTransportEvent) => void): () => void { const sub = module().addListener('onPartnerControlEvent', (rawEvent) => { const event = parseEvent(rawEvent); if (event) listener(event); }); return () => sub.remove(); }
}
