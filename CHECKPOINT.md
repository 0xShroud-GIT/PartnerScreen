# PartnerScreen Checkpoint

**Updated:** 2026-08-22  
**Phase:** Mission 0P — P0 Runtime Repair  
**Working branch:** `arena/01a026b0-partnerscreen`  
**Authoritative base:** `m0r/runtime-laboratory` @ `8debb2aed822872c430c9d9d2d1dc7ee29f2b048`

## Current truth

Mission 0 produced a native APK but physical Mission 0Q failed badly on two phones. The failed physical candidate was `1d09ae4dfec7f0d998b02bb7b92a89722d2c8f48`.

Observed failures included severe responsiveness/freezing, slow discovery, false availability followed by control timeout, unreliable reconnect, notification permission UX failure, background-request dependence on process liveness, MediaProjection/capture starting without a rendered remote frame, repeatable ~15-second media termination, duplicate Viewer/keep-awake ownership, broken PiP, and unreliable session lifecycle.

Mission 0R created the software-first Runtime Laboratory at `8debb2aed822872c430c9d9d2d1dc7ee29f2b048`. Mission 0P repairs P0-A through P0-H on top of that base. Mission 1 remains blocked.

## Mission 0P repair scope

P0-A — discovery / availability / control truth  
P0-B — sanitized pre-LIVE WebRTC observability  
P0-C — phase-correct media timing and bounded recovery  
P0-D — trusted background presence lifecycle  
P0-E — notification / permission correctness  
P0-F — Viewer / PiP / keep-awake ownership  
P0-G — responsiveness / queues / diagnostics  
P0-H — verification architecture

The repair preserves persistent cryptographic pair trust, authenticated discovery/control, explicit request→accept→MediaProjection consent, view-only behavior, encrypted WebRTC, fresh session IDs/replay guards, stale-generation guards, sanitized diagnostics, and local operation without cloud.

## Direct correction pass after Arena review

A second source review found remaining integration defects after Arena's reported software-green head. These have been corrected directly on PR #12:

- React Rules-of-Hooks violation in `app/index.tsx` removed; all hooks execute before the loading return.
- Viewer routing now reserves ownership before `router.push`, then the Viewer adopts that reservation on mount; duplicate auto/manual pushes cannot race before mount.
- PiP geometry is reset on exact requester session / renderer epoch changes.
- native `getStats()` uses one actual global in-flight token; timeout abandons only sample consumption and cannot manufacture completion across session replacement.
- notification permission state refreshes on actual foreground return; prompting is explicit foreground UI only; denied/channel-disabled states route to Android settings.
- notification production code again consumes the same `IncomingRequestIntentCodec` and `NotificationPermissionPolicy` exercised by Robolectric tests.
- Runtime Lab `killProcess()` is destructive even with trusted presence active; Activity/UI recreation is a separate scenario.
- true full-process-death reconstruction is explicitly unproven and skipped until a secure native trust-store reconstruction bridge exists.

## Native source integrity correction

The direct review also found native Runtime Lab files that had been replaced by literal stale-tool output of the form `fatal: path ... not in 'tmp/pr11'`. Those files were restored from the authoritative Mission 0R base rather than rewritten:

- PiP factory + test;
- capture pending-start queue + test;
- Runtime Lab debug gate + test;
- production debug-only synthetic capturer;
- instrumentation synthetic capturer;
- WebRTC loopback instrumentation;
- notification intent codec / permission policy and tests;
- native test Gradle configuration/dependencies for notification, PiP, and capture.

A PR-wide patch scan after restoration contains no `tmp/pr11` corruption marker. The only remaining `fatal: path` text is an intentional JS integrity assertion that checks native helper sources do not contain that corruption.

## P0-D proof boundary

`PartnerTrustedPresenceService` currently provides a `connectedDevice` foreground-service lifetime while the Android process is alive. The control `ServerSocket` still lives in the process-scoped native control runtime; the service itself does not reconstruct that socket after full process death.

Therefore:

- Activity/UI recreation with the native process alive: software contract implemented; native/emulator/physical behavior still unqualified.
- React runtime re-attachment to surviving native authority: source architecture present but not yet qualified.
- full process death + `START_STICKY` restart + secure trusted-listener reconstruction: **NOT IMPLEMENTED / NOT PROVEN**.

Full process death must fail closed until a separately reviewed native secure-trust reconstruction bridge exists.

## Evidence status

| Layer | Status |
| --- | --- |
| Mission 0 source/product tests | PASS historically — 175/175 at merged Mission 0 |
| Mission 0 native APK compile | PASS historically — exact `1d09ae4d...` |
| Mission 0Q physical two-phone behavior | **FAIL** |
| Mission 0R source architecture | Implemented at `8debb2a...` |
| Arena Mission 0P earlier software run | Reported green before the direct correction pass; **superseded as evidence for current head** |
| Current Mission 0P corrected-head TypeScript/product/runtime-lab tests | **NOT YET EXECUTED / no PR workflow result visible** |
| Current native JVM/Robolectric tests | **NOT EXECUTED** |
| Current WebRTC instrumentation loopback | **NOT EXECUTED** |
| Current two-emulator product lane | **NOT EXECUTED** |
| Current physical two-phone behavior | **NOT QUALIFIED** |
| Mission 1 | **BLOCKED** |

## Qualification policy

No APK, Gradle, Expo prebuild, emulator, Maestro, or physical qualification is run during the current source-fix pass.

The next gate is software execution of the corrected head:

1. `npm ci`
2. `npm run typecheck`
3. `npm run test:product`
4. `npm run test:runtime-lab`
5. `npm run test:runtime-lab:fuzz`
6. `npm run test:runtime-lab:known`
7. `npm run check:contracts`
8. `npm run check:baseline`
9. `npm run sanitize`
10. `npm run config:check`
11. `npm run deps:check`

Only after that corrected source gate is green should the explicit Level-2 native/JVM gate run. WebRTC loopback follows Level 2; two-emulator follows those gates; one frozen physical candidate follows only after the software/native/emulator evidence is accepted.

## High-risk invariants

- one active product session per device;
- one Viewer route reservation/owner per requester session;
- one capture owner per sharer session;
- one actual native stats call at a time;
- one peer-connection owner per media epoch;
- LIVE requires the exact current renderer/session/track epoch's actual rendered frame;
- pair trust survives recoverable media failure;
- stale sessions/endpoints/notifications cannot affect the current session;
- notification session ID must equal the exact current `IncomingRequest`;
- notification permission never controls MediaProjection eligibility;
- no test fixture installs durable pair trust directly;
- no synthetic capture/test pairing hook works in a non-debuggable app;
- no secrets, raw SDP, ICE candidate strings, or full IPs in ordinary diagnostics.
