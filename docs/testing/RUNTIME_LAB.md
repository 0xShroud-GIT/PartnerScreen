# PartnerScreen Runtime Laboratory

Mission 0R changes the development loop from "edit → APK → two phones" into layered evidence. It does not replace milestone physical qualification; it makes most defects reproducible before an APK exists.

## Non-negotiable proof rule

A green lower level proves only that level.

- Node/software-twin PASS does not prove Android APIs.
- Robolectric PASS does not prove real codecs, sockets, MediaProjection or OEM behavior.
- WebRTC loopback PASS proves the bundled WebRTC integration independently of MediaProjection and product UI.
- Emulator PASS does not prove physical Wi-Fi radios, OEM process management or real MediaProjection behavior.
- Only the frozen two-phone APK milestone proves the physical product.

Never promote a test count into a higher proof level.

## Level 1 — software twin, no Android build

Command:

```bash
npm run test:runtime-lab
npm run test:runtime-lab:fuzz
```

The twin creates two PartnerScreen devices in one Node process. It does **not** replace product state machines. Each simulated device wires the real:

`PairingService → PairTrustRepository → AvailabilityService → ControlSession → SessionController → ScreenCaptureCoordinator → MediaSessionController → IncomingRequestNotifier`

Only platform boundaries are simulated:

- pairing transport;
- NSD/discovery;
- control sockets;
- Android capture/consent;
- notifications;
- WebRTC/native media events.

The control path still uses the real `AuthenticatedSignalingCipher`; pairing still uses the real PairingService protocol with deterministic AES-GCM test primitives.

### Deterministic clock

`tests/runtime-lab/VirtualClock.ts` owns test time. Tests explicitly advance it, so a 30-second timeout/reconnect sequence executes without sleeping. A normal `flush()` drains only work due at the current logical time; it never silently fast-forwards through future timers.

### Virtual LAN

`tests/runtime-lab/VirtualNetwork.ts` supports deterministic per-channel:

- latency;
- jitter;
- loss;
- bandwidth;
- outage/reconnect;
- drop-next;
- delay-next.

Channels are separated for pairing, discovery, control, media, notification and lifecycle faults.

### Runtime invariants

`RuntimeInvariantMonitor` fails tests immediately on impossible ownership, including:

- multiple active product sessions;
- multiple Viewer owners for one session;
- multiple capture owners;
- multiple PeerConnection owners per media epoch;
- multiple renderer owners;
- LIVE without a first rendered frame;
- a notification that does not match the current IncomingRequest.

### Seeded lifecycle/fault fuzzing

`npm run test:runtime-lab:fuzz` executes 10,000 reproducible state/network actions. Failure output includes the seed, step and action so the exact sequence can be replayed.

The fuzzer uses the real production authorities, not a parallel model.

## Known regressions — desired behavior, quarantined until P0 fixes

Command:

```bash
npm run test:runtime-lab:known
```

This command is intentionally **not** part of the green Mission 0R gate. It enables desired-product scenarios captured from the failed `1d09ae4d...` APK. They are expected to expose current defects until P0 remediation makes them pass.

Current scenarios include:

- human MediaProjection consent must not consume a media first-frame deadline;
- a stale advertised control endpoint must not remain PairedAvailable;
- POST_NOTIFICATIONS denial must not block in-app MediaProjection sharing;
- trusted background-listener ownership must survive the UI/process-lifecycle contract.

Do not rewrite these assertions to match current broken behavior. P0 fixes must turn them green.

## Level 2 — native JVM/Robolectric, manual-only

Native test seams live in production Kotlin when appropriate so tests do not validate a duplicate TypeScript model.

Current examples:

- `PendingCaptureStartQueue` is consumed by `PartnerScreenCaptureService` and tests latest-valid Stop→Start intent ownership directly;
- `IncomingRequestIntentCodec` is consumed by the notification module and tests cold/warm exact-session intent consumption;
- `NotificationPermissionPolicy` tests Android 12 vs Android 13+ permission semantics;
- `PipParamsFactory` is consumed by the native PiP module and tests Android PiP aspect parameters.

Robolectric is pinned to 4.16.1 and AndroidX Test Core to 1.7.0. This layer is manual-only during Mission 0R and is not triggered by ordinary source edits.

## Level 2b — real Jitsi WebRTC loopback, instrumentation

`WebRtcLoopbackTest` uses the repository's actual `org.jitsi:webrtc:124.0.0` dependency.

Instead of MediaProjection it feeds deterministic generated I420 frames into Peer A and connects two real PeerConnections:

`Synthetic frames → encoder → ICE/DTLS/SRTP → Peer B → decoder → VideoSink`

It asserts:

- both PeerConnections connect;
- a remote track exists;
- decoded frames reach the sink;
- outbound bytes and framesEncoded advance;
- inbound bytes and framesDecoded advance;
- a succeeded selected candidate pair exists;
- frames continue after `restartIce()` plus renegotiation.

This separates "is the bundled WebRTC integration functional?" from "did MediaProjection/UI/lifecycle work?".

## Level 3 — emulator qualification

Level 3 is a manual PR-checkpoint/milestone lane, not a routine source-edit lane.

Target architecture:

- emulator A + emulator B;
- production PartnerScreen APK/runtime;
- real sockets and WebRTC;
- test-only synthetic video source instead of MediaProjection for most media scenarios;
- ADB/UiAutomator/Maestro orchestration;
- deterministic fault presets where the host supports `tc/netem`;
- separate small MediaProjection-specific Android tests.

A production release build must never enable synthetic capture. The synthetic source must be gated to an explicitly debuggable Runtime Laboratory build.

The first Level-3 implementation gate is deliberately narrower than a full UI matrix: authenticated request → accepted session → real WebRTC transport → real renderer first frame → teardown → second session.

## Physical milestone qualification

Physical phones remain mandatory at architecture/release milestones for properties software cannot reproduce faithfully:

- real Android Wi-Fi/NSD behavior and radio transitions;
- OEM process/background-service behavior;
- actual notification permission UI;
- real MediaProjection consent/revoke;
- physical encoder/decoder/thermal behavior;
- rotation/PiP OEM behavior;
- weak-link roaming/interruption;
- screen-off/background lifecycle.

After P0-A through P0-H are green in the lab, build one frozen APK and first prove only:

`partner reachable → request → accept → MediaProjection consent → actual first rendered frame`

Repeat that basic path before expanding to rotation, PiP and reconnect qualification.

## CI policy

`.github/workflows/runtime-lab.yml` is the fast Node-only lane for `m0r/**` branches. It contains no Expo prebuild, Gradle, APK, emulator or Maestro step.

Native and emulator workflows are manual-only. Routine application PRs keep the existing repository CI/build policy; Mission 0R does not make heavy qualification automatic.

## Security invariants

The lab must not weaken production security to make tests easier.

Keep:

- persistent cryptographic pair trust;
- authenticated discovery/control;
- explicit request → accept;
- MediaProjection consent for real screen capture;
- view-only product behavior;
- encrypted WebRTC media;
- fresh session/replay/stale guards;
- sanitized diagnostics;
- no raw SDP/candidate/IP/secret logging;
- no Accessibility remote control;
- no cloud requirement for same-LAN operation.

Synthetic media and deterministic crypto are laboratory fixtures only. They are never production trust or production capture mechanisms.
