# PartnerScreen V2 — Agent Implementation Roadmap

**Rule:** finish each gate before opening the next. Do not build everything in parallel.

## Gate 0 — Stabilize current main

Fix first:
- native WebRTC `getStats` API compile issue
- initial media deadline
- per-reconnect-attempt deadline
- coordinated Error recovery
- Stop -> immediate Start capture race
- notification permission + deep route + async serialization
- PiP geometry/lifecycle
- real media stats plumbing
- truthful bitrate/setParameters handling
- keep-awake result handling
- real degraded/reconnecting semantics
- stronger production-path tests

Run lightweight source + prebuild gates.
Then perform **one explicit manual native qualification**.

**Done when:** current architecture is deterministic enough to serve as fallback.

## Gate 1 — V2 state + GUI foundation

- canonical `SessionPresentationState`
- Simple / Advanced interface mode
- semantic route/media/security tokens
- V2 screen shell
- overlay priority manager
- theme-token engine
- Signal Glass baseline theme
- sanitized telemetry model

No transport rewrite yet.

## Gate 2 — Wi-Fi Direct connectivity

Build network reachability first while retaining WebRTC media:
- `WifiP2pManager`
- permissions
- group/client lifecycle
- Android `Network` binding
- authenticated PartnerScreen discovery/control
- teardown/rejoin
- route-state GUI
- Advanced route override

**Reason:** isolate P2P networking bugs from a new media engine.

## Gate 3 — Local Fast Path

Implement one LocalFastMedia engine used by **both Wi-Fi Direct and LAN**:
- MediaProjection -> encoder Surface
- H.264 hardware codec
- RTP/RTCP over UDP with SRTP/SRTCP
- standards-based keying (prefer DTLS-SRTP; no custom crypto)
- bounded deadline-aware recovery
- decoder -> SurfaceView
- zero-backlog/freshness enforcement
- measured frame-age/clock-correlation telemetry
- telemetry
- WebRTC local fallback

A/B against WebRTC on the same phones.

Promote Local Fast Path as default local media only after it wins on latency/freshness/reliability. Do not require seamless hot-switching between Local Fast Path and WebRTC in this gate.

## Gate 4 — Browser + signaling backend

- authenticated signaling/API
- WebSocket session signaling
- browser temporary-session authorization
- WebRTC H.264 preference + VP8 fallback
- STUN
- browser Simple/Advanced presentation

Local operation remains server-independent.

## Gate 5 — Internet app-to-app + TURN

- Internet reachability
- direct ICE first
- STUN-assisted direct
- TURN relay fallback
- relay disclosure
- backend health/monitoring
- regional TURN-ready deployment model

No SFU for normal 1:1.

## Gate 6 — Product polish

- all eight Theme Packs
- low-GPU/reduced-motion variants
- zoom/pan
- final rotation matrix
- connection/quality sheets
- advanced live HUD
- scoped Wi-Fi-lock experiment
- refined adaptation profiles
- physical latency/reliability matrix

## Gate 7 — Evidence-led optimization

Only from measured physical data:
- FEC experiments
- codec-specific tuning
- device capability profiles
- thermal adaptation
- future Wi-Fi Aware / cross-platform nearby options

## V2 completion criteria

- current bugs resolved
- Wi-Fi Direct works
- LAN + Wi-Fi Direct share Local Fast Path
- WebRTC retained and reliable
- browser works
- Internet direct works
- TURN fallback works
- local works with backend offline
- freshest-frame invariant demonstrated
- Simple/Advanced UI complete
- 8 Theme Packs complete
- sanitized diagnostics explain route/media/recovery
- security/view-only invariants preserved
