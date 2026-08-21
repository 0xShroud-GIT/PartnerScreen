# PartnerScreen Runtime Laboratory

Mission 0R changes the development loop from "edit → APK → two phones" into layered evidence. It does not replace milestone physical qualification; it makes most defects reproducible before a physical APK is installed.

## Non-negotiable proof rule

A green lower level proves only that level.

- Node/software-twin PASS does not prove Android APIs.
- Robolectric PASS does not prove real codecs, sockets, MediaProjection or OEM behavior.
- WebRTC loopback PASS proves the bundled WebRTC integration independently of MediaProjection and product UI.
- Two-emulator PASS proves the app/session/socket/WebRTC/renderer path only in the emulator environment and with synthetic capture.
- Emulator PASS does not prove physical Wi-Fi radios, OEM process management, real MediaProjection, notification UX or PiP behavior.
- Only a frozen two-phone milestone candidate can prove the physical product.

Never promote a test count into a higher proof level.

## Level 1 — software twin, no Android build

Commands:

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

The control path still uses the real `AuthenticatedSignalingCipher`; pairing still uses the real `PairingService` protocol with deterministic AES-GCM/HMAC laboratory primitives.

### Deterministic clock

`tests/runtime-lab/VirtualClock.ts` owns test time. Tests explicitly advance it, so long timeout/reconnect sequences execute without sleeping.

Important rule: normal lab draining must process only work due at the current logical time. It must not implicitly fast-forward recurring future work such as media stats polling, because that would hide deadline-ownership defects and can create a non-terminating "run until idle" loop.

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

The fuzzer uses the real production authorities, not a parallel product model.

## Known regressions — desired behavior, quarantined until P0 fixes

Command:

```bash
npm run test:runtime-lab:known
```

This command is intentionally **not** part of the green Mission 0R gate. It enables desired-product scenarios captured from the failed `1d09ae4d...` physical candidate. They are expected to expose current defects until P0 remediation makes them pass.

Current scenarios include:

- human MediaProjection consent must not consume a media first-frame deadline;
- a stale advertised control endpoint must not remain PairedAvailable;
- POST_NOTIFICATIONS denial must not block in-app MediaProjection sharing;
- trusted background-listener ownership must survive the UI/process-lifecycle contract.

Do not rewrite these assertions to match current broken behavior. P0 fixes must turn them green.

## Level 2 — native JVM/Robolectric, manual-only

Native test seams live in production Kotlin when appropriate so tests do not validate duplicate TypeScript models.

Current examples:

- `PendingCaptureStartQueue` is consumed by `PartnerScreenCaptureService` and tests latest-valid Stop→Start intent ownership directly;
- `IncomingRequestIntentCodec` is consumed by the notification module and tests cold/warm exact-session intent consumption;
- `NotificationPermissionPolicy` tests Android 12 vs Android 13+ permission semantics;
- `PipParamsFactory` is consumed by the native PiP module and tests Android PiP aspect parameters;
- `RuntimeLabPairingIntentCodec` is consumed by the debug-only lab module and tests one-shot, bounded QR-camera-substitution input.

Robolectric is pinned to 4.16.1 and AndroidX Test Core to 1.7.0.

Manual workflow:

`Runtime Laboratory native gates → native`

This workflow may run Expo prebuild and Gradle because it is an explicit Level-2 qualification action. It is never triggered by routine source edits.

## Level 2b — real Jitsi WebRTC loopback, instrumentation

`WebRtcLoopbackTest` uses the repository's actual `org.jitsi:webrtc:124.0.0` dependency.

Instead of MediaProjection it feeds deterministic generated I420 frames into Peer A and connects two real PeerConnections:

`Synthetic frames → encoder → ICE/DTLS/SRTP → Peer B → decoder → VideoSink`

It asserts:

- both PeerConnections connect;
- a remote track exists;
- decoded frames reach the sink;
- outbound bytes and `framesEncoded` advance;
- inbound bytes and `framesDecoded` advance;
- a succeeded candidate pair exists;
- frames continue after `restartIce()` plus renegotiation.

Manual workflow:

`Runtime Laboratory native gates → webrtc-loopback`

This separates "is the bundled Jitsi/WebRTC integration functional?" from "did MediaProjection/UI/lifecycle work?".

## Level 3 — two-emulator product qualification

Level 3 is manual-only. It exercises the actual application UI and production session/media authorities on two Android emulators while replacing only the real screen-capture source.

### Required build flags

The Runtime Lab APK must be a **debuggable** build and must be bundled with:

