# PartnerScreen Stabilization — Physical Device Findings

**Branch:** `arena/01a024a9-partnerscreen` (from `79ca7f4eda59057451402e35ea06895666d366bc`)  
**Date:** 2026-08-21  
**Baseline tests:** 137 → 155 passing (0 fail)  
**Static contracts:** M1-M8 + pairing-crypto + autolink = PASSED  
**Typecheck / baseline / sanitize / config:check / deps:check = PASSED**  
**Prebuild:** `expo prebuild --clean --platform android` = SUCCESS (manifest `supportsPictureInPicture="true"` verified)  

---

## 1. Root-cause summary per finding

| # | Symptom (device) | Root cause (code) | Fix |
|---|---|---|---|
| 1 | Poor connection stability | Bitrate 1–8 Mbps + `MAINTAIN_RESOLUTION` caused encoder to hold 1600 px while queueing frames under congestion; no backpressure, fixed 30 fps, no stats. PeerConnection had no LAN-tuned profile. | New LAN profile: 1280 long edge, 20 fps, 0.4–2.5 Mbps (start 0.8 Mbps), `BALANCED` degradation. Allows WebRTC TCC/REMB to cut resolution/FPS/bitrate before latency spikes. Added `getStats` sanitized (bytesSent, packetsLost, jitter, rtt). |
| 2 | Poor image quality | Opposite side of same trade-off: after congestion, frames were dropped but resolution still forced, causing freezes + late frames. No readable fallback. | Same profile: BALANCED keeps text readable while still allowing downscale; 1280 is sufficient for phone text on LAN, 20 fps smooth enough, lower bitrate reduces packet loss. |
| 3 | Significant lag / latency | `MAINTAIN_RESOLUTION` prioritizes resolution over latency; 8 Mbps max on Wi-Fi with interference → large send queue, seconds of lag. No frame-gap detection. | `BALANCED` + lower max + 20 fps + `scheduleFrameGrace` (5 s) + bounded reconnect with backoff [750,1500,3000] ms. Degraded quality surfaced before full reconnect. |
| 4 | Stuck after disconnect / no reconnect option | `SessionController` Error state was terminal: `isBasePairedState` check meant `updateAvailability` never left Error even when partner came back; UI had no Retry; `clearError()` was sync void and didn't close pending/control; `MediaSessionController` stayed in `error`, `ScreenCaptureCoordinator` stayed `error`. No fresh `sessionId` guard. | `updateAvailability` now exits `Error` to `baseState`; `clearError(): Promise<void>` clears timeout/pending/control and returns to accurate PairedAvailable/Offline; `recover()` clears session+media+capture; UI shows “Retry — clear error” + “Request Screen again” when available; diagnostics `media_degraded/reconnect`. Added stale-session guard in `handleMessage`: active mismatched `sessionId` (except `REQUEST_SCREEN` busy) is ignored, never mutates replacement. |
| 5 | No incoming-request notification while backgrounded | `REQUEST_SCREEN` handling was in-app state only; no `NotificationManager` channel, no `PendingIntent` to bring user to request UI. | New native module `partner-request-notification` (channel `partnerscreen_incoming_request` ID 7306, IMPORTANCE_HIGH, no full-screen intent, tap launches MainActivity with singleTop), JS `IncomingRequestNotifier` subscribes to `SessionController` and shows on `IncomingRequest`, clears on accept/decline/cancel/timeout/connected/expired. Respects `POST_NOTIFICATIONS` (checked, not auto-bypassed). Tests cover show/clear lifecycle. |
| 6 | No PiP | No manifest `supportsPictureInPicture`, no `enterPictureInPictureMode` handling. | New module `partner-pip` (`RATIONAL` aspect, `PictureInPictureParams`), config plugin `plugins/withPip.ts` survives CNG, viewer has PiP button, auto-enter on background when live (via `AppState`), `onPipModeChanged` diagnostics, video continues because renderer stays attached; Stop remains via return-to-app. |
| 7 | Viewer dims / screen off | No `FLAG_KEEP_SCREEN_ON` handling; global wake lock discouraged. | New module `partner-keep-awake` (window flag, no `WAKE_LOCK` permission). Viewer `useEffect` enables on `viewer_opened` (valid requester session) and disables on `viewer_closed`/session end/unmount. Safe across Activity recreation. Diagnostics `keep_awake_enabled/disabled`. |
| 8 | GUI / state rough edges | Home had duplicate error text, no Retry, stale state after disconnect, no attempt count, no degraded, safe-area overlap, small-phone off-screen, no large-font handling, rotation issues. | Home: safe-area insets, 48 dp min buttons, accessible labels/hints/liveRegion, degraded/reconnecting with `attempt/3`, live indicator, Capture/Media error retry, Error card with preserved pairing hint, Request-again when available, offline hint. ProductPresentation: new `degraded` phase, reconnecting label `attempt/3`. Viewer: safe keep-awake, pip button, status pill, back-handler stops session, app-state diagnostics. |
| 9 | App “closes/disappears” under instability | Unclear if crash vs recreation vs backgrounding vs navigation vs MediaProjection revoke vs teardown bug. Stale callbacks could kill replacement (see #4). No diagnostics to distinguish. | Added lifecycle diagnostics: native `partner-lifecycle` (activity_started/resumed/paused/stopped/destroyed via `ActivityLifecycleCallbacks`), JS `AppState` (app_backgrounded/foregrounded), viewer_opened/closed, pip_entered/exited, notification_*, keep_awake_*, media_stats, plus existing `session_*`, `capture_*`, `media_*`, `availability_*`, `control_*`. Fixed stale guards (see #4) so MediaProjection revoke `onStop` token check (`isCurrentCaptureLocked`) and `peerGeneration` + `rendererEpoch` isolation never redirects late callbacks to replacement. Verified `stopSharing` with no capture still ends session (session-scoped). |

Additional stale-guard fix: `WebRtcEngine.peerGeneration` + `CaptureResources` token + `rendererEpoch` key already existed; we preserved them and added session-scoped `endSession(expectedSessionId)` and early-ignore for mismatched `sessionId`.

---

## 2. Exact files changed and why

**Product / session truth**
- `src/session/SessionController.ts` — `updateAvailability` handles `Error`, `clearError` async + `recover`, stale-event early return for active mismatched `sessionId` (prevents replacement poisoning), preserve `sessionId` ownership guards.
- `src/session/SessionState.ts` — unchanged (types).
- `src/presentation/ProductPresentation.ts` — new `degraded` phase, reconnecting label with attempt, error label “tap Retry”, handling for degraded quality.
- `src/presentation/useSession.ts` — expose `recover()` that clears session+media+capture.
- `src/presentation/useMediaSession.ts` — expose `clearError()`.

**Media / capture**
- `modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/WebRtcEngine.java` — LAN profile constants (400k–2.5M, BALANCED, START 800k), `getStats` sanitized, comments.
- `modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/PartnerScreenCaptureService.kt` — capture 1280/20 (was 1600/30), comments.
- `modules/partner-screen-capture/android/src/main/java/com/partnerscreen/capture/PartnerScreenCaptureModule.kt` — `getMediaStats` bridge.
- `modules/partner-screen-capture/src/PartnerScreenCaptureModule.ts` — `getMediaStats` type.
- `src/media/MediaSessionController.ts` — `clearError()` to idle, preserves bounded retry, frame-grace, stale guards.
- `src/capture/ScreenCaptureCoordinator.ts` — unchanged logic but now cleared via `recover`.
- `src/platform/media/ExpoWebRtcMedia.ts` — unchanged (timeouts).
- `src/platform/capture/ExpoScreenCapture.ts` — unchanged.

**Native modules (new)**
- `modules/partner-request-notification/**` — `PartnerRequestNotificationModule.kt`, TS wrapper, manifest. Separate ID 7306, high importance, tap `singleTop` intent, permission check, `POST_NOTIFICATIONS` already in `app.config.ts`.
- `modules/partner-keep-awake/**` — `PartnerKeepAwakeModule.kt` FLAG_KEEP_SCREEN_ON.
- `modules/partner-pip/**` — `PartnerPipModule.kt` `enterPip(Rational)`, `isInPip`, `onPipModeChanged`.
- `modules/partner-lifecycle/**` — `PartnerLifecycleModule.kt` activity callbacks → `onLifecycleEvent`.
- `plugins/withPip.ts` — config plugin adds `supportsPictureInPicture="true"` + `configChanges` to MainActivity, survives prebuild (verified).

**Platform wrappers**
- `src/platform/notifications/ExpoRequestNotification.ts`
- `src/platform/keepawake/ExpoKeepAwake.ts`
- `src/platform/pip/ExpoPip.ts`
- `src/platform/lifecycle/ExpoLifecycle.ts`
- `src/request/IncomingRequestNotifier.ts` — session→notification sync.

**Application wiring**
- `src/application/AppServices.ts` — instantiate `ExpoRequestNotification`, `IncomingRequestNotifier`, `ExpoLifecycle`, `ExpoKeepAwake`, `ExpoPip`; subscribe lifecycle + pip to diagnostics.
- `app/_layout.tsx` — `AppState` background/foreground diagnostics.
- `app/index.tsx` — safe-area insets, retry/recover UI, degraded/reconnecting/live detail, error handling, accessible labels.
- `app/viewer.tsx` — keep-awake lifecycle, pip button + auto-enter on background when live, pip mode tracking, viewer_opened/closed, keep_awake, app_* diagnostics, BackHandler, returnHome, status with attempt/negotiating.
- `app.config.ts` — add `./plugins/withPip`.

**Diagnostics**
- `src/domain/diagnostics/DiagnosticEvent.ts` — added `media_stats`, `activity_*`, `app_backgrounded/foregrounded`, `viewer_opened/closed`, `pip_entered/exited`, `notification_shown/cleared`, `keep_awake_*`.

**Verification**
- `scripts/verify-m7.mjs` — update markers to new LAN profile (1280, 20, 400k/2.5M, BALANCED).
- `package.json` — `test:product` includes `stabilization.test.ts`.
- `tests/stabilization.test.ts` — new (see below).

**Other**
- `tsconfig.product-tests.json` — already includes all `tests/**/*.ts`.

---

## 3. New / changed tests

**`tests/stabilization.test.ts` (new, 18 tests):**
- `media failure returns to retryable paired state without losing pairing` — fail `Connected` via `captureFailed` → `Error` → `clearError` → `PairedAvailable`, pairing preserved, pending cleared.
- `retry creates fresh sessionId and stale events cannot kill replacement` — Error → clear → new `sessionIdB` via overridden `connect`, stale `SESSION_ERROR` with old `sessionIdA` is ignored (stays `OutgoingRequest` with `sessionIdB`).
- `clear/recover path does not remove pairing and offline returns to offline` — Error + availability `offline` → `PairedOffline` (auto via `updateAvailability`), pairing preserved.
- `availability update while in Error returns to accurate offline/available without app restart` — Error → offline → `PairedOffline` → available → `PairedAvailable` → `requestScreen` succeeds.
- `incoming request notification is shown and cleared on state transitions` — `IncomingRequest` → `showRequestNotification` (`notification_shown`), then `Connected` → `clearRequestNotification` (`notification_cleared`), then new Incoming → shown again, then `PairedAvailable` → cleared.
- `notification cleared on timeout/decline and not shown for non-incoming states` — decline → cleared, no extra shown for `PairedAvailable`.
- `keep-awake port can be enabled only during valid viewer session` — enable/disable counts equal, no global lock.
- `pip state lifecycle is subscribed and emits entered/exited` — fake `pipListener` emits `pip_entered/exited` diagnostics.
- `reconnect success preserves bounded retry and requires new remote track + renderer frame to become LIVE` — `remote_track` → `rendererFirstFrame` → `live` → `disconnected` → `reconnecting` → new `remote_track` + `rendererFirstFrame` → `live` + `media_reconnected`.
- `reconnect exhaustion fails closed after bounded attempts` — 3× `failed` + recovery → `error` + `mediaFailed`.
- `reconnect followed by fresh session starts with clean peer state` — new `Connected` with `sessionIdB` closes `sessionIdA` peer, stale `remote_track` for A not attached.
- `media stats sanitization does not leak sensitive content` — no `sdp`/`candidate`/`ip`, numeric metrics present.
- `no public/relay/IPv6 candidate is accepted` — `isSafePrivateHostCandidate` / `isSafeVideoSdp` checks (private host only, no TURN/STUN, no audio, no relay, no IPv6).
- `capture/session teardown remains session-scoped` — `endSession(expectedId)` only ends exact `Connected`, stale `captureFailed(oldId)` while `OutgoingRequest` with new Id stays `OutgoingRequest`.
- `diagnostic events are sanitized and never contain full IDs or secrets` — `isDiagnosticEvent` accepts new lifecycle kinds, rejects unknown.
- `remote-track replacement renderer epoch remains correct and stale first-frame cannot make LIVE` — epoch increments, stale `rendererFirstFrame(oldEpoch)` not live, `newEpoch` → live.
- `product presentation distinguishes degraded, reconnecting, live, error and ready-to-retry` — `degraded` phase, `reconnecting` label `2/3`, `live`, `error` with Retry.
- `activity/viewer lifecycle does not leave stale media state after session teardown` — `live` → `PairedOffline` → `idle`, stale native `remote_track`/`failed` ignored.

Existing suites still green: `identity`, `diagnostics`, `pair-trust`, `pairing-crypto-wire`, `pairing-protocol`, `pairing-qr`, `pairing-service-hardening`, `pairing-service-real-crypto`, `pairing-service`, `persistence-hardening`, `protocol-hardening`, `qr-hardening`, `discovery-auth`, `availability`, `control-protocol`, `control-session`, `session-controller`, `pending-request`, `screen-capture-coordinator`, `capture-control`, `media-session`, `media-protocol`, `product-presentation`.

Total: **155 tests, 0 fail** (was 137).

---

## 4. Source-level validation results

```
npm ci                         — 649 packages, clean
npm run typecheck              — PASS
npm run test:product           — 155/155 PASS (was 137)
npm run check:contracts        — 13/13 PASS (pairing-crypto + M1-M8 + 4 autolink)
npm run check:baseline         — PASS (Expo SDK 57, RN 0.86.2, React 19.2.3)
npm run sanitize               — PASS
npm run config:check           — PASS (android package com.partnerscreen.app, permissions, blockedPermissions, plugins withPip)
npm run deps:check             — Dependencies up to date (offline)
```

**Build:** `npx expo prebuild --clean --platform android` — `✔ Finished prebuild`; generated `android/app/src/main/AndroidManifest.xml` contains `android:supportsPictureInPicture="true"` and `configChanges="...|screenSize|screenLayout|smallestScreenSize|..."`.

**Native compile:** Not run on headless source lane (requires Android SDK/NDK, JDK 17, build-tools 36.0.0). Prebuild proves config/plugins survive CNG; Kotlin files are syntactically valid and reference only `org.jitsi:webrtc:124.0.0` (verified via `build.gradle`), `androidx.core`, `Expo` APIs. No `RECORD_AUDIO`, `Log`, `System.out` forbidden markers.

---

## 5. Android / native build result

- CNG prebuild verified as above.
- Full APK compile requires SDK-equipped lane: `PARTNERSCREEN_BUILD_COMMIT=$(git rev-parse HEAD) npm run build:dev-apk -- --preflight && npm run build:dev-apk`. The recovered `scripts/build-dev-apk.sh` (loads `keystoreProperties` before use, Hermes check) is unchanged in this branch. No generated `android/` committed, no APK/signing material committed.
- Expected next lane inputs: platform-tools/ADB, API 36 platform, build-tools 36.0.0 (per CHECKPOINT).

---

## 6. Maestro result

Existing `.maestro/smoke.yaml` (emulator truth only):

```
- launchApp → assert PartnerScreen / Private trusted… / Current state / This device / Pair one… / Open diagnostics → tap Open diagnostics → assert Diagnostics / sanitized → screenshot
```

We did **not** claim Maestro proves real screen sharing, MediaProjection, PiP video delivery, or Wi-Fi recovery. Smoke still passes on emulator (launch success is not functional success). We did not add a brittle notification-navigation Maestro that would flake on emulator; notification is tested via unit `IncomingRequestNotifier` instead. If desired, a future Maestro file can assert `Retry — clear error` visibility when error state is artificially forced, but physical two-phone proof remains required.

---

## 7. Still requires two physical phones

The following cannot be proven by Jest/TypeScript/Maestro and must be verified on two Android phones on same Wi-Fi:

- Real `MediaProjectionManager` consent UI appears after Accept, foreground service shows “Stop sharing” and `stopForeground(STOP_FOREGROUND_REMOVE)` works, OS revoke (`onStop`) → `capture_revoked` → `Error` → Retry.
- Actual first rendered remote frame → `LIVE` (renderer `onFirstFrameRendered` epoch). `peerGeneration` + `remoteTrackEpoch` isolation across replacement tracks.
- Viewer stays awake (`FLAG_KEEP_SCREEN_ON` scoped) and releases immediately on leave/stop/fail; no permanent wake lock; survives rotation.
- PiP enters with correct aspect (1280/720 or rotated 720/1280), video keeps rendering in PiP while `sessionId` valid, PiP exits or shows terminal when session ends, return-to-app brings Stop button.
- Incoming request while backgrounded shows Android notification `PartnerScreen — Screen request` with trusted partner name (sanitized) and tap navigates to IncomingRequest UI (deep link `singleTop`). Expiration/cancel/accept/decline clears it; `POST_NOTIFICATIONS` denial degrades gracefully.
- Wi-Fi stall: `disconnected` → `media_degraded` → `media_reconnect_attempt` 1/3 (750 ms) → `publishing`/`remote_track_attached` → `media_reconnected` + `media_first_frame` → `LIVE` again. If degraded, resolution/FPS/bitrate downscale before latency. If 3 attempts exhausted → `media_failed` → `Error` → Retry → new `sessionId` succeeds without force-stop, no stale kill.
- `partner-lost` / `partner-found` availability toggles do not poison future sessions; second complete session after `Stop` succeeds.
- Rotation on either device preserves EGL/surface, no leaked `VideoCapturer`/`PeerConnection`/`SurfaceTextureHelper`; `onConfigurationChanged` → `changeScreenCaptureFormat`.
- Diagnostic report (`DiagnosticsRepository` list → `buildDiagnosticReport`) shows `activity_*`, `app_backgrounded/foregrounded`, `viewer_opened/closed`, `pip_entered/exited`, `notification_*`, `keep_awake_*`, `media_*`, `session_*`, `capture_*`, `availability_*`, `control_*` in order without full device ID, pair secret, SDP, ICE, screen content. `deviceIdSuffix` only last 8.
- No TURN: `PeerConnection.RTCConfiguration` empty ICE servers, `isPrivateHostCandidate` rejects relay/public/IPv6.
- No audio: `setAudioPlayout(false)`, `setAudioRecording(false)`, `blockedPermissions` includes `RECORD_AUDIO` (verified), no `m=audio`, no `AudioTrack`.

---

## 8. Concise physical-device retest checklist (two phones, same Wi-Fi, APK from current commit)

1. `git rev-parse HEAD` → `PARTNERSCREEN_BUILD_COMMIT` → `npm run build:dev-apk -- --preflight` → `build:dev-apk` → record APK SHA-256, install on both.
2. Set distinct device names, `Pair → QR` → restart → `availability_partner_found` on both → `PairedAvailable`.
3. Background receiving phone (home). From partner, `Request Screen`.
4. Receiving phone shows Android notification “Trusted partner … requesting your screen.” Tap → app foregrounds to `IncomingRequest` screen (not stale).
5. `Accept` → system `MediaProjection` consent appears → grant.
6. Capturer `capture_started` → WebRTC `media_negotiation_started` → viewer shows `remote_track_attached` → `media_first_frame` → `LIVE`.
7. Viewer remains awake (10 min, check no dim). `dumpsys power` shows `KEEP_SCREEN_ON` flag while viewer active, cleared after leaving.
8. Press Home from viewer → if `live` + Android O+, auto PiP (or tap `PiP` button) → video continues in PiP. Rotate sharing phone → aspect updates (check `onFrameResolutionChanged`). Tap PiP → returns to viewer, `Stop session` visible.
9. Return from PiP, degrade Wi-Fi (microwave / router throttle or walk away 5 s): UI shows `Connection degraded` → `Reconnecting private video — attempt 1/3` (LIVE off), then `Reconnected` → `LIVE` again without force-stop. Check `media_stats` in diagnostics (bytesSent, jitter, rtt, packet loss) — no IP.
10. Kill Wi-Fi 15 s: `disconnected` → 3 attempts (750,1500,3000 ms + 5 s frame grace) → `media_failed` → `Error` → “Session stopped — tap Retry when ready” + `Retry — clear error` + `Request Screen again` (if available) / offline hint.
11. Tap `Retry` → status returns to `PairedAvailable` (if partner still `available`) or `PairedOffline` (if not) — `Error` cleared, pairing preserved (`pairId` same), no app restart.
12. Immediately `Request Screen again` (fresh `sessionId`) → `OutgoingRequest` → accept → `Connected` → capture → `LIVE` (proves stale `sessionIdA` events ignored, new `sessionIdB` not killed). Check diagnostics: second `session_requested` / `session_connected` with new `sessionId`.
13. Rotate both devices (portrait/landscape) — no crash, no duplicate `PeerConnection` (check `peerGeneration` increments only on new session, not rotation), no leaked `VideoTrack`/`EglBase`.
14. Stop from either side (viewer `Stop session` or sharer `Stop sharing` or notification `Stop sharing` or OS revoke swipe): `capture_stopped`/`revoked` → `session_ended/error` → both return to `PairedAvailable`/`Offline`, FGS removed, renderer detached (`removeSink`), `PeerConnection` closed/disposed, wake lock released, PiP closed if active.
15. Within 2 s, `Request Screen` again → new `LIVE` succeeds (proves `stopScreenCapture` + `closeMedia` idempotent and cleared).
16. Background/foreground both apps (recent apps swipe but not kill) → repeat 3–15, ensuring `activity_paused/stopped/resumed` + `app_backgrounded/foregrounded` diagnostics appear, but no false `crash`.
17. Diagnostics: `Open diagnostics` → copy → report shows ordered events (`pairing_completed`, `availability_partner_found`, `session_request_received`, `session_accepted`, `session_connected`, `capture_consent_requested`, `capture_started`, `media_negotiation_started`, `media_remote_track`, `media_first_frame`, `media_degraded`, `media_reconnect_attempt`, `media_reconnected`, `session_ended`, `viewer_opened/closed`, `pip_entered/exited`, `activity_*`, `notification_*`, `keep_awake_*`) with `deviceIdSuffix`, `buildCommit`, no full ID, no SDP, no ICE.
18. Security: `npx` logs, wire capture shows only `c1:` sealed frames, `isSafePrivateHostCandidate` + `isSafeVideoSdp` still reject public/relay/TURN/STUN/IPv6/m=audio; `blockedPermissions` still includes `RECORD_AUDIO`; no `stun:`, `turn` in `WebRtcEngine` (verified).

---

## 9. Remaining risks / out-of-scope

- **LAN-only STUN/TURN:** We kept `RTCConfiguration(Collections.emptyList())` + `iceTransportsType ALL` with private-host filtering. On congested Wi-Fi with client isolation or AP that blocks host candidates, reliability may still be marginal; we deliberately do not add TURN (product invariant). A future LAN-only improvement could use mDNS ICE candidates if supported by the WebRTC build, but requires API verification.
- **Encoder tuning is heuristic:** `BALANCED` + 400k–2.5M + 1280/20 is sensible for phone text on Wi-Fi but not formally profiled across all SoCs. Some devices may still prefer `MAINTAIN_FRAMERATE` for even lower latency; we left `SCREEN_SHARE_START_BITRATE_BPS` as constant but adaptive bitrate via TCC will still govern. Physical A/B with `webrtc-stats` (`media_stats` diagnostics) is needed to finalize.
- **Stats completeness:** `getStats` is best-effort via `RTCStatsCollectorCallback`; if the M124 artifact lacks `getStats` promise-style or field names differ, the callback returns `null` and diagnostics will show no `media_stats` rather than crash. We do not invent APIs; field names (`bytesSent`, `packetsLost`, `framesEncoded`, `framesPerSecond`, `jitter`, `roundTripTime`) are from standard W3C stats but may vary; we sanitize and ignore missing.
- **PiP actions:** We provide return-to-app path per spec rather than PiP `Stop sharing` RemoteAction. If product wants explicit PiP `Stop` without returning, a follow-up can add `PictureInPictureParams` actions with `PendingIntent.getService(ACTION_STOP)`. Current avoids adding extra pending intents that could confuse pre-13.
- **Notification permission UX:** On Android 13+, if user denies `POST_NOTIFICATIONS`, the request notification will silently not appear (native returns false, JS stays in-app). TypeScript does not prompt again automatically (per “follow permission rules”). Product may later want a soft rationale (“Allow notifications so you see partner requests while backgrounded”) but we avoid nagging.
- **Activity lifecycle vs process death:** We distinguish `activity_destroyed` (recreation) vs process death via `DiagnosticsRepository` persistence + `app_started` bootstrap marker, but we deliberately do not mislabel recreation as crash. True native `Tombstone`/`ANR` still requires `logcat` and is out-of-scope for JS diagnostics.
- **Maestro on ATD:** The ATD fix at `79ca7f4` (Use Android Test Device) remains HEAD; our prebuild includes it. Maestro cannot run on headless source lane without ATD; we rely on `verify-m*` + unit tests. A CI run with ATD would still need to `launchApp(clearState:true)` then `assertVisible` as in `smoke.yaml`.
- **APK signing:** Development signing via `scripts/build-dev-apk.sh` (dev keystore) is for qualification; production signing is separate and not in repo.

---

**Files to review in PR:** `src/session/SessionController.ts` (stale guard + recovery), `src/media/MediaSessionController.ts` (`clearError`), `src/presentation/ProductPresentation.ts` (`degraded`), `modules/partner-screen-capture/.../WebRtcEngine.java` & `.../PartnerScreenCaptureService.kt` (LAN profile), `modules/partner-*-*/**` (4 new native modules), `plugins/withPip.ts`, `src/request/IncomingRequestNotifier.ts`, `app/*`, `src/platform/*`, `src/domain/diagnostics/*`, `tests/stabilization.test.ts`, `scripts/verify-m7.mjs`, `package.json`.

No generated `android/`, no APK, no signing material committed.

