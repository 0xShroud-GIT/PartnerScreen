export type RuntimeOwnerKind = 'session' | 'viewer' | 'capture' | 'peer_connection' | 'renderer';

export interface RuntimeInvariantSnapshot {
  activeSessions: string[];
  viewers: Record<string, number>;
  captures: Record<string, number>;
  peerConnections: Record<string, number>;
  renderers: Record<string, number>;
}

type OwnerMap = Map<string, number>;

/**
 * Small assertion utility shared by the software twin and development wiring.
 * It contains no platform behavior; callers explicitly claim/release ownership.
 * Production release code may keep the monitor disabled while test/dev builds
 * enable throwing so impossible ownership states fail immediately.
 */
export class RuntimeInvariantMonitor {
  private readonly owners: Record<Exclude<RuntimeOwnerKind, 'session'>, OwnerMap> = {
    viewer: new Map(),
    capture: new Map(),
    peer_connection: new Map(),
    renderer: new Map(),
  };
  private readonly sessions = new Set<string>();

  constructor(private readonly throwOnViolation = true) {}

  claim(kind: Exclude<RuntimeOwnerKind, 'session'>, sessionId: string, maxOwners = 1): () => void {
    const map = this.owners[kind];
    const current = map.get(sessionId) ?? 0;
    const next = current + 1;
    this.require(next <= maxOwners, `${kind} has ${next} owners for session ${sessionId}; max ${maxOwners}.`);
    map.set(sessionId, next);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = map.get(sessionId) ?? 0;
      if (count <= 1) map.delete(sessionId);
      else map.set(sessionId, count - 1);
    };
  }

  activateSession(sessionId: string): () => void {
    this.require(this.sessions.size === 0 || this.sessions.has(sessionId), `multiple active sessions: ${[...this.sessions, sessionId].join(', ')}`);
    this.sessions.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sessions.delete(sessionId);
    };
  }

  assertLive(firstFrameRendered: boolean, sessionId: string): void {
    this.require(firstFrameRendered, `LIVE without first rendered frame for session ${sessionId}.`);
  }

  assertNotification(currentIncomingSessionId: string | null, notificationSessionId: string | null): void {
    this.require(
      notificationSessionId === null || notificationSessionId === currentIncomingSessionId,
      `notification ${notificationSessionId ?? 'none'} does not match incoming ${currentIncomingSessionId ?? 'none'}.`,
    );
  }

  snapshot(): RuntimeInvariantSnapshot {
    return {
      activeSessions: [...this.sessions],
      viewers: Object.fromEntries(this.owners.viewer),
      captures: Object.fromEntries(this.owners.capture),
      peerConnections: Object.fromEntries(this.owners.peer_connection),
      renderers: Object.fromEntries(this.owners.renderer),
    };
  }

  assertClean(): void {
    this.require(this.sessions.size === 0, `active session ownership leaked: ${[...this.sessions].join(', ')}`);
    for (const [kind, map] of Object.entries(this.owners)) {
      this.require(map.size === 0, `${kind} ownership leaked: ${[...map.keys()].join(', ')}`);
    }
  }

  private require(condition: boolean, message: string): void {
    if (!condition && this.throwOnViolation) throw new Error(`INVARIANT VIOLATION: ${message}`);
  }
}
