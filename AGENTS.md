# PartnerScreen Agent Instructions

This is the single permanent instruction file for AI agents working in the PartnerScreen repository.

## Start every task

1. Read `CHECKPOINT.md` before modifying anything.
2. Inspect the code and tests relevant to the requested change.
3. Open only the relevant document under `docs/`; do not preload the whole repository documentation.
4. Treat code, tests, package/config files and native module source as truth when an old statement conflicts with implementation.
5. Make the smallest coherent change that fixes the real problem.
6. Run the strongest verification available for the changed boundary.
7. Update `CHECKPOINT.md` when the project state, blocker, validation result, or next action materially changes.

Do not create another agent instruction system (`CLAUDE.md`, `GEMINI.md`, nested agent rule folders, mission prompts, etc.) unless the repository owner explicitly requests it.

## Project boundary

PartnerScreen V1 is Android-only, same-LAN, direct peer-to-peer screen viewing between one trusted pair.

Do not add without an explicit product decision:

- cloud signaling or runtime backend;
- TURN/cloud media relay;
- accounts;
- recording/screenshots;
- remote input/control;
- microphone or camera streaming (camera is used only for pairing QR scan);
- analytics, ads, tracking;
- multi-party rooms/chat/file transfer;
- a framework rewrite.

## Architecture ownership

- TypeScript owns product/domain/session/protocol state.
- React components and hooks render state and dispatch intents; they do not own sockets, capture, WebRTC, or durable product truth.
- Kotlin Expo Modules own only Android capability/resource lifecycles that require native ownership.
- `SessionController` is the authoritative product-session state owner.
- One `ControlSession` serves the active product session.
- One product `sessionId` binds request, pending request, control, SDP/ICE, media and terminal events end-to-end.
- One MediaProjection owner, one mediaProjection foreground service, one capturer, and one native WebRTC session exist per active sharing session.
- Generated root `android/` and `ios/` directories are CNG build output, not source of truth.

See `docs/architecture.md` and `docs/android-media.md` when changing these boundaries.

## Non-negotiable lifecycle rules

- Resource ownership must be explicit and singular.
- Start/active/stop/disposed transitions must be deterministic.
- Stop/dispose must be safe to call repeatedly.
- Do not perform blocking Android/native disposal while holding global/shared locks.
- Stale callbacks/events/promises must be scoped by the correct session/generation/epoch and must not mutate replacement resources.
- Reconnect creates fresh authenticated transport/session/native resources; never resurrect a broken connection or PeerConnection.
- Durable pair trust survives temporary network loss, but stale session authority does not.
- Local Stop, projection revoke and fatal native termination perform local cleanup even if peer notification fails.
- Fatal paths converge on one idempotent teardown path.

## LIVE truth

`LIVE` is earned only after the viewer's native renderer reports an actual first rendered remote frame for the current session/track epoch.

The following are not sufficient: ICE connected/completed, signaling stable, remote track arrival, renderer mount, or React state alone.

Never weaken this rule to make a test or UI state easier to satisfy.

## Security rules

- Treat the LAN as untrusted.
- Authenticate/decrypt and validate peer, protocol version/type, session identity, timestamp/replay and state before side effects.
- Fail closed; never fall back to plaintext or permissive handling.
- Pair/bootstrap secrets and durable pair keys must never enter AsyncStorage, source, config, logs or diagnostics.
- Do not log full SDP, ICE credentials, QR secrets, private crypto material, or screen content.
- Preserve Android Keystore/SecureStore-backed durable trust semantics.

See `docs/protocol-security.md` before pairing, control, persistence or crypto changes.

## Engineering discipline

- Keep the current Expo/React Native + TypeScript + Kotlin architecture unless a proven blocker requires change.
- Prefer existing owners and abstractions over introducing another service/controller/manager.
- Keep native bridges narrow and capability-oriented.
- Do not duplicate product state in UI or native code.
- Do not silently broaden Android permissions.
- Do not change protocol messages speculatively.
- Fix root causes at the authoritative owner and add a focused regression test when practical.
- Preserve public behavior unless the task explicitly changes the product contract.
- Avoid large refactors mixed with a bug fix.

## Validation

Normal source gate:

```bash
npm ci
npm run typecheck
npm run test:product
npm run check:contracts
npm run check:baseline
npm run sanitize
npm run config:check
npm run deps:check
```

Use focused `test:m1` … `test:m8` suites while developing when they reduce iteration cost, but run `test:product` before considering a material cross-cutting change complete.

Android/native truth requires an Android SDK build; physical behavior requires actual device evidence. Never promote source/static success into build/device success.

## GitHub workflow

GitHub is the canonical development workspace and source of truth.

Keep Git usage lightweight:

- focused commits with meaningful messages;
- practical tests that protect real invariants;
- no generated APKs, native CNG output, signing material or local caches;
- no process/governance machinery unless it protects a concrete high-risk invariant.

Before handing work to another agent, leave the repository coherent and update `CHECKPOINT.md` with only current, decision-relevant state.
