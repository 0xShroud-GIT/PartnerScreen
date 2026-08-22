# Trusted Presence Lifecycle — P0-D

## Native authority
- `PartnerTrustedPresenceService` is a `connectedDevice` foreground service (Android 14+ sanctioned).
- It owns the `ServerSocket` for the control listener, not the Activity/JS process.
- `ControlSession` calls `startTrustedPresence()` on `activatePair` and `stopTrustedPresence()` on `deactivatePair`.
- The service is `START_STICKY`; `onStartCommand` may receive `null` Intent after process death and must reconstruct the listener from persisted state.

## What is persisted vs process-local
- **Persisted (secure):** `PairTrustRepository` (pairId, partnerDeviceId, pairSecret via `expo-secure-store`), `AvailabilityService` generation is not persisted but re-derived from `PairTrust` + `ControlSession` + `WifiEndpoint`.
- **Process-local (not persisted):** `listenerId`, `ServerSocket` instance, `ControlSession` operationQueue, `MediaSessionController` state, `ViewerOwnership` refs, `IncomingRequestIngress.lastRouted`.
- **Never persisted in clear:** pair secret, SDP, ICE candidates, DTLS fingerprints, auth tokens — not in `Intent` extras, not in notification payload, not in `AsyncStorage` ordinary store.

## Activity / JS recreation while native alive
- Native process and `PartnerTrustedPresenceService` remain alive.
- Activity is destroyed/recreated (rotation, back stack, JS reload).
- JS `Activity`/`React` state is lost, but `ControlSession` re-attaches to the existing native listener via `ensureListening()` which returns the same `host:port` + `listenerId` (service-owned).
- Pending `IncomingRequest` is still `IncomingRequest` in `SessionController` and `IncomingRequestNotifier` will re-show notification for the same `sessionId`; deduping via `IncomingRequestIngress` ensures single navigation.
- **Lab evidence:** `PartnerScreenTwin` — `killProcess` with `trustedPresenceActive` keeps service endpoint, `flushUntil IncomingRequest` after `killProcess` still reaches `IncomingRequest` (Activity-level). This is green.

## Actual process death / restart (native process killed)
- Whole app process (including `PartnerTrustedPresenceService`) is killed by system.
- `START_STICKY` causes service to be recreated with `null` Intent. It must reconstruct the listening endpoint from **secure persisted trust** without ever placing the pair secret in ordinary `Intent`/`Bundle`/`Notification`.
- Current implementation in this PR **only** keeps the listener while the native process stays alive (Activity recreation). Full process-death reconstruction that re-creates the `ServerSocket` from secure `PairTrustRepository` on `onStartCommand(null)` is **not yet implemented** and remains **explicitly unproven**.
- **Why not faked:** The lab previously made `killProcess` with `trustedPresenceActive` do `return` (preserve JS callbacks), which made the process-death regression green by preserving JS memory. That is corrected to truthful: `killProcess` now destroys JS callbacks/state. The known-regression for P0-D now tests Activity recreation (green), while true process-death is documented here as unresolved and requires a larger native trust-store bridge (secure `PairTrustRepository` → `PartnerTrustedPresenceService` → `ControlSession` re-attach).

## Scope
- `background Activity != process death` — tests are separate.
- `PendingRequest` for an incoming request is persisted via `PendingRequestStore` (ordinary store, but only `sessionId` + `partnerDeviceId` + `expiresAt`, **no secret**), and is cleared on `accept`/`decline`/`timeout`. After process death, a pending authenticated request is either recoverable via `PendingRequestStore` + re-authenticated control channel, or must fail-closed and return to `PairedAvailable` — currently fail-closed is the documented contract until the bridge is built.

## Next step to make process-death green
- Implement `PartnerTrustedPresenceService.onStartCommand(null)` to read `PairTrustRepository` from `expo-secure-store` (via native `EncryptedSharedPreferences` bridge) and re-create the `ServerSocket` + `AvailabilityService` re-advertise, without ever exposing the secret to JS `Intent`.
- Add native seam test: kill service process, restart service with null Intent, verify `ensureListening` returns same `host:port` and `SessionController` can still reach `IncomingRequest`.
