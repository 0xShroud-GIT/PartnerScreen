# PartnerScreen V2 — Arena Mission Sequence

**Status:** locked execution sequence, amended after the failed Mission 0Q physical gate.

Arena works one mission at a time. A mission may prepare evidence for the next mission, but it must not implement future missions early.

## Global rules

- Read `AGENT_HANDOFF.md`, `V2_ARCHITECTURE_BLUEPRINT.md`, `V2_INTEGRATION_CONTRACT.md`, and `V2_IMPLEMENTATION_ROADMAP.md` before changing code.
- Preserve trusted pairing, explicit request/accept, MediaProjection consent, view-only behavior, encryption, stale/replay guards, and sanitized diagnostics.
- No APK build, Maestro dispatch, or heavy native qualification unless the mission explicitly says to run the manual qualification gate.
- Never weaken security to match ZeroLink. Harvest its freshness, lifecycle, Wi-Fi Direct, rotation, reconnect, and viewer lessons only.
- Never treat generated visual boards as functional requirements.
- Do not merge a mission PR unless explicitly authorized.
- A source/unit/static-contract pass never counts as Android physical proof.

## Mission 0 — Stabilize current PartnerScreen — historical result

Mission 0 was merged at `1d09ae4dfec7f0d998b02bb7b92a89722d2c8f48` after source/prebuild review.

It implemented source-level stabilization work including media deadlines/recovery, Stop→Start handling, notification routing, PiP/stat plumbing and diagnostics. The source gate passed, and the exact merged commit later compiled into a development APK.

Mission 0 is historical context. Do not re-run it as a new broad patch mission.

## Mission 0Q — Physical qualification — FAILED

The exact Mission 0 merge commit compiled into an Android APK, but two-phone physical behavior failed. Observed failures included:

- freezes/responsiveness problems;
- slower partner discovery;
- control failure after availability claimed the peer was available;
- unreliable reconnect/recovery;
- unreliable notification permission prompting and process-dependent incoming requests;
- MediaProjection capture startup without an actual first rendered remote frame;
- repeatable failure around the 15-second initial-video deadline;
- duplicate Viewer/keep-awake ownership signals;
- nonfunctional PiP;
- generally unreliable session lifecycle.

**Exit result:** FAIL. There is no known-good WebRTC fallback baseline yet.

Mission 1 remains blocked.

## Mission 0R — Runtime Laboratory

**Branch:** `m0r/runtime-laboratory`

**Goal:** make 90–95% of PartnerScreen qualification software-first so P0 repairs can be reproduced before another APK/two-phone cycle.

Infrastructure only. Do not repair P0-A through P0-H during 0R.

Implement:

- two-peer software twin around the real production PairingService / AvailabilityService / ControlSession / SessionController / ScreenCaptureCoordinator / MediaSessionController;
- deterministic virtual clock/scheduler;
- deterministic virtual LAN with latency, jitter, loss, bandwidth, outage and stale-route controls;
- simulated platform ports for discovery, pairing/control sockets, notification, capture consent and media events;
- runtime ownership invariants;
- seeded model/lifecycle/fault fuzzing with replayable seeds;
- known physical failures as quarantined desired-behavior regression scenarios;
- native JVM/Robolectric seams that are consumed by production Kotlin rather than duplicate test-only models;
- synthetic-frame Jitsi WebRTC loopback instrumentation using the exact repository dependency;
- manual-only native/emulator runners;
- explicit proof-level documentation.

**Fast source gate:**

- `npm ci`
- `npm run test:runtime-lab`
- `npm run test:runtime-lab:fuzz`
- `npm run typecheck`
- existing source tests/contracts as appropriate

**Do not run during 0R construction:**

- Expo prebuild;
- Gradle/native tests;
- APK build;
- Maestro;
- emulator qualification;
- physical qualification.

Native/emulator files may be added as manual-only infrastructure but are not executed until the lab source is reviewed.

**Exit:** reviewed Runtime Laboratory with a green Node/twin/fuzz lane; physical Mission 0Q failures remain encoded as desired-behavior regressions rather than normalized as expected behavior.

## Mission 0P — P0 runtime repair

Run only after Mission 0R is reviewed.

Implement the combined audit findings sequentially, proving each in the Runtime Laboratory before moving on:

1. P0-A discovery / availability / control truth;
2. P0-B sanitized pre-LIVE WebRTC observability;
3. P0-C phase-correct media timing and bounded directional recovery;
4. P0-D Android background trusted-listener lifecycle;
5. P0-E notification/permission correctness;
6. P0-F Viewer/PiP/keep-awake ownership;
7. P0-G responsiveness/queue/diagnostics cleanup;
8. P0-H verification repair.

Do not build an APK after every section. Source/twin/native-test evidence is the normal loop.

**Exit:** P0 desired-behavior regressions are green at the appropriate software/native levels and the repair PR is reviewed.

## Mission 0Q2 — One frozen physical requalification

Only after Mission 0R and Mission 0P are reviewed.

