# ZeroLink 2.1 — PartnerScreen Harvest Evidence

**Purpose:** condensed repository evidence from the full reverse-engineering report. The archival handoff ZIP contains the complete report. This file is evidence only; `../V2_ARCHITECTURE_BLUEPRINT.md` is product authority.

## Confirmed ZeroLink architecture

Inspected artifact: ZeroLink 2.1 (`com.helium4.localscreenshare`, versionCode 7, minSdk 26, target/compile SDK 36).

Recovered primary path:

```text
MediaProjection -> VirtualDisplay -> ImageReader -> Bitmap -> JPEG
 -> bounded queue -> raw TCP :5000 -> Bitmap decode -> viewer
```

Confirmed behaviors:
- longest capture edge approximately 1280 px
- selectable FPS 10/15/24/30/45/60; service default around 20
- JPEG quality around 60
- six-byte PIN authentication
- four-byte big-endian frame length followed by JPEG bytes
- no application-layer encryption recovered around the media/control socket
- no WebRTC PeerConnection/ICE/DTLS/SRTP implementation found in the inspected media path

## Highest-value finding: freshness over completeness

ZeroLink uses **two independent stale-frame defenses**:

1. `ImageReader.acquireLatestImage()` drops superseded capture buffers.
2. `ArrayBlockingQueue` capacity 3; when full, it removes the oldest queued frame and inserts the newest.

This is the most important behavior to harvest:

> The screen the viewer sees now is more valuable than perfectly delivering obsolete frames.

PartnerScreen V2 therefore makes displayed-frame age/backlog a first-class KPI and requires bounded queues/drop-obsolete behavior even though its transport is different.

## Connectivity/lifecycle findings

Confirmed ZeroLink capabilities worth harvesting as product lessons:
- Android NSD/mDNS (`_localscreenshare._tcp.`)
- substantial Wi-Fi Direct path using Android P2P APIs
- Android `Network`-bound sockets for P2P
- BUSY retry/fallback handling
- routerless operation
- foreground sender and receiver services
- scoped session Wi-Fi/power lifetime handling
- explicit connection-lost / Try again UX
- rotation resilience
- viewer pinch zoom/pan
- user-adjustable frame-rate behavior

## Security/privacy findings to reject

Confirmed or high-confidence issues PartnerScreen must not copy:
- raw cleartext TCP screen transport
- six-digit PIN as the trust root
- PIN values in log strings
- IP + PIN + FPS in sharing notification text
- `usesCleartextTraffic=true`
- AccessibilityService remote control / gesture injection
- broad Firebase/analytics footprint without a PartnerScreen requirement
- `largeHeap=true` as a memory strategy

## PartnerScreen harvest decisions

### Adopt / improve
- freshness-first queues and frame-age telemetry
- Wi-Fi Direct as reachability under existing trusted pairing
- explicit failure/reconnect states
- zoom/pan
- rotation as an acceptance invariant
- scoped network-lifetime testing
- understandable performance profiles

### Keep from PartnerScreen
- persistent cryptographic trusted partner
- request/accept + MediaProjection consent
- session ownership and stale/replay guards
- encrypted media
- view-only boundary
- sanitized diagnostics

### Reject
- JPEG/raw-TCP primary media
- cleartext media/control
- PIN trust
- secret-bearing logs/notifications
- remote control
- cloud telemetry dependency

## Strategic conclusion

ZeroLink demonstrates that Android-native pragmatism and ruthless stale-frame dropping can make a simple local mirroring product feel immediate. PartnerScreen V2 should combine that **freshness discipline and routerless connectivity** with PartnerScreen's stronger trust, encryption, consent and view-only model.
