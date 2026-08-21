# PartnerScreen V2 — Final Architecture Blueprint

## 1. Product contract

PartnerScreen V2 is one trusted-session product with multiple connection/media paths.

**Keep**
- Persistent cryptographic trusted-partner identity.
- Explicit request -> accept -> OS screen-capture consent.
- View-only remote screen.
- Session ownership, fresh session IDs, replay/stale guards.
- Sanitized diagnostics.
- Pairing survives media/network failure.
- No secret-bearing logs or notifications.

**Never inherit from ZeroLink**
- Raw JPEG/TCP as the primary media path.
- Six-digit PIN as durable trust.
- Cleartext screen/control transport.
- PIN, token, full endpoint/IP, or durable secret in logs/notifications.
- AccessibilityService remote control.
- `largeHeap=true` as a performance strategy.
- Broad telemetry/cloud SDKs without a product requirement.

## 2. Core architecture

```text
                   PARTNERSCREEN TRUST + SESSION CORE
 identity / pairing / request / consent / authorization / session ownership
                               |
                        ConnectionPolicy
               _____________/   \_____________
              /                                 \
         LOCAL / NEARBY                       INTERNET / WEB
        LAN or Wi-Fi Direct                       WebRTC
              |                            ICE -> STUN -> TURN fallback
       LocalFastMedia                              |
     H.264 + SRTP/RTP/UDP                    H.264 / VP8 fallback
              \                                 /
               \____________ Viewer __________/
```

WebRTC is retained as a first-class engine. It is not removed.

## 3. Connection modes

### 3.1 Wi-Fi Direct — native local fast path

**Connectivity:** Android `WifiP2pManager` creates the IP network.  
**Trust:** existing PartnerScreen authenticated pair; Wi-Fi Direct is reachability only.  
**Media:** Local Fast Path preferred; WebRTC is compatibility fallback.  
**Server dependency:** none.

Target pipeline:

```text
MediaProjection
 -> VirtualDisplay
 -> MediaCodec H.264 encoder input Surface
 -> encoded frames
 -> RFC 6184 RTP + RTCP feedback
 -> standards-based SRTP/SRTCP keying (prefer DTLS-SRTP)
 -> UDP bound to Wi-Fi Direct Network
 -> tiny deadline-aware reorder/recovery window
 -> MediaCodec H.264 decoder
 -> SurfaceView
```

Required behavior:
- Android 13+ nearby-device permission handling.
- Group owner/client lifecycle.
- Bind sockets/discovery to the selected Android `Network`.
- BUSY/retry handling.
- Router <-> P2P teardown/rejoin recovery.
- Clear warning when Wi-Fi Direct temporarily affects Internet access.
- No new PIN trust path.

### 3.2 Same Wi-Fi LAN — same native fast media engine

LAN and Wi-Fi Direct do **not** get separate video protocols.

```text
LAN discovery/reachability -> LocalFastMedia -> H.264/SRTP/RTP/UDP
Wi-Fi Direct reachability -> LocalFastMedia -> H.264/SRTP/RTP/UDP
```

Only network acquisition/discovery differs.

Use authenticated PartnerScreen discovery. NSD/mDNS may assist reachability, but does not replace trust.

### 3.3 Browser

Browser clients use WebRTC.

```text
Native sender -> WebRTC -> browser RTCPeerConnection -> browser video
```

Policy:
- H.264 Constrained Baseline preferred.
- VP8 fallback for interoperability.
- Signaling service required.
- ICE/STUN for direct connectivity.
- TURN only when direct connectivity fails.
- Browser session authorization is temporary by default; do not silently create a permanent trusted partner.

### 3.4 Internet app-to-app

Use WebRTC:

```text
direct ICE/UDP first
 -> STUN-assisted direct route
 -> TURN relay only if direct cannot be established
```

No SFU in the normal 1:1 path.
An SFU is future scope only if PartnerScreen becomes one-to-many.

## 4. Backend boundary

Local LAN and Wi-Fi Direct must continue working if PartnerScreen servers are unavailable.

Internet/browser infrastructure:

```text
PartnerScreen backend
- authenticated signaling/API
- WebSocket signaling
- STUN
- TURN (coturn or equivalent)
- monitoring / health
```

TURN is a fallback insurance path, not the default media path.
Regional TURN nodes can be added as usage grows.

## 5. Automatic route policy

Do not encode a simplistic permanent `Wi-Fi Direct > LAN > Internet` rule.

`ConnectionPolicy` scores viable routes in two phases. Before media starts it uses reachability, probe RTT, device capability and route cost. During a live session it may incorporate observed media health. Inputs include:
- reachability
- estimated/observed frame age
- RTT/loss/jitter
- stability
- device capability
- whether Wi-Fi Direct would disrupt Internet
- user Advanced-mode preference

Default intent:
1. Prefer a healthy direct **local fast path**.
2. Choose LAN or Wi-Fi Direct according to measured quality/cost.
3. Use Internet WebRTC direct when local is unavailable.
4. Use TURN relay only when direct Internet connectivity fails.

Advanced mode may force a route. Forced routes fail rather than silently violating the selected policy.

