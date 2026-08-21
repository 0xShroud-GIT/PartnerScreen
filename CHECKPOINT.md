# PartnerScreen Checkpoint

**Updated:** 2026-08-21  
**Phase:** P0 runtime repair (source-only)  
**Working branch:** `arena/01a02681-partnerscreen`  
**Base:** `1d09ae4dfec7f0d998b02bb7b92a89722d2c8f48` (`main`)

## Current truth

- Native APK compile for `1d09ae4d` was **PASS**.
- Mission 0Q physical qualification **FAILED** on two Android phones.
- Source tests are **not** physical proof.
- Current mission is **P0 runtime repair**. Do not start Mission 1.

### Observed physical failures (frozen APK `1d09ae4d`)

- app responsiveness/freezing materially worse
- partner discovery much slower than previously working behavior
- control connections fail after availability claimed partner was available
- reconnect/recovery unreliable
- notification permission prompt does not appear reliably
- permission had to be granted manually
- incoming request effectively visible only while app is alive/foreground
- MediaProjection consent and capture start succeed
- WebRTC negotiation reaches `remote_track`
- actual first rendered frame never arrives
- sessions killed by the 15-second initial-video deadline
- duplicate `viewer_opened` events
- duplicate `keep_awake_enabled` events
- PiP does not work
- general session lifecycle is buggy

`remote_track` proves negotiated receiver-track existence, **not** RTP/decoded/rendered media.

## Source work on this branch

P0-A through P0-H implemented in source. No APK, Gradle, Expo prebuild, Maestro, emulator, or workflow dispatch was run in this mission.

## High-risk invariants

- LIVE requires the current renderer/session/track epoch's actual first frame.
- Pairing survives recoverable media failure.
- Availability updates must not silently clear Error.
- No secrets, raw SDP, or full IPs in ordinary diagnostics/notifications.
- Native compile and physical behavior remain unproven until the next APK.

## Next work

1. Review the P0 runtime-repair PR. Do not merge unless authorized.
2. Humans build an APK and physically qualify. Do not claim video, discovery speed, background notifications, reconnect, PiP, or freeze fixes until that APK proves them.
