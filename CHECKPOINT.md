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

## Mission 0R implementation

Mission 0R establishes a software-first qualification laboratory before P0 runtime fixes so failures become permanent reproducible scenarios instead of requiring a two-phone APK cycle for every edit.

Implemented infrastructure includes:

- two-peer software twin using the real PartnerScreen pairing/discovery/control/session/capture/media authorities;
- deterministic virtual clock plus explicit time advancement;
- seeded fault-injectable virtual LAN;
- simulated Android notification/capture/media ports;
- runtime ownership invariants;
- 10,000-action seeded lifecycle/fault fuzzing;
- known physical failures encoded as quarantined desired-behavior regressions;
- production Kotlin seams with Robolectric tests for capture command arbitration, notification intents/permission policy, PiP parameters, and Runtime Lab pairing input;
- real `org.jitsi:webrtc:124.0.0` synthetic-frame PeerConnection loopback instrumentation including ICE restart;
- debug-only synthetic capture routed through the production `WebRtcEngine` and normal `ScreenCaptureCoordinator`;
- debug-only pairing-camera substitution that transports the creator's actual one-time QR into the normal `PairingService.startScanner()` path without injecting trust;
- two-emulator Maestro product path requiring real pair confirmation, availability, request/accept, real WebRTC/renderer LIVE, moving-frame freshness smoke, and teardown;
- Node-only automatic Runtime Lab workflow plus explicit manual native/WebRTC/two-emulator qualification workflow.

Runtime Lab native hooks require both the explicit JavaScript lab flag and a debuggable Android application where applicable. No release/non-debuggable build may activate synthetic capture or pairing-camera substitution.

Mission 0R does **not** repair P0-A through P0-H, does not change the V2 product architecture, and does not claim runtime correctness.

## Evidence status

| Layer | Status |
| --- | --- |
| Mission 0 source/product tests | PASS — 175/175 at merged Mission 0 |
| Mission 0 static contracts | PASS — 13/13 at merged Mission 0 |
| Mission 0 native APK compile | PASS — exact `1d09ae4d...` manual qualification build |
| Mission 0Q physical two-phone behavior | **FAIL** |
| Mission 0R Node software twin + fuzz | **Implemented; acceptance result not yet recorded** |
| Mission 0R native JVM/Robolectric tests | **Implemented; not yet qualified** |
| Mission 0R WebRTC instrumentation loopback | **Implemented; not yet qualified** |
| Mission 0R two-emulator product lane | **Implemented; not yet qualified** |
| Mission 1 | **Blocked** |

## Qualification policy for Mission 0R

Routine `m0r/**` source edits use only the Node Runtime Laboratory workflow. It contains no Expo prebuild, Gradle, APK, emulator or Maestro step.

The heavier workflow `Runtime Laboratory native gates` is `workflow_dispatch` only. Its `native`, `webrtc-loopback`, and `two-emulator` levels may be executed only as an explicit qualification action after source review.

The two-emulator lane uses synthetic capture and pre-granted notification permission deliberately; it does not qualify MediaProjection, notification permission UX, foreground-service policy, OEM radio behavior, or physical PiP.

## Next gate

1. Review Mission 0R source/infrastructure diff.
2. Record a green Node twin/fuzz result.
3. Explicitly run Level 2 native tests, then the WebRTC loopback, repairing the lab itself if those gates expose infrastructure defects.
4. Explicitly run the two-emulator product gate only after Levels 1/2 are accepted.
5. Do **not** normalize known regressions to current broken behavior; P0 work must make those desired-behavior tests green.
6. Implement P0-A through P0-H sequentially, proving each in the Runtime Laboratory.
7. Only after P0 software/native/emulator evidence is green, build one frozen physical candidate and repeat the smallest two-phone gate: availability → request → accept → consent → actual first rendered frame, repeatedly.

## High-risk invariants

- one active product session per device;
- one viewer owner per requester session;
- one capture owner per sharer session;
- one peer-connection owner per media epoch;
- LIVE requires the current renderer/session/track epoch's actual first rendered frame;
- pair trust survives recoverable media failure;
- stale sessions/endpoints/notifications cannot affect the current session;
- notification session ID must equal the exact current `IncomingRequest`;
- no test fixture installs durable pair trust directly;
- no synthetic capture/test pairing hook works in a non-debuggable app;
- no secrets, raw SDP, ICE candidate strings, or full IPs in ordinary diagnostics.
