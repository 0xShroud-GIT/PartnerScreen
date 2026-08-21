# PartnerScreen V2 Roadmap

**Purpose:** one execution plan. Detailed evidence stays in `STABILIZATION_REPORT.md` and the ZeroLink teardown.

**Order is mandatory:** fix current app → Wi-Fi Direct → native local fast path → browser → Internet.

## Target architecture

One PartnerScreen trust/session layer, multiple network/media paths:

| Mode | Network | Media | Default |
|---|---|---|---|
| Android ↔ Android, Wi-Fi Direct | `WifiP2pManager` | **Local Fast Path: H.264 + SRTP/RTP/UDP** | Best nearby path |
| Android ↔ Android, same LAN | authenticated LAN discovery | **Local Fast Path: H.264 + SRTP/RTP/UDP** | Best LAN path |
| Any native local fallback | LAN/P2P | existing **WebRTC** | Compatibility fallback |
| Native ↔ browser | LAN or Internet | **WebRTC** | Required browser path |
| Native ↔ native over Internet | Internet | **WebRTC ICE/STUN, TURN fallback** | Best WAN 1:1 path |

Do not force one transport to solve every environment.

## Product/security rules

- Keep the explicitly trusted PartnerScreen identity, request/accept flow, session IDs, stale/replay guards, and mandatory MediaProjection consent.
- Local Android sessions should remain fully local with no server dependency.
- Local Fast Path media must be encrypted with **standard SRTP and standard authenticated session keying**; do not invent crypto primitives or send raw RTP.
- WAN/browser media uses WebRTC encryption. Direct ICE is preferred; TURN is used only when direct Internet connectivity fails.
- No remote control, audio, hidden recording, anonymous room-code trust, secret logging, or screen-content telemetry.
- Mode-specific ICE policy: local mode remains private/local only; WAN mode may explicitly use `srflx`/`relay` candidates.
- APK + Maestro stays manual; ordinary work runs the source gate only.

---

# V2.0 — Correctness first

**Goal:** current app compiles natively, never requires force-stop, never waits forever, and diagnostics are truthful.

Fix before adding a new network/media path:

1. Correct WebRTC `getStats(callback)` native API usage and verify all new Kotlin/Java modules compile.
2. Add absolute initial-negotiation and per-reconnect-attempt deadlines; three bounded attempts, then clean Retry/Request-again.
3. Make Error recovery one coordinated reset of control + pending + session + media + capture + renderer + notification while preserving the trusted pair.
4. Fix Stop → immediate new capture so a new request cannot be silently dropped while the old service is stopping.
5. Complete incoming notification permission, notification-tap routing, and async generation/serialization safety.
6. Finish PiP using real video geometry and clean PiP termination.
7. Wire sanitized production media stats: bitrate, loss, RTT, jitter, FPS, encoded/decoded/dropped frames, NACK/RTX/PLI/FIR, codec and candidate type where supported.
8. Remove false claims: unused start bitrate, unreachable degraded state, keep-awake success when native enable failed.
9. Measure frame age/backpressure. **Freshness beats completeness.** Never allow obsolete screen history to build into seconds of lag.

### V2.0 gate

One manual qualification only after source review:

- native APK build green
- Maestro green
- two phones prove notification → consent → first frame → PiP/rotation → degraded/reconnect → Retry without force-stop → Stop → immediate new session
- capture poor-Wi-Fi stats and confirm actual NACK/RTX/FEC negotiation

Do **not** enable FEC yet. Measure first.

---

# V2.1 — Wi-Fi Direct connectivity

**Goal:** Android phones connect without a router, while the existing PartnerScreen trust/session model remains unchanged.

Wi-Fi Direct is a network path, not a video protocol and not a new pairing method.

Implement:

1. Native `WifiP2pManager` coordinator with Android 13+ `NEARBY_WIFI_DEVICES` runtime permission.
2. Peer/service discovery, group owner/client creation, BUSY retry, cancellation and teardown.
3. Produce a normal `NetworkEndpoint` from the P2P connection and bind PartnerScreen sockets/network operations to that Android network where required.
4. Run existing authenticated PartnerScreen control/session logic over P2P.
5. **Use current WebRTC first** over the P2P network to prove the connectivity layer independently.
6. Clean transitions: LAN → Direct, Direct → LAN, temporary Direct loss, reconnect, Stop → immediate new Direct session.

### V2.1 gate

Two Android devices/vendors pass with no router and without weakening trust/security.

---

# V2.2 — Native Local Fast Path

**Goal:** best possible Android↔Android latency on both Wi-Fi Direct and ordinary LAN.

Use one engine for both network types:

`MediaProjection → VirtualDisplay → MediaCodec H.264 surface encoder → SRTP/RTP/UDP → deadline-aware receiver → MediaCodec decoder → SurfaceView`

