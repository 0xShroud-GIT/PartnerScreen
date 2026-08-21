# PartnerScreen Checkpoint

**Updated:** 2026-08-21  
**Phase:** Mission 0 — Stabilize current PartnerScreen  
**Working branch:** `arena/01a02594-partnerscreen` (session-fixed; requested `v2/gate0-stabilization` cannot be created in this Arena session)  
**Base:** `5e6f70a5fe874525e6f7a6dbd24fc08b591fa859` (`main`)

## Current truth

Mission 0 source work is complete on the session branch. The existing WebRTC fallback is now deterministic and truthful at the source/prebuild layer:

- native `getStats(RTCStatsCollectorCallback)` one-arg API
- absolute initial usable-video deadline (15s)
- unconditional per-reconnect-attempt timeout (8s, plus existing 5s frame grace)
- coordinated Error recovery across session/media/capture/notifications/PiP/keep-awake
- Stop → immediate Start capture queue (JS coordinator + native service)
- incoming-request permission, exact deep routing, generation-safe notifier
- PiP uses actual remote geometry and exits on session end
- sanitized production media stats plumbed into controller/presentation
- truthful `setParameters` / degraded / keep-awake reporting

## Source gate (this commit)

- `npm ci`: PASS (649 packages)
- `npm run typecheck`: PASS
- `npm run test:product`: PASS (166/166)
- `npm run check:contracts`: PASS (13/13)
- `npm run check:baseline`: PASS
- `npm run sanitize`: PASS
- `npm run config:check`: PASS
- `npm run deps:check`: PASS
- `CI=1 npx expo prebuild --platform android --no-install`: PASS (`supportsPictureInPicture="true"`)

Native compile and physical behavior remain unproven.

## Next work

1. Review Mission 0 PR. Do not merge unless authorized.
2. Do **not** start Mission 0Q (APK / Maestro / physical) until this PR is reviewed.

## High-risk invariants

- LIVE requires the current renderer/session/track epoch's actual first frame.
- Pairing survives Error recovery.
- No secrets, raw SDP, or full IPs in ordinary diagnostics/notifications.
- Native compile and physical behavior remain unproven until Mission 0Q.
