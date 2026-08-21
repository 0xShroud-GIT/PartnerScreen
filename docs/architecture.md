# Architecture

## Ownership model

```text
Expo Router / React UI
        │
        ▼
Presentation hooks
        │
        ├── PairingService
        └── SessionController  ← product-session authority
                  │
        ┌─────────┼───────────────┐
        ▼         ▼               ▼
Availability   ControlSession   ScreenCaptureCoordinator
        │         │               │
        ▼         ▼               ▼
Android NSD   local authenticated  MediaProjection / FGS
module        control module       native module
                  │               │
                  └──────┬────────┘
                         ▼
                 MediaSessionController
                         │
                         ▼
                   native WebRTC
                         │
                         ▼
              native remote renderer
                         │
                  first frame → LIVE
```

TypeScript owns product/domain/protocol state and orchestration. Kotlin owns capability-specific Android resources and events, not product truth.

## Key source map

- `src/application/` — composition/services.
- `src/domain/` — identity, pairing, discovery and diagnostic domain logic.
- `src/availability/AvailabilityService.ts` — trusted availability truth.
- `src/control/ControlSession.ts` — authenticated ordered control-session boundary.
- `src/session/SessionController.ts` — one authoritative product-session state machine.
- `src/request/PendingRequestStore.ts` — pending request durability/ownership.
- `src/capture/ScreenCaptureCoordinator.ts` — TypeScript capture orchestration.
- `src/media/MediaSessionController.ts` — media negotiation/LIVE orchestration.
- `src/platform/` — thin adapters to Expo/native capabilities.
- `app/` — routes and UI only.
- `modules/` — Android-owned capabilities.

Do not introduce another authority for one of these responsibilities without a proven architectural need.

## Session identity

A requester creates one product `sessionId` for each screen request that reaches a control session. The same identity binds request, pending request, channel adoption, accept/decline/cancel, SDP/ICE, media, terminal events, diagnostics and cleanup.

Stale or mismatched session events must fail closed.

## Control/session rules

- Maintain one ordered control-session writer/router per active session.
- Validate/authenticate before mutation.
- Incoming request adoption must retain the exact authenticated channel and exact session ID.
- Accept is atomic: adopt the exact pending channel/session or fail as expired; do not launch capture consent after failed adoption.
- A listener failure may invalidate only the exact listener that failed.
- Wi-Fi endpoint changes may create/rebind fresh listening state without destroying unrelated active authenticated connections.

## Resource lifecycle

Every native resource has one explicit owner and deterministic lifecycle.

Rules:

- start/active/stop/disposed states are explicit;
- stop/dispose is idempotent;
- disposal that may block occurs outside shared/global locks;
- callbacks carry enough session/generation/connection/epoch identity to reject stale events;
- replacing A with B invalidates A before A can deliver a late callback into B;
- terminal errors converge on one local-first teardown path;
- peer notification is best-effort after local safety actions;
- reconnect creates fresh authenticated session/native objects instead of reviving broken ones.

## Discovery/availability

Android NSD/local-network code owns registration, browsing, resolution, network binding and low-level resource lifetime. TypeScript owns trusted-pair matching and whether the product says the partner is available.

Availability must prove the advertisement belongs to the saved trusted partner and that the advertised endpoint is reachable before enabling request behavior. Loss or endpoint replacement must not silently mutate durable trust.

## Persistence

Use AsyncStorage for bounded non-secret metadata and SecureStore/Android Keystore-backed storage for trust secrets. Incomplete/provisional pair state does not become confirmed trust after restart. Missing/corrupt secure material fails closed.

## Concurrency

Do not block React Native JS/UI or Android main threads with socket or disposal work. Serialize mutation at the correct owner, keep native worker pools bounded, and re-check ownership after asynchronous work before committing results.
