# PartnerScreen Checkpoint

**Updated:** 2026-08-21  
**Phase:** Mission 0 correction pass — Stabilize current PartnerScreen  
**Working branch:** `arena/01a02594-partnerscreen` (session-fixed; requested `v2/gate0-stabilization` cannot be created in this Arena session)  
**Base:** `5e6f70a5fe874525e6f7a6dbd24fc08b591fa859` (`main`)

## Current truth

Mission 0 source work plus the five merge-blocker corrections are complete on the session branch. The existing WebRTC fallback is deterministic and truthful at the source/prebuild layer:

- native `getStats(RTCStatsCollectorCallback)` one-arg API
- absolute initial usable-video deadline (15 seconds)
- bounded reconnect: requester uses the 5s frame-grace deadline; sharer uses the 8s attempt watchdog
- Error remains Error until explicit `recoverProductError()` / `clearError()`; availability only updates cached reachability
- Stop → immediate Start: latest valid `ACTION_START` while stopping is copied and queued; old-session callbacks cannot own the replacement
- incoming-request taps use `partnerscreen://incoming-request/<uuid>` plus native `OnNewIntent` and Expo Linking; stale IDs do nothing
- notifier advances desired-generation when the session listener fires; a stale completed show is cleared before the queued generation proceeds; `activeSessionId` is set only after the current show succeeds
- encoder bitrate warning is shown only for a sharer after a failed sender configure
- PiP uses actual remote geometry and exits on session end
- sanitized production media stats plumbed into controller/presentation

## Source gate (this commit)

- `npm ci`: PASS (649 packages)
- `npm run typecheck`: PASS
- `npm run test:product`: PASS (175/175)
- `npm run check:contracts`: PASS (13/13)
- `npm run check:baseline`: PASS
- `npm run sanitize`: PASS
- `npm run config:check`: PASS
- `npm run deps:check`: PASS
- `CI=1 npx expo prebuild --platform android --no-install`: PASS (`supportsPictureInPicture="true"`)

Native compile and physical behavior remain unproven. Prebuild is not a native compile. LIVE still means the first rendered remote frame.

## Next work

1. Review Mission 0 PR #10. Do not merge unless authorized.
2. Do **not** start Mission 0Q (APK / Maestro / physical) until this PR is reviewed.

## High-risk invariants

- LIVE requires the current renderer/session/track epoch's actual first frame.
- Pairing survives Error recovery.
- Availability updates must not silently clear Error.
- No secrets, raw SDP, or full IPs in ordinary diagnostics/notifications.
- Native compile and physical behavior remain unproven until Mission 0Q.
