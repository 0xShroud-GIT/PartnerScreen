# Trusted Presence Lifecycle — P0-D

## Current native authority
- `PartnerTrustedPresenceService` is a `connectedDevice` foreground service used to keep trusted local availability/control eligible to run while the UI is backgrounded.
- **The service does not currently own the control `ServerSocket`.** The socket/listener remains in the process-scoped `PartnerControlModule` runtime.
- `ControlSession` calls `startTrustedPresence()` on pair activation and `stopTrustedPresence()` on pair deactivation.
- The service is `START_STICKY`, but a sticky service restart alone is not sufficient to reconstruct authenticated PartnerScreen control authority after full process death.

## What is persisted vs process-local
- **Persisted (secure):** `PairTrustRepository` metadata and pair secret via the existing secure-store path.
- **Persisted non-secret request metadata:** pending request session/device/expiry information only; never pair secrets or media credentials.
- **Process-local:** listener ID, `ServerSocket`, control connections, `ControlSession` queue/subscriptions, media state, Viewer ownership, route dedupe memory, foreground-service in-memory flags.
- **Never persisted in clear:** pair secret, SDP, ICE candidates, ICE credentials, DTLS fingerprints, auth tokens.

## Background / Activity recreation while process stays alive — supported source contract
- The Android process remains alive and the connected-device FGS remains running.
- Activity/UI recreation does not tear down the process-scoped control listener.
- The Runtime Lab models this with `recreateActivity()`, which intentionally leaves transport authority untouched.
- A paired partner can still create an authenticated incoming request while the UI is recreated.
- This is software-level evidence only; OEM/background behavior remains emulator/physical-unproven.

## React runtime recreation while native process stays alive — not yet qualified
- `PartnerControlModule` uses process-scoped native state so a new JS runtime should be able to attach to the surviving listener.
- Reconstructing the full JS `ControlSession`/`SessionController` presentation around that listener is not treated as proven by the Activity-only twin scenario.
- This requires the native/emulator lifecycle gate before it can be claimed.

## Full process death / sticky service restart — explicitly unproven
- Full app-process death destroys the foreground service, native listener/socket, control connections, JS callbacks and process-local state.
- Runtime Lab `killProcess()` now destroys those objects even when trusted presence was active. It does not preserve JS callbacks to manufacture a green result.
- Android may recreate a `START_STICKY` service with a null Intent. The current service can restart its foreground notification, but it cannot securely reconstruct the authenticated listener because it has no native secure-trust bridge.
- Therefore **full process-death background reachability is not implemented or claimed in Mission 0P**.
- Until reconstruction exists, process death is fail-closed: stale availability must disappear and no unauthenticated request may be accepted.

## Required future bridge for true process-death recovery
A later, separately reviewed change must provide a native secure authority that can:
1. recover confirmed pair/trust material from an Android-native secure store without placing secrets in Intent/Bundle/notification/ordinary storage;
2. recreate the control listener and fresh listener generation on sticky restart;
3. re-advertise only after the exact reconstructed control endpoint is reachable;
4. require the normal authenticated control handshake before any incoming request is surfaced;
5. let a newly created JS runtime attach to that authority without importing secret material through unsafe channels.

That bridge must receive native JVM/emulator and physical process-death qualification before P0-D can claim full process-death reachability.