V2 does **not** promise seamless hot handoff between `LocalFastMedia` and WebRTC. Automatic cross-engine changes occur at session establishment or after a bounded hard-failure recovery path until physical testing proves a safe hot-switch design.

## 6. Freshness-first media invariant

The strongest ZeroLink lesson is architectural:

> **Newest useful frame wins.**

Adopt the behavior, not ZeroLink's JPEG/TCP transport.

Every stage must avoid stale work:
- capture
- encoder input
- packet/recovery queue
- decoder
- renderer

Targets:
- normal encoder/capture backlog: 0–1 frame
- bounded packet reorder/recovery
- obsolete frames are dropped
- never accumulate seconds of screen history

Primary runtime KPI: **age of the frame currently displayed**, not nominal FPS.

Cross-device frame age must be measured rather than guessed. Establish a monotonic clock offset estimate over the authenticated control/RTCP path (bounded ping-pong samples), carry sender capture timestamps, and report a confidence/availability flag. If clock correlation is unavailable, expose local pipeline age components instead of presenting a false end-to-end number.

## 7. Native Local Fast Path codec policy

Baseline:
- H.264 AVC Baseline / Constrained Baseline
- 8-bit 4:2:0
- Surface input
- hardware codec when available
- no B-frames
- real-time priority where supported
- request zero/low codec latency where supported
- inspect actual codec output/capability; vendor support is not assumed
- GOP / IDR interval approximately 1–2 seconds
- PLI / IDR recovery
- RTP/RTCP with SRTP/SRTCP protection
- standards-based SRTP key establishment tied to the authenticated PartnerScreen session; prefer DTLS-SRTP and do not invent custom cryptography
- RTP 90 kHz video clock
- MTU-safe payload sizing / FU-A fragmentation

Do not make HEVC or AV1 mandatory in V2.

## 8. Frame-rate / resolution adaptation

60 fps is preferred **only when it remains fresh**.

Illustrative adaptation ladder:

```text
720p60
 -> 540p60
 -> 480p60
 -> fresh 720p30 / 480p30
 -> 360p30
```

The controller can choose a different fresh 30 fps step when that is better for the hardware.

Never keep 60 fps while encoder or renderer queues grow.

Quality profiles:
- Adaptive (default)
- Low Latency
- High Motion
- High Clarity

All profiles obey the stale-frame invariant.

## 9. Packet-loss policy

Do not use an unbounded conventional jitter buffer.
Do not blindly disable retransmission either.

Use **deadline-aware recovery**:

```text
missing packet
 -> can recovery arrive before frame deadline?
      yes -> bounded NACK/retransmit
      no  -> drop obsolete frame and continue
```

FEC is not a V2 default.
Measure real NACK/RTX/loss/frame-age behavior first; experiment with FEC only if physical telemetry justifies it.

## 10. Latency targets

Do not market a universal 20 ms claim.

Local design bands:
- `<35 ms` exceptional
- `35–50 ms` excellent
- `50–70 ms` acceptable
- `70–100 ms` adapt/investigate
- `>100 ms` unhealthy on a healthy local link

Internet adds WAN delay/jitter; consistency and freshness take priority over matching local latency.

## 11. Required telemetry

Expose sanitized structured state to product UI and diagnostics:

**Route**
- Wi-Fi Direct / LAN / Internet / Relay
- Direct vs Relay
- media engine: Local Fast Path / WebRTC

**Media**
- codec
- resolution
- target/actual encode FPS
- decode/render FPS
- bitrate
- frame age
- capture/encoder backlog
- dropped frames
- first-frame time

**Network/recovery**
- RTT
- jitter
- packet loss
- NACK
- retransmitted/recovered packets/bytes where available
- PLI/FIR where available
- reconnect count
- route changes

Never store:
- raw SDP
- pairing/session secrets
- full IP addresses
- private ICE candidate addresses
- durable identifiers unless explicitly required and sanitized.

## 12. Deterministic recovery

Required before expansion:
- initial negotiation/useful-video deadline
- unconditional timeout for every reconnect attempt
- generation/session guards on all async work
- one coordinated Error recovery path across session/media/capture/notification/viewer
- availability updates must not silently clear Error
- fresh session IDs on new sessions
- Stop -> immediate new Start must not be lost
- route fallback must be bounded and visible to the GUI

## 13. Android lifecycle

- Sender capture remains foreground-service based.
- Receiver foreground service is added only if physical testing proves a lifecycle benefit.
- Viewer uses scoped keep-screen-on behavior.
- Scoped Wi-Fi lock is an A/B-tested optimization, not automatic doctrine.
- Rotation must not tear down an otherwise healthy session.
- PiP must use actual video geometry and leave cleanly when the session ends.
- Notifications request permission at an appropriate product stage and deep-link to the exact incoming request.

## 14. Security invariants

- Explicit trusted pairing.
- Explicit per-session request/accept.
- OS MediaProjection consent.
- View-only.
- Encrypted media.
- No secret in logs/notifications.
- No full IP in ordinary diagnostics.
- No AccessibilityService remote control.
- TURN cannot weaken app-level trust.
- Local mode does not require cloud.
- Browser/WAN mode is explicitly Internet-capable and may use relay.