```text
EXPO_PUBLIC_PARTNERSCREEN_RUNTIME_LAB=1
EXPO_PUBLIC_PARTNERSCREEN_TEST_CAPTURE=synthetic
```

These JavaScript flags are not sufficient to activate a native lab hook. The native synthetic-capture and QR-camera-substitution entry points independently require `ApplicationInfo.FLAG_DEBUGGABLE`. A release/non-debuggable app refuses them.

### Pairing is not bypassed

Level 3 does **not** inject a pair secret or install trusted metadata.

The runner performs:

1. emulator A creates a normal one-time `PairingService` QR;
2. the runner screenshots that actual QR and decodes it locally;
3. the exact QR payload is passed once to emulator B through a debuggable camera-substitution intent;
4. B calls the normal `PairingService.startScanner(payload)` path;
5. the existing QR parser/TTL/private-endpoint checks run;
6. the normal pairing socket and authenticated protocol run;
7. B explicitly confirms A;
8. A explicitly confirms B;
9. normal durable pair trust is installed.

The one-time QR payload contains a bootstrap credential, so the runner never echoes it and never uploads it as an artifact.

### Synthetic capture is a capture-source substitution only

In the Runtime Lab build, the normal `ScreenCaptureCoordinator` still owns the session and capture state. Its platform adapter routes consent/capture to `WebRtcEngine.startSyntheticCaptureForTest()` instead of Android MediaProjection.

The generated I420 source then enters the same production WebRTC engine used by ordinary capture:

`SyntheticTestCapturer → VideoSource/VideoTrack → production offer/answer/ICE → encoder → encrypted WebRTC → decoder → PartnerRemoteVideoView → onFirstFrame → LIVE`

The synthetic pattern moves every frame so frozen rendering can be detected automatically.

This proves neither Android MediaProjection nor the capture foreground service. Those remain Level-2/native-lifecycle and physical-phone evidence.

### Emulator networking requirement

The manual two-emulator lane requires Android Emulator **37.1.11 or newer** and two distinct AVDs. That emulator generation added same-host multi-device networking so AVDs can discover and communicate over a common virtual network, including Network Service Discovery, instead of relying on test-only ADB port forwarding.

Distinct AVDs are required; do not clone a running snapshot into two devices with identical networking identity.

### Product-level gate

`scripts/runtime-lab-two-emulators.sh` requires an already-built Runtime Lab APK through `APK_PATH` and drives the actual UI with Maestro.

The current narrow gate requires:

`name devices → normal authenticated pair/confirm → both Available → Request Screen → Accept → synthetic capture → real Viewer LIVE → changing rendered screenshot → Stop → both Available`

The screenshot freshness check takes two full-screen Viewer captures one second apart and fails if they are byte-identical while the synthetic pattern should be moving.

Manual workflow:

`Runtime Laboratory native gates → two-emulator`

The workflow installs Android Emulator 37.1.11+, creates two distinct API-36 x86_64 AVDs, builds a debug x86_64 Runtime Lab APK, and invokes the host runner. This is deliberately never automatic on ordinary source edits.

## Physical milestone qualification

Physical phones remain mandatory at architecture/release milestones for properties software cannot reproduce faithfully:

- real Android Wi-Fi/NSD behavior and radio transitions;
- cellular/Wi-Fi route competition;
- OEM process/background-service behavior;
- actual notification permission UI and notification delivery policy;
- real MediaProjection consent/revoke and foreground-service behavior;
- hardware encoder/decoder/thermal behavior;
- rotation/PiP OEM behavior;
- weak-link roaming/interruption;
- screen-off/background lifecycle.

After P0-A through P0-H are green in the lab, build one frozen physical candidate and first prove only:

`partner reachable → request → accept → MediaProjection consent → actual first rendered frame`

Repeat that basic path before expanding to rotation, PiP and reconnect qualification.

## CI policy

`.github/workflows/runtime-lab.yml` is the fast Node-only lane for `m0r/**` branches. It contains no Expo prebuild, Gradle, APK, emulator or Maestro step.

`.github/workflows/runtime-lab-native.yml` is `workflow_dispatch` only and owns the three explicit heavier levels:

- `native`;
- `webrtc-loopback`;
- `two-emulator`.

Routine application PRs keep the existing repository CI/build policy. Mission 0R does not make heavy qualification automatic.

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

Synthetic media, deterministic crypto, and the pairing-camera substitute are laboratory fixtures only. They are never production trust or production capture mechanisms.