### Codec/capture policy

- H.264 AVC Baseline/Constrained Baseline, 8-bit 4:2:0.
- Encoder input Surface directly from MediaProjection VirtualDisplay; no Bitmap/ImageReader/CPU copy path.
- No B-frames.
- Request realtime encoder priority and zero/low encoder latency where supported; verify actual output format because vendors may ignore optional hints.
- Decoder uses Android low-latency mode when the codec advertises support.
- Render decoded output directly to a Surface/SurfaceView.

### Freshness policy

The KPI is **frame age/backlog**, not resolution or nominal FPS.

Start capability-driven, e.g.:

`720p60 → 540p60 → 480p60 → 720p30 → 480p30 → 360p30`

but immediately reduce/drop if 60 fps creates backlog. A fresh 30-fps frame is better than stale 60-fps frames.

Rules:

- zero intentional video queue
- tiny packet reorder window only
- deadline-aware NACK: retransmit only when the packet can arrive before the frame deadline
- otherwise drop the incomplete frame and move on
- PLI/IDR recovery for reference loss
- no FEC until measurements prove it improves latency/reliability
- no raw unencrypted RTP

### Local latency KPI

Engineering targets, not guarantees:

- `<35 ms` exceptional
- `35–50 ms` excellent
- `50–70 ms` acceptable
- `70–100 ms` adapt/investigate
- `>100 ms` unacceptable on a healthy local path

Measure source-frame/capture timestamp to rendered-frame age where technically possible.

### V2.2 gate

A/B Local Fast Path vs WebRTC on the same phones and network. Promote Fast Path to local default only if it materially improves latency/variance/recovery. Keep WebRTC local fallback for unsupported/broken OEM codecs.

---

# V2.3 — Browser path

**Goal:** a browser can securely view a PartnerScreen session without native raw-socket access.

Use WebRTC; normal web pages cannot rely on arbitrary raw UDP/TCP sockets.

Implement:

1. HTTPS web client + WSS signaling.
2. WebRTC receive/view path; H.264 Constrained Baseline preferred, VP8 fallback.
3. Explicit secure trust bootstrap tied to the PartnerScreen session/identity; no anonymous reusable room code.
4. Browser viewer keeps the same request/accept semantics and never bypasses MediaProjection consent on the sharing phone.
5. Prefer direct WebRTC media whenever ICE can establish it.

Do not create a custom RTP-over-WebSocket/WebTransport video transport for the browser.

---

# V2.4 — Internet ↔ Internet

**Goal:** trusted partners can connect reliably across different networks, carrier NAT and firewalls.

Use WebRTC for the WAN path:

`PartnerScreen signaling (WSS) → ICE → direct UDP P2P when possible → STUN discovery → TURN relay only when required`

Implement:

1. Authenticated presence/signaling service; signaling carries session metadata/SDP/ICE, not screen content.
2. Owned STUN/TURN infrastructure (for example coturn) with short-lived credentials.
3. Direct P2P preferred for every 1:1 session; TURN is fallback.
4. No SFU for normal 1:1 PartnerScreen. Add an SFU only if one-to-many becomes a real product requirement.
5. WAN candidate policy is explicit and separate from local private-host policy.
6. Clearly communicate when a session is `Local direct`, `Internet direct`, or `Relayed`.
7. Keep media end-to-end encrypted by WebRTC even when TURN relays packets.

### V2.4 gate

Test home↔home, Wi-Fi↔5G, symmetric-NAT/TURN, network handoff, reconnect, and browser↔native. Direct and relayed sessions must preserve the same trusted request/accept model.

---

# V2.5 — Experience and evidence-led optimization

After the four transport modes are proven:

- viewer pinch zoom/pan + Fit/reset
- rotation resilience across all modes
- Low latency / Balanced / Sharper text profiles only if field data justifies them
- scoped Wi-Fi lock A/B test; keep only if real devices improve
- inspect NACK/RTX/FEC and jitter-buffer measurements before adding redundancy
- prepare Android 17/SDK 37 local-network permission flow before raising target SDK

---

# Explicitly reject

- ZeroLink-style JPEG/raw-TCP as primary media
- cleartext RTP/media
- PIN-only durable trust
- permanent/global wake locks or `largeHeap` as fixes
- AccessibilityService remote control
- custom UDP across the public Internet
- RTP tunneled through WebSocket for browser video
- mandatory HEVC/AV1 for low-end compatibility
- TURN/SFU in local sessions
- SFU in normal 1:1 WAN sessions

---

# Agent rule

**One milestone at a time.** Do not build V2.2 while debugging V2.1, and do not add WAN/browser infrastructure while current Android correctness is unresolved.

For each milestone: confirm requirement → smallest coherent implementation → behavior/native tests → source gate → manual APK only at that milestone's explicit qualification gate → update this file only with proven results.
