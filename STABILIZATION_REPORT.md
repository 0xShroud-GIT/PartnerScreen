# PartnerScreen Stabilization — Physical Device Findings

**Branch:** `arena/01a024a9-partnerscreen` → rebased onto `a1740d7` (Separate source checks from manual APK qualification)  
**Previous base:** `79ca7f4` (ATD) → current HEAD `65ce02d` (Fix PiP native hooks)  
**Date:** 2026-08-21  
**Source gate:** `152 → 155` tests PASS, `typecheck` PASS, `M1-M8` PASS  
**Prebuild:** `CI=1 npx expo prebuild --platform android --no-install` → `✔ Finished prebuild` (manifest `supportsPictureInPicture="true"` verified)  
**Native APK:** **NOT RUN** — intentionally not triggered (see CI policy below)  

> **Source and prebuild gates pass. Native Android compilation and physical qualification remain pending.**

---

## CI policy (current main a1740d7)

- **Automatic source gate** (`.github/workflows/source-gate.yml`) runs on `push: main`, `pull_request: main`, `workflow_dispatch`: `npm ci`, `typecheck`, `test:product`, `check:contracts`, `check:baseline`, `sanitize`, `config:check`, `deps:check`, `expo prebuild --no-install`.
- **Manual APK qualification** (`.github/workflows/build-dev-apk.yml`) is `workflow_dispatch` only (input `run_maestro`). It **must not** run on `push`, `pull_request`, or routine Arena iterations. This policy is preserved in this branch and was **not** reverted during rebase.
- Verification after rebase: `source-gate.yml` exists, `build-dev-apk.yml` is `workflow_dispatch` only, no automatic heavy build on PR/push.

---

## 1. Root-cause summary per finding

