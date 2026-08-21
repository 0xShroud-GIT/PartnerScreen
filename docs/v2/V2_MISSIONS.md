# PartnerScreen V2 — Arena Mission Sequence

**Status:** locked execution sequence.

Arena works one mission at a time. A mission may prepare evidence for the next mission, but it must not implement future missions early.

## Global rules

- Read `AGENT_HANDOFF.md`, `V2_ARCHITECTURE_BLUEPRINT.md`, `V2_INTEGRATION_CONTRACT.md`, and `V2_IMPLEMENTATION_ROADMAP.md` before changing code.
- Preserve trusted pairing, explicit request/accept, MediaProjection consent, view-only behavior, encryption, stale/replay guards, and sanitized diagnostics.
- No APK build, Maestro dispatch, or heavy native qualification unless the mission explicitly says to run the manual qualification gate.
- Never weaken security to match ZeroLink. Harvest its freshness, lifecycle, Wi-Fi Direct, rotation, reconnect, and viewer lessons only.
- Never treat generated visual boards as functional requirements.
- Do not merge a mission PR unless explicitly authorized.

## Mission 0 — Stabilize current PartnerScreen

**Branch:** `v2/gate0-stabilization`

**Goal:** make the existing WebRTC implementation deterministic and trustworthy enough to remain the V2 fallback.

Implement only:
- correct native WebRTC `getStats` API usage and verify new native-module source compatibility
- absolute initial usable-video deadline
- unconditional timeout for every reconnect attempt
- one coordinated Error recovery path
- Stop -> immediate Start capture race fix
- notification permission + exact incoming-request routing + async generation/serialization safety
- PiP real video geometry and terminal cleanup
- real sanitized media-stats plumbing
- truthful bitrate / `setParameters` / degraded / keep-awake reporting
- production-path behavioral tests for the above

**Source gate:**
- `npm ci`
- `npm run typecheck`
- `npm run test:product`
- `npm run check:contracts`
- `npm run check:baseline`
- `npm run sanitize`
- `npm run config:check`
- `npm run deps:check`
- `CI=1 npx expo prebuild --platform android --no-install`

**Do not run:** APK build, Maestro, Wi-Fi Direct work, Local Fast Path work, browser/backend work, theme redesign.

**Exit:** reviewed source/prebuild-green PR, with native compile still honestly labelled unproven until manual qualification.

## Mission 0Q — One manual physical qualification

Run only after Mission 0 is reviewed.

Prove on physical devices:
- native build succeeds
- notification -> request -> consent -> first rendered frame
- rotation
- PiP
- weak-link degradation and bounded reconnect
- Retry without force-stop
- Stop -> immediate new session
- useful media telemetry

Capture evidence about actual NACK/RTX/FEC negotiation. Do not enable FEC merely because it is available.

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