Build one frozen APK and first prove repeatedly:

`partner reachable → request → accept → MediaProjection consent → actual first rendered frame`

Only after that basic path is stable expand to:

- background incoming request;
- rotation;
- PiP;
- weak-link degradation and bounded reconnect;
- Retry without force-stop;
- Stop → immediate new session;
- truthful media telemetry.

**Exit:** known-good WebRTC fallback baseline.

## Mission 1 — V2 state + GUI foundation

**Branch:** `v2/state-gui-foundation`

Build only the shared product-state seam needed by future work:
- canonical sanitized `SessionPresentationState`
- route / engine / health / direct-relay / media / recovery presentation fields
- Simple / Advanced interface mode
- overlay priority manager
- theme-token engine
- Signal Glass baseline tokens/components
- existing screens consume the canonical state where practical

No full redesign and no remaining seven Theme Packs yet.

**Exit:** one state model can truthfully represent current WebRTC plus future Wi-Fi Direct/Local Fast Path/WAN states.

## Mission 2 — Wi-Fi Direct reachability

**Branch:** `v2/wifi-direct`

**Goal:** routerless Android-to-Android connectivity without changing the media engine yet.

Implement:
- `WifiP2pManager` coordinator
- Android 13+ nearby-device permission flow
- discovery/group owner/client lifecycle
- BUSY retry, cancellation, teardown
- Android `Network` binding where required
- authenticated PartnerScreen control/session over P2P
- route presentation and Advanced override
- LAN <-> Wi-Fi Direct lifecycle/recovery

**Critical rule:** use the existing WebRTC media path first. Wi-Fi Direct is connectivity, not a new trust or video protocol.

**Exit:** two Android devices/vendors can request/share/view without a router using existing WebRTC and existing trust.

## Mission 3 — Local Fast Path

**Branch:** `v2/local-fast-path`

Create one native local media engine for both Wi-Fi Direct and ordinary LAN:

`MediaProjection -> VirtualDisplay -> MediaCodec H.264 Surface encoder -> RTP/RTCP -> SRTP/SRTCP -> UDP -> bounded deadline-aware receiver -> MediaCodec decoder -> SurfaceView`

Requirements:
- H.264 Baseline/Constrained Baseline
- standard authenticated SRTP keying; prefer DTLS-SRTP; no custom crypto
- no B-frames
- hardware codec and low-latency hints where supported
- zero/near-zero stale-frame backlog
- bounded reorder/retransmission deadline
- PLI/IDR recovery
- sanitized telemetry including backlog and measured/confidence-labelled frame age
- existing WebRTC remains local compatibility fallback

A/B Local Fast Path and WebRTC on the same devices/network.

**Exit:** promote Local Fast Path to preferred local media only if physical evidence shows materially better freshness/latency without worse reliability.

## Mission 4 — Browser + signaling

**Branch:** `v2/browser-signaling`

Implement:
- authenticated PartnerScreen signaling/API
- WebSocket WebRTC signaling
- browser viewer
- temporary browser-session authorization by default
- H.264 preference, VP8 fallback
- STUN/direct connectivity
- Simple/Advanced browser presentation using the same semantic state model

Local LAN/Wi-Fi Direct must remain functional with the backend unavailable.

## Mission 5 — Internet app-to-app + TURN fallback

**Branch:** `v2/internet-webrtc`

Implement:
- Internet WebRTC reachability
- direct ICE/UDP first
- STUN-assisted direct path
- TURN only when direct Internet connectivity fails
- explicit `Internet • Direct` vs `Internet • Relay` product state
- backend/TURN health telemetry and regional-ready deployment model

No SFU for normal 1:1 PartnerScreen.

## Mission 6 — Full GUI + Theme Packs

**Branch:** `v2/gui-theme-packs`

Complete the V2 GUI blueprint:
- Home
- Pair Partner
- Incoming Request
- Sharing
- Viewer
- Connection
- Settings
- Diagnostics
- overlays, sheets, PiP controls, zoom/pan
- Simple + Advanced presentation
- all eight first-party Theme Packs
- low-GPU / reduced-motion / Viewer / PiP variants

Theme order:
1. Signal Glass
2. Carbon Relay
3. Aurora Link
4. Prism HUD
5. Frosted Circuit
6. Redline Broadcast
7. Monochrome Flux
8. Spectral Connect

Visual effects must never cost frame freshness.

## Mission 7 — Evidence-led optimization

Only after the prior missions are physically characterized:
- FEC experiments if loss/retransmission evidence justifies them
- codec/device-specific tuning
- thermal adaptation
- Wi-Fi lock A/B
- future Wi-Fi Aware / cross-platform nearby research

Do not add complexity without measured benefit.

## Mission completion report

Every Arena mission ends with:
- files changed
- source-proven behavior
- prebuild-proven behavior
- native/physical behavior still unproven
- tests added/changed
- security/privacy impact
- known risks
- exact next mission entry gate

Arena stops after the mission and opens a PR for review. It does not continue into the next mission automatically.
