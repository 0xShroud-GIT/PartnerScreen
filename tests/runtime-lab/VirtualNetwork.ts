import { VirtualClock } from './VirtualClock';

export type LabChannel = 'pairing' | 'discovery' | 'control' | 'media' | 'notification' | 'lifecycle';

export interface NetworkProfile {
  latencyMs: number;
  jitterMs: number;
  loss: number;
  bandwidthBps: number | null;
}

const HEALTHY: NetworkProfile = { latencyMs: 0, jitterMs: 0, loss: 0, bandwidthBps: null };

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

/**
 * Fault-injectable deterministic virtual LAN shared by the two simulated phones.
 * A send completing only means the local stack accepted it; delivery may later be
 * dropped, delayed or made stale, matching real socket/WebRTC semantics.
 */
export class VirtualNetwork {
  private readonly profiles = new Map<LabChannel, NetworkProfile>();
  private readonly disconnected = new Set<LabChannel>();
  private readonly dropNextCount = new Map<LabChannel, number>();
  private readonly extraDelayNext = new Map<LabChannel, number>();
  private readonly random: SeededRandom;
  private globallyConnected = true;

  constructor(readonly clock: VirtualClock, seed = 0x50415254) {
    this.random = new SeededRandom(seed);
  }

  setProfile(channel: LabChannel, update: Partial<NetworkProfile>): void {
    const current = this.profile(channel);
    const next = { ...current, ...update };
    if (next.latencyMs < 0 || next.jitterMs < 0 || next.loss < 0 || next.loss > 1) throw new Error('Invalid virtual-network profile.');
    if (next.bandwidthBps !== null && next.bandwidthBps <= 0) throw new Error('Invalid virtual-network bandwidth.');
    this.profiles.set(channel, next);
  }

  profile(channel: LabChannel): NetworkProfile {
    return this.profiles.get(channel) ?? HEALTHY;
  }

  disconnect(channel?: LabChannel): void {
    if (channel) this.disconnected.add(channel);
    else this.globallyConnected = false;
  }

  reconnect(channel?: LabChannel): void {
    if (channel) this.disconnected.delete(channel);
    else this.globallyConnected = true;
  }

  isConnected(channel: LabChannel): boolean {
    return this.globallyConnected && !this.disconnected.has(channel);
  }

  dropNext(channel: LabChannel, count = 1): void {
    this.dropNextCount.set(channel, Math.max(0, Math.floor(count)));
  }

  delayNext(channel: LabChannel, extraDelayMs: number): void {
    this.extraDelayNext.set(channel, Math.max(0, Math.floor(extraDelayMs)));
  }

  /** Returns false when the packet was deterministically dropped. */
  transmit(channel: LabChannel, bytes: number, deliver: () => void): boolean {
    if (!this.isConnected(channel)) return false;

    const forcedDrops = this.dropNextCount.get(channel) ?? 0;
    if (forcedDrops > 0) {
      this.dropNextCount.set(channel, forcedDrops - 1);
      return false;
    }

    const profile = this.profile(channel);
    if (profile.loss > 0 && this.random.next() < profile.loss) return false;

    const jitter = profile.jitterMs === 0 ? 0 : Math.round((this.random.next() * 2 - 1) * profile.jitterMs);
    const serialization = profile.bandwidthBps === null ? 0 : Math.ceil((Math.max(0, bytes) * 8 * 1000) / profile.bandwidthBps);
    const extra = this.extraDelayNext.get(channel) ?? 0;
    this.extraDelayNext.delete(channel);
    const delay = Math.max(0, profile.latencyMs + jitter + serialization + extra);
    this.clock.schedule(delay, deliver);
    return true;
  }

  requireReachable(channel: LabChannel, message = 'Virtual network is unreachable.'): void {
    if (!this.isConnected(channel)) throw new Error(message);
  }

  presets = {
    healthyLan: (): void => this.setProfile('media', { latencyMs: 30, jitterMs: 0, loss: 0, bandwidthBps: null }),
    weakWifi: (): void => this.setProfile('media', { latencyMs: 80, jitterMs: 30, loss: 0.03, bandwidthBps: 1_000_000 }),
    badWifi: (): void => this.setProfile('media', { latencyMs: 150, jitterMs: 60, loss: 0.10, bandwidthBps: 600_000 }),
  };
}
