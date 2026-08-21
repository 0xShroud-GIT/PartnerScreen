# PartnerScreen Checkpoint

**Updated:** 2026-08-22  
**Phase:** Mission 0R — Runtime Laboratory  
**Working branch:** `m0r/runtime-laboratory`  
**Base:** `1d09ae4dfec7f0d998b02bb7b92a89722d2c8f48` (`main`, merged Mission 0)

## Current truth

Mission 0 was merged and the exact merge commit successfully produced a native Android development APK in the manual GitHub qualification lane. Source/prebuild/native-compilation success did **not** translate into a reliable two-phone product.

Physical Mission 0Q against `1d09ae4dfec7f0d998b02bb7b92a89722d2c8f48` failed. Observed behavior included:

- app freezes / severe responsiveness problems;
- partner discovery materially slower than the previously working behavior;
- `PairedAvailable` followed by control connection failures;
- unreliable reconnect/recovery;
- incoming notification permission not prompted reliably and requiring manual grant;
- incoming request notification behavior dependent on app/process liveness;
- MediaProjection consent and capture startup succeeding but no actual first rendered remote frame;
- repeatable termination around the 15-second initial-video deadline;
- duplicate `viewer_opened` and `keep_awake_enabled` ownership signals;
- PiP not functioning;
- session lifecycle generally unreliable.

The 175/175 product tests and 13/13 static contracts from Mission 0 are therefore source evidence only. They are not device qualification.

## Mission 0R purpose

Before P0 runtime fixes, build a software-first qualification laboratory so failures become permanent reproducible scenarios instead of requiring a two-phone APK cycle for every edit.

Mission 0R is infrastructure-only:

- two-peer software twin using the real PartnerScreen pairing/discovery/control/session/capture/media authorities;
- deterministic virtual clock;
- deterministic fault-injectable virtual LAN;
- simulated Android notification/capture/media ports;
- runtime ownership invariants;
- seeded lifecycle/fault fuzzing;
- Robolectric/native unit-test seams consumed by production Kotlin;
- real Jitsi WebRTC synthetic-frame loopback instrumentation;
- manual native/emulator qualification lanes;
- known physical failures encoded as quarantined desired-behavior regressions.

Mission 0R does **not** repair P0-A through P0-H, does not change the V2 product architecture, and does not claim runtime correctness.

## Evidence status

| Layer | Status |
| --- | --- |
| Mission 0 source/product tests | PASS — 175/175 at merged Mission 0 |
| Mission 0 static contracts | PASS — 13/13 at merged Mission 0 |
| Mission 0 native APK compile | PASS — exact `1d09ae4d...` manual qualification build |
| Mission 0Q physical two-phone behavior | **FAIL** |
| Mission 0R Node software twin | **Implementation in progress / not yet accepted** |
| Mission 0R native JVM/Robolectric tests | **Scaffolded / not run in this mission** |
| Mission 0R WebRTC instrumentation loopback | **Scaffolded / not run in this mission** |
| Mission 1 | **Blocked** |

## Build policy for Mission 0R

Do not run:

- Expo prebuild;
- Gradle/native build;
- APK workflow;
- Maestro;
- emulator qualification;
- physical qualification.

Only the Node/software Runtime Laboratory lane may run while the lab is being constructed. Native/emulator layers are manual-only infrastructure to use after source review.

## Next gate

1. Complete and review Mission 0R infrastructure.
2. Run/repair the software-twin and fuzz source lane until green.
3. Do **not** normalize known regressions to current broken behavior; P0 work must make those desired-behavior tests green.
4. Implement P0-A through P0-H sequentially, proving each in the Runtime Laboratory.
5. Only then build one frozen APK and repeat the smallest physical gate: availability → request → accept → consent → actual first rendered frame, repeatedly.

## High-risk invariants

- one active product session per device;
- one viewer owner per requester session;
- one capture owner per sharer session;
- one peer-connection owner per media epoch;
- LIVE requires the current renderer/session/track epoch's actual first rendered frame;
- pair trust survives recoverable media failure;
- stale sessions/endpoints/notifications cannot affect the current session;
- notification session ID must equal the exact current `IncomingRequest`;
- no secrets, raw SDP, ICE candidate strings, or full IPs in ordinary diagnostics.