| # | Symptom (device) | Root cause (code) | Fix (this branch) |
|---|---|---|---|
| 1 | Poor connection stability | Bitrate 1–8 Mbps + `MAINTAIN_RESOLUTION` held 1600 px while queueing frames under congestion; fixed 30 fps; no stats. | **LAN profile** `1280px / 20fps / 0.4–2.5Mbps (start 0.8M) / BALANCED`. Lets TCC/REMB cut resolution/FPS/bitrate before latency. Added `WebRtcEngine.getStats` sanitized (bytesSent, packetsLost, jitter, rtt, candidatePairState). |
| 2 | Poor image quality | Same trade-off: resolution forced while frames dropped → freezes/late frames. | Same profile: BALANCED keeps text readable; 1280 sufficient, 20 fps smooth, lower bitrate reduces loss. |
| 3 | Lag / latency | `MAINTAIN_RESOLUTION` prioritizes resolution; 8 Mbps on noisy Wi-Fi → send queue seconds lag; no frame-gap detection. | BALANCED + lower max + 20 fps + `scheduleFrameGrace 5s` + bounded reconnect `[750,1500,3000]ms`. Degraded surfaced before reconnect. |
| 4 | Stuck after disconnect / no reconnect option | `Error` terminal: `isBasePairedState` guard blocked `updateAvailability` from leaving Error; UI no Retry; `clearError()` sync void didn’t close pending/control; `MediaSessionController`/`ScreenCaptureCoordinator` stayed `error`; stale `sessionId` could kill replacement; `handleMessage`’s `rejectInvalidTransition` on mismatched active `sessionId` poisoned new session. | `updateAvailability` now exits `Error→baseState`; `clearError():Promise` clears timeout/pending/control → `baseState`; `recover()` clears session+media+capture; UI “Retry — clear error” + “Request Screen again”; **stale guard** in `handleMessage`: active `(Outgoing|Incoming|Connected)` with mismatched `sessionId` and `type!="REQUEST_SCREEN"` is **ignored** (busy `REQUEST_SCREEN` still declines). Fresh `sessionId` via `control.connect` random UUID each request. |
| 5 | No incoming-request notification while backgrounded | Only in-app state. | Native `partner-request-notification` (channel `partnerscreen_incoming_request` ID 7306, `IMPORTANCE_HIGH`, no `fullScreenIntent`, `singleTop` launch, `POST_NOTIFICATIONS` checked) + `IncomingRequestNotifier` (show on `IncomingRequest`, clear on accept/decline/cancel/timeout/connected). Sanitized: only partner name (40 chars printable), no secrets/IP/SDP. |
| 6 | No PiP | No manifest / `enterPictureInPictureMode`. | Native `partner-pip` (`Rational` aspect), plugin `withPip` (`supportsPictureInPicture` + `configChanges`, survives CNG, verified). Viewer has **explicit** PiP button (reliability over auto-enter); native tracks `wasInPip` via `OnActivityEntersForeground/Background` + `isInPictureInPictureMode` and emits `onPipModeChanged` (previously used unsupported `OnActivityEntersPictureInPicture` hooks — fixed). Video continues because renderer stays attached (`attachDesiredRendererLocked`). Stop remains via return-to-app. |
| 7 | Viewer dims | No wake lock. | `partner-keep-awake` (`FLAG_KEEP_SCREEN_ON`, no `WAKE_LOCK` permission). Viewer `useEffect` enables on `viewer_opened` (valid requester `Connected`) and disables on `viewer_closed`/unmount/session end; survives recreation. |
| 8 | GUI/state rough edges | Duplicate error text, no Retry, stale, no attempt count, safe-area overlap, off-screen buttons, large-font, rotation. | Home safe-area insets (`useSafeAreaInsets`), 48dp min buttons, `accessibility*` + `liveRegion`, `degraded`/`reconnecting attempt N`/`LIVE` distinct, capture/media Error retry, `Error` card preserves pairing, `Request again` when available, offline hint. `ProductPresentation` new `degraded` phase. Viewer pip button + status pill + `BackHandler` → `endSession`. |
| 9 | App “closes/disappears” under instability | Unclear crash vs recreation vs background vs navigation vs MediaProjection revoke vs teardown. Stale callbacks (see #4) could kill replacement. No diagnostics. | `partner-lifecycle` (activity `started/resumed/paused/stopped/destroyed` via `ActivityLifecycleCallbacks` + `OnCreate/OnDestroy`), `_layout` `AppState` `app_backgrounded/foregrounded`, `viewer_opened/closed`, `pip_entered/exited`, `notification_*`, `keep_awake_*`, `media_stats`, plus `session/capture/media/availability/control`. Stale guards (`peerGeneration`, `captureGeneration token`, `rendererEpoch` key, `endSession(expectedId)` session-scoped) prevent late callbacks. **Do not** mislabel recreation as crash. |

---

## 2. Exact files changed and why

**Product / session truth**
- `src/session/SessionController.ts` — `Error`-aware `updateAvailability`, async `clearError/recover`, early stale-ignore for active mismatched `sessionId` (except `REQUEST_SCREEN` busy), preserve `pair` and `sessionId` ownership.
- `src/presentation/ProductPresentation.ts` — `degraded` phase, `reconnecting` label `attempt/3`, error “tap Retry”.
- `src/presentation/useSession.ts` — `recover()` clears session+media+capture.
- `src/presentation/useMediaSession.ts` — expose `clearError()`.

**Media / capture**
- `modules/partner-screen-capture/android/.../WebRtcEngine.java` — LAN `400k–2.5M (start 800k) / BALANCED / scaleResolutionDownBy 1.0`, sanitized `getStats(RTCStatsCollectorCallback)` → `media_stats` (bytesSent, packetsLost, framesEncoded, framesPerSecond, totalEncodeTime, jitter, roundTripTime, candidatePairState) — no IP/SDP/candidate.
- `.../PartnerScreenCaptureService.kt` — `1280px / 20fps`.
- `.../PartnerScreenCaptureModule.kt` — `getMediaStats` bridge.
- `.../PartnerScreenCaptureModule.ts` — type.
- `src/media/MediaSessionController.ts` — `clearError()->idle`, bounded retry, `isCurrentSession` guards, `rendererFirstFrame` epoch check.
- `src/capture/ScreenCaptureCoordinator.ts` — unchanged but cleared via `recover`.

**Native modules (new)**
- `modules/partner-request-notification/**` — `PartnerRequestNotificationModule.kt` (ID 7306, `IMPORTANCE_HIGH`, `setAutoCancel`, `singleTop`, permission `POST_NOTIFICATIONS` check), `expo-module.config.json`, `build.gradle`.
- `modules/partner-keep-awake/**` — `FLAG_KEEP_SCREEN_ON`, `enable/disable/isEnabled`.
- `modules/partner-pip/**` — `enterPip(Rational)`, `isInPip`, `supportsPip`, `wasInPip` tracking via `OnCreate` + `OnActivityEntersForeground/Background` + `isInPictureInPictureMode` (fixed from unsupported hooks), `build.gradle`.
- `modules/partner-lifecycle/**` — `ActivityLifecycleCallbacks` → `onLifecycleEvent`, `expo-module.config.json`.
- `plugins/withPip.ts` — adds `supportsPictureInPicture="true"` + required `configChanges` to `MainActivity` (verified in `android/app/src/main/AndroidManifest.xml`).

**Platform wrappers**
- `src/platform/notifications/ExpoRequestNotification.ts` (lazy `require`, fallback false)
- `src/platform/keepawake/ExpoKeepAwake.ts`
- `src/platform/pip/ExpoPip.ts` (subscribes to `onPipModeChanged`)
- `src/platform/lifecycle/ExpoLifecycle.ts`
- `src/request/IncomingRequestNotifier.ts`

**Application wiring**
- `src/application/AppServices.ts` — instantiate `ExpoRequestNotification`, `IncomingRequestNotifier`, `ExpoLifecycle`, `ExpoKeepAwake`, `ExpoPip`; subscribe `lifecyclePort→diagnostics`, `pipPort→pip_entered/exited`.
- `app/_layout.tsx` — `AppState` `app_backgrounded/foregrounded` (global, viewer no longer duplicates).
- `app/index.tsx` — safe-area `useSafeAreaInsets`, 48dp, `accessibility*`, `degraded/reconnecting/live` detail, retries, `Error` card, `Request again`.
- `app/viewer.tsx` — keep-awake scoped to `requesterSessionId`, **explicit** PiP button only (auto-enter removed for reliability), `isPip` state via `pipPort`, `BackHandler` → `endSession`, status `reconnecting attempt N`.
- `app.config.ts` — `plugins/withPip`.

**Diagnostics**
- `src/domain/diagnostics/DiagnosticEvent.ts` — `media_stats`, `activity_*`, `app_*`, `viewer_*`, `pip_*`, `notification_*`, `keep_awake_*` (bounded 100, `VALID_KINDS`).

**Verification**
- `scripts/verify-m7.mjs` — markers updated to `1280,20,400k/2.5M,BALANCED`.
- `package.json` — `test:product` includes `stabilization.test.ts`.
- `tests/stabilization.test.ts` — 18 tests (see §3).

**CI**
- `.github/workflows/source-gate.yml` (new from `a1740d7`) — lightweight source gate (no APK).
- `.github/workflows/build-dev-apk.yml` — now `workflow_dispatch` only (manual).

`tsconfig.product-tests.json` already includes `tests/**/*.ts`. No `android/` committed.

---

## 3. New / changed tests

**`tests/stabilization.test.ts` (18 tests, behavior not string search):**
- `media failure → retryable paired state` (pairing preserved, pending cleared)
- `retry creates fresh sessionId and stale cannot kill replacement` (old `sessionIdA` `SESSION_ERROR` ignored while `OutgoingRequest` with `sessionIdB` stays)
- `clear/recover preserves pairing, offline returns to offline`
- `availability update while in Error → offline/available without restart` (then `requestScreen` succeeds)
- `incoming notification shown/cleared on state transitions` (`IncomingRequest`→`show`, `Connected`→`clear`, new Incoming→show, `PairedAvailable`→clear, `notification_shown/cleared` diagnostics)
- `notification cleared on timeout/decline, not shown for non-incoming`
- `keep-awake enable/disable counts equal, no permanent lock`
- `pip subscribe emits entered/exited` (`pip_entered/exited`)
- `reconnect success requires new remote_track + rendererFirstFrame to LIVE` (+ `media_reconnected`)
- `reconnect exhaustion fails closed after 3 attempts` → `error`, `mediaFailed`
- `reconnect followed by fresh session starts with clean peer state` (old `remote_track` not attached)
- `media stats sanitization` (no `sdp`/`candidate`/`ip`)
- `no public/relay/IPv6 candidate` (`isSafePrivateHostCandidate` / `isSafeVideoSdp` private-host only, reject TURN/STUN/audio)
- `capture/session teardown session-scoped` (`endSession(expectedId)` / `captureFailed(oldId)` while `OutgoingRequest(B)` stays)
- `diagnostic sanitization` (`isDiagnosticEvent` accepts new kinds, rejects unknown)
- `remote-track replacement epoch` (stale `rendererFirstFrame(oldEpoch)` not LIVE)
- `product presentation degraded/reconnecting/live/error` (`degraded` label, `reconnecting 2/3`, `error` Retry)
- `activity/viewer lifecycle does not leave stale media` (`live`→`PairedOffline`→`idle`, stale native ignored)

Existing suites (137) still green: `identity`, `diagnostics`, `pair-trust`, `pairing-crypto-wire`, `pairing-protocol`, `pairing-qr`, `pairing-service*`, `persistence-hardening`, `protocol-hardening`, `qr-hardening`, `discovery-auth`, `availability`, `control-protocol`, `control-session`, `session-controller`, `pending-request`, `screen-capture-coordinator`, `capture-control`, `media-session`, `media-protocol`, `product-presentation`.

**Total: 155 PASS, 0 fail.**  
Static contracts `verify-pairing-crypto + M1-M8 + 4 autolink` **PASS**.

---

## 4. Source-level validation results (lightweight, no APK)

```
npm ci                         — 649 packages, clean (npm 10.9.8, Node 22.13.1)
npm run typecheck              — PASS
npm run test:product           — 155/155 PASS
npm run check:contracts        — 13/13 PASS
npm run check:baseline         — PASS (Expo SDK 57, RN 0.86.2, React 19.2.3, lockfileVersion 3)
npm run sanitize               — PASS
npm run config:check           — PASS (package com.partnerscreen.app, blocked RECORD_AUDIO, plugin withPip)
npm run deps:check             — PASS (offline)
CI=1 npx expo prebuild --platform android --no-install
                               — ✔ Finished prebuild (supportsPictureInPicture="true" + configChanges)
```

**Build:** `npx expo prebuild --clean --platform android` verified manifest `android:supportsPictureInPicture="true"` and `screenSize|screenLayout|smallestScreenSize|orientation`.

**Native compile:** **NOT PROVEN** on headless lane (requires JDK 17, Android SDK 36.0.0, NDK). Kotlin files reference only `org.jitsi:webrtc:124.0.0`, `androidx.core`, `expo.modules.kotlin`; no `RECORD_AUDIO`/`Log`/`System.out` forbidden markers. Prebuild proves CNG compatibility; compilation remains pending manual APK lane.

---

## 5. Android / native build result

- **CNG prebuild:** PASS (see §4).
- **APK:** **Intentionally not triggered.** Per current `main` (`a1740d7`), `.github/workflows/build-dev-apk.yml` is `workflow_dispatch` only. Heavy lane must not run on push/PR/Arena iteration. No `npm run build:dev-apk` was invoked, no Maestro dispatched.
- **Next qualification (when human reviewer requests):** `PARTNERSCREEN_BUILD_COMMIT=$(git rev-parse HEAD) npm run build:dev-apk -- --preflight && npm run build:dev-apk` on SDK-equipped lane (platform-tools, android-36, build-tools 36.0.0), record SHA-256.

---

## 6. Maestro result

`.maestro/smoke.yaml` (emulator only): `launchApp(clearState:true)` → assert `PartnerScreen`/`Private trusted…`/`Current state`/`This device`/`Pair one…`/`Open diagnostics` → tap `Open diagnostics` → assert `Diagnostics`/`sanitized`. **Not claiming** proof of MediaProjection/PiP/Wi-Fi recovery. Notification lifecycle tested via unit `IncomingRequestNotifier`; physical notification + PiP video still require devices. No new brittle Maestro added.

---

## 7. What is proven vs not yet proven

**Proven by source tests (deterministic):**
- Error is recoverable, retry preserves pairing, fully tears down media/control/capture (pending cleared, `control.close` called, `MediaSessionController`→`idle`, `ScreenCaptureCoordinator`→`idle`).
- Replacement uses new `sessionId` (UUID via `AuthenticatedSignalingCipher.randomId`), stale `sessionIdA` `SESSION_ERROR`/`media`/`capture` events ignored while `OutgoingRequest(B)` active.
- No infinite reconnect loop (max 3, delays 750/1500/3000 + 5s frame grace, timer cancelled on teardown).
- `updateAvailability` while `Error` → accurate `PairedAvailable`/`PairedOffline` (availability loss/reappearance).
- Reconnect success requires new `remote_track` + `rendererFirstFrame(epoch)` to re-enter `LIVE`; exhaustion → `error`.
- `rendererEpoch` isolation: stale `rendererFirstFrame(oldEpoch)` not LIVE.
- `peerGeneration` + `captureGeneration` token + `sessionId` guards prevent late `PeerConnection`/`MediaProjection` callbacks from mutating replacement.
- `endSession(expectedId)` session-scoped.
- Private-host ICE: `isSafePrivateHostCandidate` / `isSafeVideoSdp` reject public/relay/IPv6/`m=audio`/`turn:`/`stun:`.
- `keep-awake` enable/disable balanced, no global lock (unit).
- `pip` subscribe emits `pip_entered/exited` (unit) and explicit viewer button.
- `IncomingRequestNotifier` show/clear lifecycle and timeout/cancel (unit).
- `isDiagnosticEvent` accepts new lifecycle/media kinds, rejects unknown; `buildDiagnosticReport` contains only `deviceIdSuffix` (8 chars), no secret/SDP/ICE.
- Product presentation `degraded`/`reconnecting 2/3`/`live`/`error Retry`.

**Proven by Expo prebuild (config):**
- `plugins/withPip.ts` adds `android:supportsPictureInPicture="true"` + `configChanges` to `MainActivity` and survives `expo prebuild --clean` (verified in `android/app/src/main/AndroidManifest.xml`). Autolinking of `expo-modules` (`expo-module.config.json` with `com.partnerscreen.*` names) passes `verify-m*autolink`.

**NOT YET PROVEN (requires Java/Kotlin compile + APK + two phones):**
- Kotlin compilation of `PartnerRequestNotificationModule.kt`, `PartnerKeepAwakeModule.kt`, `PartnerPipModule.kt` (fixed unsupported hooks), `PartnerLifecycleModule.kt`, `WebRtcEngine.java` LAN profile (`BALANCED`, 400k–2.5M, `getStats`), `PartnerScreenCaptureService.kt` (1280/20). Prebuild does **not** compile Kotlin.
- Real `MediaProjectionManager.createScreenCaptureIntent()` consent UI, `startForegroundService` with `FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION`, `stopForeground(STOP_FOREGROUND_REMOVE)`, `MediaProjection.Callback.onStop` → `capture_revoked` → `Error`.
- Actual first-frame `LIVE` (native `SurfaceViewRenderer` `onFirstFrameRendered` → `onFirstFrame` event → `rendererFirstFrame`).
- Viewer `FLAG_KEEP_SCREEN_ON` visible via `dumpsys power` and released on leave/fail/recreation.
- PiP: real `enterPictureInPictureMode(Rational)` with correct aspect on rotation, video continues rendering in PiP, `onPipModeChanged` via `isInPictureInPictureMode`/`wasInPip` tracking, return-to-app shows `Stop session`.
- Incoming request Android notification while app backgrounded (channel `partnerscreen_incoming_request`, `IMPORTANCE_HIGH`, no `fullScreenIntent`, `singleTop` tap → `IncomingRequest` UI, permission `POST_NOTIFICATIONS` denial fallback to in-app only, no secrets in text).
- WebRTC performance: 1280/20/BALANCED/0.4–2.5M is heuristic; needs A/B on real Wi-Fi with `media_stats` (bytesSent, framesPerSecond, packetsLost, jitter, rtt) to finalize; `getStats` field names (`bytesSent` etc.) may vary by report type and return `null` gracefully if unsupported — must be validated on device.
- Wi-Fi degradation: `disconnected` → `media_degraded` → `media_reconnect_attempt` 1/3 → `media_reconnected` → `LIVE` vs exhausted → `Error` → Retry.
- Partner `availability_partner_lost/found` while in `Error` → accurate offline/available and second complete session after Stop.
- Rotation/EGL leak check, `changeScreenCaptureFormat` on `onConfigurationChanged`.
- Maestro on ATD (ATD fix at `79ca7f4` still present).

> **Source and prebuild gates pass. Native Android compilation and physical qualification remain pending.** No APK/Maestro workflow was triggered.

---

## 8. Concise physical-device retest checklist (APK from `65ce02d`, same Wi-Fi)

1. `git rev-parse HEAD` → `PARTNERSCREEN_BUILD_COMMIT` → `build:dev-apk --preflight` → `build:dev-apk` → SHA-256 → install both.
2. Distinct names → `Pair QR` → restart → `availability_partner_found` → `PairedAvailable`.
3. Background receiver → partner `Request Screen`.
4. Receiver shows notification “Trusted partner … requesting your screen.” Tap → foregrounds to `IncomingRequest` (not stale).
5. `Accept` → system `MediaProjection` consent → grant.
6. `capture_started` → `media_negotiation_started` → `remote_track_attached` → `media_first_frame` → `LIVE`.
7. Viewer stays awake (10 min, `dumpsys power` `KEEP_SCREEN_ON` while viewer, cleared after).
8. Tap `PiP` → video continues in PiP; rotate sharer → aspect updates; tap PiP → return, `Stop session` visible (explicit PiP only, no surprise auto-enter).
9. Degrade Wi-Fi 5 s: `Connection degraded` → `Reconnecting private video — attempt 1/3` (LIVE off) → `Reconnected` → `LIVE` (check `media_stats` — no IP).
10. Kill Wi-Fi 15 s: 3 attempts + 5 s grace → `media_failed` → `Error` “Session stopped — tap Retry” + `Retry — clear error` + `Request Screen again` (if available).
11. Tap `Retry` → `PairedAvailable`/`PairedOffline` (pairId preserved), no restart.
12. `Request Screen again` (fresh `sessionId`) → `OutgoingRequest(B)` → accept → `LIVE` (stale `sessionIdA` ignored).
13. Rotate both → no crash, no duplicate `PeerConnection`, no leaked `VideoTrack`/`EglBase`.
14. Stop via viewer `Stop session` / sharer `Stop sharing` / notification `Stop sharing` / OS revoke → `capture_stopped/revoked` → `session_ended/error` → `Paired*`, FGS removed, `removeSink`, `peerGeneration` incremented, wake lock released, PiP closed.
15. Within 2 s `Request Screen` → new `LIVE` (idempotent stop/clear).
16. Background/foreground both apps → repeat 3–15, `activity_*` + `app_backgrounded/foregrounded` appear, no false `crash`.
17. `Open diagnostics` → copy → ordered events (`pairing_completed`, …, `viewer_opened/closed`, `pip_entered/exited`, `activity_*`, `notification_*`, `keep_awake_*`) with `deviceIdSuffix` only, `buildCommit` `65ce02d`, no SDP/ICE.
18. Security: wire shows only `c1:` sealed, `isSafePrivateHostCandidate`/`isSafeVideoSdp` reject public/relay/TURN/STUN/IPv6/`m=audio`; `blockedPermissions` includes `RECORD_AUDIO`.

---

## 9. Remaining risks / out-of-scope

- **LAN TURN:** `RTCConfiguration(empty)` + private-host filter deliberately. If AP isolates host candidates, reliability marginal but TURN would violate LAN-only.
- **Encoder heuristic:** `BALANCED` + 400k–2.5M + 1280/20 sensible but not profiled across SoCs; `MAINTAIN_FRAMERATE` may be lower latency on some devices; `SCREEN_SHARE_START_BITRATE_BPS 800k` unused (WebRTC negotiates start) — flagged for device A/B.
- **Stats:** `getStats` via `RTCStatsCollectorCallback` / `report.getStatsMap()` / `stat.getType()/getMembers()` is M124 API; if field names differ, callback returns `null` gracefully (no crash) but `media_stats` diagnostics will be absent — needs device validation.
- **PiP actions:** Return-to-app path only; no PiP `Stop sharing` RemoteAction (could add `PictureInPictureParams.Builder.setActions` later).
- **Notification permission:** On Android 13+ denial, notification silently not shown (native returns false, in-app UI remains). No extra prompt to avoid nag.
- **Lifecycle vs crash:** `activity_destroyed` (recreation) vs process death distinguished via `DiagnosticsRepository` persistence + `app_started` bootstrap; true tombstone/ANR still needs `logcat`.
- **Kotlin compile:** PiP hooks fixed to supported `OnCreate`/`OnActivityEntersForeground/Background` + `isInPictureInPictureMode`; keep-awake, lifecycle, request-notification use only `OnCreate`/`OnDestroy`/`OnActivityDestroys`/`OnActivityResult` which are verified. Compilation still pending manual lane.

**Files to review in PR:** `src/session/SessionController.ts`, `src/media/MediaSessionController.ts`, `src/presentation/ProductPresentation.ts`, `modules/partner-screen-capture/.../WebRtcEngine.java` & `PartnerScreenCaptureService.kt`, `modules/partner-*-*/**`, `plugins/withPip.ts`, `src/request/IncomingRequestNotifier.ts`, `app/*`, `src/platform/*`, `src/domain/diagnostics/*`, `tests/stabilization.test.ts`, `scripts/verify-m7.mjs`, `package.json`.

No `android/`, APK, or signing material committed.

