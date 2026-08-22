# CHIRP DEEP AUDIT

Branch: `arena/01a02a03-chirp` (off `main` @ `0c52df3`)

Audited source tree: current Chirp `main` (react-native-webrtc 124.0.8, five `chirp-*` Kotlin Expo modules).

## Scope note on reference artifacts

Two reference documents were named in the brief:

- `partnerscreen-vdo-ninja-webrtc-report.md`
- `partnerscreen-vs-vdoninja-repo-architecture.md`

Neither file exists anywhere reachable from this environment: not in the working tree, not in any commit/branch/PR of `0xShroud-GIT/Chirp`, and not in the other repositories under the account. The VDO.Ninja 5.0.91 XAPK could not be downloaded: the sandbox egress resets TLS to every APKPure/APKCombo/CDN host (`SSL_ERROR_SYSCALL`), and the server-side fetch tool returns HTTP 500 for the binary endpoint. What was obtainable:

- The APKPure and APKCombo **listing pages** (package, version 5.0.91, size, permission list, "what's new").
- The **in-repo historical reference documents** that describe the pre-Chirp PartnerScreen baseline and its VDO.Ninja findings: `docs/architecture.md`, `docs/android-media.md`, `docs/product.md`, `STABILIZATION_REPORT.md`, `docs/v2/V2_ARCHITECTURE_BLUEPRINT.md`, `docs/v2/sources/ZeroLink_2.1_PartnerScreen_Harvest_Report.md` (recovered from PR history — these were deleted from `main` by the "clean runtime" squash).

Section 4 reconciles against the material issues in those available reference documents. Every claim below is traced to current source, not to the old reports.

---

# 1. Executive verdict

**Is current Chirp physically testable? — YES.**

A fresh-install → name → pair → discover → request → accept → MediaProjection → WebRTC → first frame → stop → second-session path is fully wired end-to-end in source, and every required primitive is invoked by a production call path (verified arrow-by-arrow in §3). The security model (authenticated pairing, HMAC-authenticated control, AES-GCM-sealed signaling, private-IPv4-only host candidates, no TURN/STUN/cloud/audio/microphone) is intact and fail-closed. `npm ci`, hygiene, typecheck, and 104 tests pass; `expo prebuild` produces a manifest with `RECORD_AUDIO`/`SYSTEM_ALERT_WINDOW` removed and the MediaProjection foreground service enabled.

Three concrete defects were confirmed and fixed at root cause (see §8), all below "next physical run cannot complete":

- **P2** — "Share my screen" double-invoked the capture start primitive (`useSession.acceptRequest` started sharing *and* `Home`'s accept flow started it again), producing a misleading failure message when the owner simply declined the Android consent prompt.
- **P2** — a technical `getDisplayMedia` failure (e.g. `AbortError` starting the MediaProjection service) was misreported to the partner as "did not grant permission", collapsing "user denial" and "technical capture failure" into one code path.
- **P3** — `userInterfaceStyle: 'automatic'` is declared without `expo-system-ui`, so the dark-only app does not drive Android system chrome (status/nav bar) in light system mode.

---

# 2. Release blockers

| Severity | Area | User-visible failure | Root cause | Exact files | Evidence | Fix |
|---|---|---|---|---|---|---|
| P2 | Media ownership | Owner who declines the Android capture prompt sees "Chirp could not start screen sharing. Check Diagnostics…" instead of a clean return to paired state | `useSession.acceptRequest` invoked `mediaSession.startSharing()`, and `Home.acceptAndStartSharing` invoked it again; the second call throws after the first already handled denial | `src/presentation/useSession.ts`, `app/index.tsx` | Traced: `acceptRequest()` → `sessionController.acceptRequest()` + `mediaSession.startSharing()` (1st, swallows denial) → `media.startSharing()` (2nd, throws `not Connected`) → misleading `actionError` | `acceptRequest` now only moves the product session to `Connected`; `Home` owns accept→`startSharing` exactly once |
| P2 | Capture failure classification | Partner is told "did not grant permission" when the sharer's capture actually failed technically (service start failure, null screen track) | `startSharing` treated *every* `getDisplayMedia` rejection as `system_denied` | `src/media/MediaSession.ts` | react-native-webrtc rejects with `DOMException` `NotAllowedError` (denial) vs `AbortError`/runtime messages (failure); both were routed to `captureDenied('system_denied')` | New `classifyDisplayMediaError`; denial → `captureDenied`, else → `fail(…,'capture_failed')` |
| P3 | System UI theme | In light system mode the dark-only app does not match Android status/nav bar chrome | `userInterfaceStyle: 'automatic'` declared but `expo-system-ui` not installed (prebuild warns) | `app.config.ts`, `package.json` | `expo prebuild` output: "userInterfaceStyle: Install expo-system-ui…"; all screens hardcode dark palette | Documented; low-risk (app is dark-styled end-to-end) — see §9/§10 |
| P3 | Dead control | "Open viewer" button on Home is unreachable (requester is auto-navigated to `/viewer` on `Connected`) | Auto-navigation `useEffect` fires before the button can be pressed | `app/index.tsx` | `useEffect` replaces to `/viewer` whenever `Connected && role==='requester'` | Left in place as a harmless manual fallback; documented |
| P3 | Diagnostics surface | `MediaSession` `error` state is immediately overwritten to `idle` by `resetMedia` inside `fail()`, so the media error string is effectively transient | `fail()` sets `error` then calls `resetMedia(false)` | `src/media/MediaSession.ts` | Product `Error` (SessionController) is the durable error surface; media error text is a flash | Documented (no behavior change needed) |

No P0 (next physical run cannot complete) or P1 (major reliability failure) was found. The P2 items are fixed with regression gates.

---

# 3. Full user-flow trace

Every arrow is marked PASS/FAIL against current source. "PASS" means the arrow invokes the required primitive on a real production path.

### Fresh install → identity → naming → pairing availability

1. App launch → `app/_layout.tsx` effect → `pairingService.initialize()` + `diagnosticsRepository.append('app_started')` — **PASS**.
2. `Home` renders `useLocalIdentity()` → `LocalIdentityService.bootstrap()` → `IdentityRepository.bootstrapOnce()` — creates a stable `deviceId` with `deviceName: null` and persists it — **PASS**.
3. `deviceName === null` → Home shows the "name this phone" card (not "Unknown"; hygiene asserts no `Unknown` literal) — **PASS**.
4. Save name → `LocalIdentityService.rename()` → `normalizeDeviceName()` (trim, collapse whitespace, ≤64 chars) → persisted; validation rejected / storage error are surfaced via `identity.error` — **PASS**.
5. Corrupt stored identity → `IdentityRepository` throws `IdentityPersistenceError` ("Refusing to silently rotate the device ID") → Home shows "This phone could not be prepared" + Retry; it does **not** mint a second identity — **PASS**.
6. Restart → `bootstrap` reads persisted identity, preserves name/id — **PASS**.
7. Pairing entry gated: `PairingService.requireNamedLocalIdentity()` throws unless `deviceName` is set; Home only offers "Show pairing QR"/"Scan pairing QR" after a name exists — **PASS**.
8. No loading state hangs forever: identity bootstrap has a single in-flight promise; persistence failures resolve to a visible error card — **PASS**.

### Pairing (two phones, both traced)

9. A: `Show pairing QR` → `PairingService.startCreator()` → `startListener()` (Wi-Fi-bound), QR with `bootstrapKeyHex` (one-time, never persisted as trust), TTL expiry — **PASS**.
10. B: `Scan pairing QR` → camera permission (`expo-camera`), `startScanner(rawQr)` → `parsePairingQr` (validates TTL, self-pair via `localDeviceId`, already-paired) → `transport.connect` → `PAIR_HELLO` — **PASS**.
11. A→B `PAIR_IDENTITY`, B→A `PAIR_IDENTITY`; both authenticate the peer against the QR/attempt, reject self-pair and identity change (`senderDeviceId` recheck) — **PASS**.
12. B confirms → `PAIR_CONFIRM`; A confirms → stages/commits a 2-phase `PAIR_COMMIT`/`PAIR_COMMIT_ACK` (scanner_staged → creator_ready → scanner_committed → creator_committed → scanner_confirmed → creator_confirmed → converged) with durable `stage`/`installCommitted`/`markConfirmed` — **PASS** (converges; provisional secret is in SecureStore pending slot and is discarded on abort).
13. Both persist trust → `PairTrustRepository` (metadata in AsyncStorage, secret in SecureStore); scanner sends final `converged` only after `loadConfirmed()` — **PASS**.
14. Pairing transport closes before availability/control activate: `cleanupAttempt({keepDurablePair:true,preserveState:true})` before `paired` state; `AppServices` subscribes to `paired` → `sessionController.activatePair` + `availabilityService.activate` — **PASS**.
15. Restart both → `initialize()` → `discardIncomplete()` + `loadConfirmed()` → `paired` — **PASS**.
16. Cancel/replay/malformed/expiry/self-pair/already-paired/one-side-close → `PairingReplayGuard`, `PairingStateMachine` transitions, `scheduleExpiry`, `failAttempt` + fail-closed cleanup (`abortPairAttempt`) — **PASS** (no asymmetric phantom trust: a pair is only "confirmed" after the converged handshake, and `markConfirmed` is last).
17. Storage failure during commit → `stage`/`installCommitted` roll back pending/durable material and surface `PairTrustPersistenceError` → visible error — **PASS**.

### Trusted discovery / availability

18. `paired` → `availabilityService.activate(pair)` → `prepareAdvertisement()` (NSD probe ServerSocket bound to Wi-Fi) → `controlListener.ensureListening(preparation.host)` → HMAC `peerHint` + `proof` (proves control port) → NSD register + discover — **PASS**.
19. Resolved service → `verifyPeerHint` + `verifyProof` + `extractControlPort` → only then `probe(host, controlPort)` → only then `available` — **PASS** ("available" = authenticated + reachable, not merely discovered).
20. Stale NSD echo / new control port for same service → demoted to `offline` until re-proven — **PASS**.
21. Service lost / local error → `offline` (fail-closed) — **PASS**.
22. Self advertisement rejected (`serviceName === localServiceName`, `host/port/nonce === own preparation`) — **PASS**.
23. Wi-Fi change → `subscribeListenerChanges` → forced re-activation rebinds listener/advertisement; `AvailabilityService` re-runs `activateNow(pair, true)` — **PASS**.
24. Stale async resolution cannot resurrect old endpoint: `generation`/`probeGeneration` guards in `handleResolved`/`proveExactControlEndpoint` — **PASS**.

### Screen request → accept → MediaProjection → WebRTC → first frame

25. Requester presses "View their screen" (only in `PairedAvailable`) → `SessionController.requestScreen()` → `control.connect(endpoint)` (authenticated initiator) → `send('REQUEST_SCREEN', {expiresAt})` → `OutgoingRequest` + timeout — **PASS**.
26. Sharer receives `REQUEST_SCREEN` → `handleMessage` validates expiry → `PendingRequestStore.save` → `IncomingRequest` + timeout + `IncomingRequestNotifier.showRequestNotification` (background ingress) — **PASS**.
27. Owner presses "Share my screen" → `Home.acceptAndStartSharing` → `session.acceptRequest()` → `SessionController.acceptRequest()` sends `ACCEPT_SCREEN`, state `Connected(sharer)` → **then** `media.startSharing()` — **PASS** (the capture-start linkage is now single-owner; this was the P2 fix).
28. `MediaSession.startSharing()` → `getDisplayMedia({android:{createConfigForDefaultDisplay:true, resolutionScale}})` → Android MediaProjection consent → foreground service (`enableMediaProjectionService=true` in MainActivity; library manifest `MediaProjectionService` `foregroundServiceType="mediaProjection"`) → video track — **PASS**.
29. Track `onended` wired → `captureFailed('capture_revoked')`; denial classified separately from technical failure (P2 fix) — **PASS**.
30. `createPeer` → `addTrack` → `configureSender` (min/max bitrate, maxFramerate, `degradationPreference='maintain-resolution'`) → `sendOffer` → `SDP_OFFER` — **PASS**.
31. Requester `Connected(requester)` → `MediaSession.syncSession()` creates recvonly peer → receives `SDP_OFFER` → `setRemoteDescription` → flush buffered ICE → `createAnswer` → `setLocalDescription` → `SDP_ANSWER` — **PASS**.
32. Sharer receives `SDP_ANSWER` → `setRemoteDescription` → flush → `forceKeyframe` — **PASS**.
33. ICE exchange: both peers filter candidates through `classifyIceCandidate` (private IPv4 UDP host only); early ICE buffered in `pendingRemoteCandidates` until remote description — **PASS**.
34. Connection `connected` → sharer `live`; requester stays `connecting` until first frame — **PASS** (no false "Live").
35. First decoded frame: `collectStats` sees `framesDecoded > 0` on inbound-rtp → `firstFrameSeen` → `live` (only when `connectionState === 'connected'`) + `media_first_frame` — **PASS**.
36. Keyframe recovery: requester sends `MEDIA_KEYFRAME_REQUEST` with backoff then steady retry (no exhaustion→ICE escalation); sharer `forceKeyframe` toggles `track.enabled` — **PASS** (matches the §7 requirement; react-native-webrtc exposes no sender `generateKeyFrame`, so the toggle is the only primitive).
37. Viewer displays `RTCView` bound to `remoteStreamURL` — **PASS**.

### Disconnect / recovery → stop → second session

38. ICE `disconnected` → 3 s grace → `scheduleRecovery`; `failed` → immediate recovery; restart uses `createOffer({iceRestart:true})` on the sharer, or `MEDIA_RESTART_REQUEST` from the requester — **PASS**.
39. Control transport blip → `ControlSession.beginReconnect` emits `reconnecting` (ignored by SessionController, so product session survives) → re-auth via fresh hello1/hello2 → `reconnected`; only a **failed** reconnect emits `error`/`closed` which ends the product session — **PASS** (matches §10).
40. Stop paths (End / Stop sharing / decline / cancel / revoke / remote SESSION_END / media fail) → `MediaSession.resetMedia` (tracks stopped, peer closed, timers cleared, `remoteStreamURL` cleared, candidates cleared) + `SessionController` returns to base paired state; keep-awake released on unmount — **PASS**.
41. Second session: after stop, state is `PairedAvailable/Offline`, `control.close()` was called, listener remains, and a fresh `connect` produces a fresh sessionId — **PASS** (covered by `session-controller` tests).

**Result: no FAIL arrow found.** Two arrows were hardened (27 and 29) as part of this audit.

---

# 4. Reference reconciliation

Reference documents used (recovered from PR history; the two originally named `.md` files are not present — see scope note). Status per material issue:

| Reference issue (from PartnerScreen docs) | Status | Current Chirp evidence |
|---|---|---|
| LAN profile 1280px/20fps/0.4–2.5Mbps/BALANCED (STABILIZATION_REPORT #1/#2) | **INTENTIONAL DIFFERENCE** | `MediaPolicy.ts` now `SCREEN_LONG_EDGE_PX=1600`, `SCREEN_FPS=30`, `1_000_000..8_000_000 bps`, `maintain-resolution` (hygiene-enforced). This is the deliberately high-quality LAN profile the brief requires; not a regression. |
| `MAINTAIN_RESOLUTION` held 1600px under congestion (old poor quality) | **FIXED** | `configureSender` sets `degradationPreference='maintain-resolution'` but caps `maxFramerate=30` and allows the WebRTC TCC/REMB to cut bitrate; `scaleResolutionDownBy=1` with capture already scaled to 1600 long-edge. |
| No stats / no first-frame truth | **FIXED** | `MediaSession.collectStats` parses outbound/inbound-rtp, candidate-pair, remote-inbound-rtp (framesDecoded/Encoded, keyFrames, nack/pli/fir, bitrate, jitter, RTT, codec, impl, qualityLimitationReason); `DiagnosticsReport` sanitizes them. |
| `Error` terminal blocked `updateAvailability`; stale `sessionId` killed replacement session | **FIXED** | `SessionController` early-stale-ignore in `handleMessage` (`isActiveProductState && message.sessionId !== active.sessionId` → return), `clearError()`, `endSession(expectedSessionId)` guards, fresh `randomId()` per `connect`. |
| No incoming-request notification while backgrounded | **FIXED** | `chirp-request-notification` module (channel `chirp_incoming_request`, `IMPORTANCE_HIGH`, `singleTop`+`CLEAR_TOP`, `FLAG_IMMUTABLE`, `POST_NOTIFICATIONS` checked) + `IncomingRequestNotifier` + cold/warm ingress via `chirp://incoming-request/{id}` + `IncomingRequestIngress` dedup. |
| No PiP | **NO LONGER APPLICABLE** | Chirp deliberately drops PiP (not in current `app/` or `modules/`); hygiene forbids the `partner-pip` path. Not a product requirement for the current boundary. |
| Viewer dims / no wake lock | **FIXED** | `expo-keep-awake` (`chirp-viewer` in viewer, `chirp-sharer` only while `Connected(sharer)`), released on unmount; hygiene-enforced. |
| Duplicate error text / safe-area overlap / off-screen buttons | **FIXED** | `SafeAreaView edges=['top','bottom']`, 50dp buttons, single header (`headerShown:false` on index; hygiene asserts no duplicate Stack header and no `Unknown`). |
| Stale callbacks killing replacement session | **FIXED** | `MediaSession` guards every callback with `peerSessionId === sessionId` + `this.peer === peer`; `closePeer` nulls handlers before `close()`; generation tokens in `AvailabilityService`. |
| First-frame ≠ LIVE | **FIXED** | Requester `live` requires `framesDecoded > 0` AND `connectionState === 'connected'`; `onTrack`/ICE alone never set `live`. |
| Keyframe failure escalating into ICE restart | **FIXED** | `scheduleKeyframeRecovery` uses backoff → steady 5 s retry with no counter that escalates to `scheduleRecovery`; hygiene asserts the exhaustion→ICE pattern is absent. |
| Control reconnect killing product session | **FIXED** | `handleControlEvent` ignores `reconnecting`/`reconnected`; only `error`/`closed` terminate. `ControlSession` re-authenticates on reconnect via fresh nonces. |
| Reconnect attempts burning during signaling outage | **FIXED** | Media recovery retries use `MEDIA_SIGNAL_RETRY_MS` and only advance `restartAttempt` on real restart; `sendMedia` failure during reconnect throws and is caught without burning ICE-restart budget in a way that ends the session. |
| Raw cleartext TCP / PIN trust / secret in logs (ZeroLink reject list) | **FIXED / PRESENT (rejected)** | Pairing uses `bootstrapKeyHex` AES-GCM sealing + HMAC; control uses `AuthenticatedSignalingCipher` (AES-GCM + HMAC hello1/hello2 + session key derivation); diagnostics sanitized; no PIN. |
| WebRTC invariants: track-before-offer, early-ICE queue, stale SDP/ICE guards, fresh reconnect | **FIXED** | All present in `MediaSession` (see §6). |
| `RECORD_AUDIO` / `SYSTEM_ALERT_WINDOW` absent | **FIXED** | `app.config.ts blockedPermissions` + `withChirpWebRtc` strip + `build-apk.sh` verification; prebuild manifest shows `tools:node="remove"`. |
| MediaProjection: consent → FGS → exactly-one capture | **FIXED** | `getDisplayMedia` native path launches `MediaProjectionService` (`enableMediaProjectionService=true`), single video track, no audio, `onended` → revoke. |
| `android/` generated, not patched as source | **FIXED** | `.gitignore` ignores `/android/`; all config in `app.config.ts` + plugins; hygiene forbids committed native-media artifacts. |

---

# 5. VDO XAPK findings

**Download status:** the 5.0.91 XAPK could not be retrieved (egress blocks every APKPure/APKCombo/CDN TLS handshake; server-side fetch of the binary returns HTTP 500). No binary was decompiled. Findings are therefore limited to what the storefront listing pages expose, and are labeled accordingly.

### CONFIRMED FROM XAPK (binary evidence)

None. No binary was obtained.

### SUPPORTED BY REPORT ONLY (storefront listing pages, not the binary)

- Package `flutter.vdo.ninja`, version `5.0.91` (versionCode 91), ~28 MB, `armeabi-v7a` listed (APKCombo) / `arm64-v8a` + `sv=21` variant (the requested download URL), minSdk Android 5.0+.
- Permission surface includes `RECORD_AUDIO`, `CAMERA`, `WAKE_LOCK`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_CAMERA`, `CAPTURE_VIDEO_OUTPUT`, `POST_NOTIFICATIONS`, `BLUETOOTH*`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `RECEIVE_BOOT_COMPLETED`, `VIBRATE`, `USB_PERMISSION`, plus a `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
- "What's new" (Jul 2026): "Restored Android app-specific screen sharing where supported", "Improved camera startup/switching", "Tightened signaling/state handling", "Improved screen-share and audio track handling".

### INFERENCE

- VDO.Ninja is a Flutter app with a materially different product boundary (camera + microphone, cloud signaling, STUN/TURN, background streaming, recording) — the listed permissions (`RECORD_AUDIO`, microphone/camera foreground-service types, cloud signaling) confirm it is **not** a model for Chirp's LAN-only, no-audio, no-cloud boundary. Nothing in the listing contradicts Chirp's intentional divergence.
- The requested URL's `nc=arm64-v8a&sv=21` confirms VDO ships a 64-bit arm64 build, consistent with Chirp's `arm64-v8a`-for-physical-phones decision.

No VDO behavior was copied.

---

# 6. State / ownership map

| Domain | Owner (creator) | Destroyers / terminal transitions | Notes |
|---|---|---|---|
| Product session | `SessionController` (single `state` machine: Unpaired/PairedOffline/PairedAvailable/OutgoingRequest/IncomingRequest/Connected/Error) | `endSession`, `decline/cancel/finishRequest`, `captureDenied`, `failConnectedSession`, `handleMessage` (SESSION_END/ERROR/CANCEL), control `error`/`closed`, timeout | Only SessionController decides "user-visible session over". |
| Control connection | `ControlSession` (`active`/`resumeSessionId`, one connection) | `close()`, `deactivate()`, transport `closed`/`error`/busy, handshake timeout | Reconnect (`beginReconnect`) does **not** end the product session; only `failReconnect` (→ `error`+`closed`) does. |
| Media session | `MediaSession` (`peer`, `localStream`, `remoteStream`, `remoteStreamURL`) | `stop()`, `resetMedia`, `fail`, `syncSession` on non-Connected, `dispose` | Scoped by `peerSessionId`; stale callbacks guarded. |
| MediaProjection / capture | react-native-webrtc `getDisplayMedia` + `MediaProjectionService` (library) | `track.onended` (OS revoke/stop), `resetMedia` track.stop, service stop on module teardown | `enableMediaProjectionService=true` set in MainActivity by `withChirpWebRtc`. |
| PeerConnection | `MediaSession.createPeer`/`closePeer` | `resetMedia`, `fail`, `dispose` | Handlers nulled before `close()`. |
| RTCView | `app/viewer.tsx` (`remoteStreamURL`) | unmount / `remoteStreamURL=null` | URL cleared on `resetMedia`. |
| Notifications | `IncomingRequestNotifier` + `chirp-request-notification` | `sync` on non-IncomingRequest, `dispose` | Generation-guarded; cleared on accept/decline/cancel/timeout/connected. |
| Discovery | `AvailabilityService` + `ChirpDiscoveryModule` | `deactivate`, `stopActive`, Wi-Fi/interface change (forced re-activation) | `generation`/`probeGeneration` guards. |

---

# 7. Async / race audit

Every asynchronous callback/timer in the media/control/availability path is generation-guarded:

- **MediaSession**: every `onicecandidate`/`ontrack`/`onconnectionstatechange` callback first checks `this.peerSessionId === sessionId` and (for state) `this.peer === peer`; `closePeer` nulls the handlers before `peer.close()`, so a late callback from a replaced peer is a no-op. `pendingRemoteCandidates` is cleared on peer creation. `disconnectedTimer`/`restartTimer`/`keyframeTimer`/`statsTimer` are all cleared in `resetMedia`. `forceKeyframe`'s delayed re-enable re-checks `peerSessionId` and track identity. All mutations run through `operationQueue` so `syncSession`/`handleSignal` are serialized (an offer can't race the requester's peer creation).
- **ControlSession**: all transport events and sends serialize through `operationQueue`; `active`/`resumeSessionId` are the generation tokens; `armHandshakeTimeout` re-checks `this.active === active`; reconnect schedules re-check `resumeRole`/`active` before reopening. `MessageValidator` (replay guard + sequence) rejects replayed/out-of-order/stale messages.
- **SessionController**: all mutations serialize through `operationQueue`; `scheduleTimeout` re-checks `sessionId` before acting; `handleMessage` ignores messages whose `sessionId` mismatches an active session; `endSession(expectedSessionId)` is idempotent and session-scoped.
- **AvailabilityService**: `generation` + `probeGeneration` tokens invalidate stale resolutions/probes; `activateNow(force)` re-binds on listener change.
- **IncomingRequestNotifier**: `desiredGeneration` tokens discard stale `show`/`clear` completions.
- **PairingService**: `pairAttemptId` + `connectionId` checks reject stale frames/connections; `ReplayGuard`; expiry timer re-checks attempt identity.

No unguarded stale callback was found.

---

# 8. Fixes made

### Commit 1 — media/capture start is owned exactly once

- **Defect**: "Share my screen" reached `startSharing()` twice (once via `useSession.acceptRequest`, once via `Home.acceptAndStartSharing`). On user denial the second call threw and surfaced a misleading failure.
- **Root cause**: accept + capture-start ownership was split across two call sites with no single authority.
- **Correction**: `src/presentation/useSession.ts` — `acceptRequest` now only performs `sessionController.acceptRequest()` (moves product session to `Connected(sharer)`); `app/index.tsx` `acceptAndStartSharing` is the single owner of `acceptRequest()` → `media.startSharing()`.
- **Regression protection**: `scripts/check-hygiene.mjs` fails if `useSession.ts` references `mediaSession.startSharing`.

### Commit 1 — user denial vs technical capture failure

- **Defect**: any `getDisplayMedia` failure was reported to the partner as "did not grant Android screen sharing permission", even for technical failures (MediaProjection service start `AbortError`, null screen track, etc.).
- **Root cause**: a single catch collapsed two semantically different outcomes.
- **Correction**: `src/media/MediaPolicy.ts` adds `classifyDisplayMediaError(error)` (`NotAllowedError` → `user_denied`, else `capture_failed`); `src/media/MediaSession.ts` routes denial → `captureDenied('system_denied')`, technical failure → `fail(…,'capture_failed')` (which emits `SESSION_ERROR { reason:'capture_failed' }`).
- **Regression protection**: `tests/media-policy.test.ts` — new behavioral test covering `NotAllowedError` (all surfacing shapes) vs `AbortError`/arbitrary-message/`undefined`/`null`.

---

# 9. Validation

Run from a clean checkout on `arena/01a02a03-chirp`:

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | PASS (647 packages) |
| `npm run check:hygiene` | PASS — "Hygiene OK: 140 tracked files checked" |
| `npm run typecheck` (`tsc --noEmit`) | PASS |
| `npm test` (`tsx --test tests/*.test.ts`) | PASS — 104/104 (103 pre-existing + 1 new) |
| `npm run ci` | PASS (hygiene + typecheck + test) |
| `CI=1 npx expo prebuild --platform android --no-install` | PASS — manifest verified below |

**Prebuild/manifest inspection** (`android/app/src/main/AndroidManifest.xml`):

- `android.permission.RECORD_AUDIO` → `tools:node="remove"` ✓
- `android.permission.SYSTEM_ALERT_WINDOW` → `tools:node="remove"` ✓
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` ✓
- `CAMERA`, `POST_NOTIFICATIONS`, `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE`, `CHANGE_WIFI_MULTICAST_STATE` ✓
- `chirp://` deep-link intent-filter ✓; `allowBackup=false` ✓; `launchMode=singleTask` ✓
- `MainActivity.kt` has `WebRTCModuleOptions.getInstance().enableMediaProjectionService = true` ✓
- library manifest declares `MediaProjectionService` with `foregroundServiceType="mediaProjection"` ✓

**Release APK build** (`npm run build:apk`): **not runnable in this sandbox** — no JDK/Android SDK/Gradle. The build is exercised by `.github/workflows/build-apk.yml` (checks out the PR head SHA, sets `CHIRP_BUILD_COMMIT`, runs `npm run ci` + `build:apk`, uploads `chirp-qualification-apk`). `scripts/build-apk.sh` additionally enforces: `:app:assembleRelease` (never debug/Metro), `assets/index.android.bundle` present and >100 KB, `com.chirp.app`, ABIs exactly `{arm64-v8a, x86_64}`, `libjingle_peerconnection_so.so` per ABI, `buildCommit` embedded and equal to the source SHA, and `RECORD_AUDIO`/`SYSTEM_ALERT_WINDOW` absent from the merged manifest. These checks were not re-run here and remain CI-verified only (see §10).

---

# 10. Remaining physical-only tests

Items that cannot truthfully be proven from source/CI and require two physical Android phones on the same Wi-Fi (plus an emulator pair for the x86_64 lane):

1. Actual `gradle assembleRelease` + install + standalone launch (no Metro) — source/config gates pass, but the native compile and Hermes bundle behavior can only be proven in CI or on-device.
2. `getDisplayMedia` `resolutionScale` long-edge behavior and encoder output on real SoCs (Pixel/Samsung/etc.) — the native `ScreenCaptureController` multiplies `width/height` by `resolutionScale`, but real captured dimensions/`frameWidth` must be read from `media_stats` on device.
3. `forceKeyframe` toggle actually produces a keyframe on each device's encoder (the toggle is the only primitive react-native-webrtc exposes; effectiveness is hardware-dependent).
4. `framesDecoded`/`keyFramesDecoded`/`nackCount`/`pliCount`/`firCount`/`qualityLimitationReason` field names in the **actual** M124 `getStats` report shape (parsing is defensive and yields `n/a` rather than crashing, but presence must be validated on device).
5. Wi-Fi degradation/recovery: real `disconnected`→grace→ICE-restart→`reconnected`; AP isolation (host candidates filtered — if the AP isolates clients, media cannot connect by design, no TURN fallback).
6. MediaProjection lifecycle: OS "Stop casting" revoke → `track.onended`; rotation while sharing; app background/resume mid-session; process recreation; duplicate-projection protection under real Android 14/15.
7. Background incoming request: cold-start notification tap → `IncomingRequest` (stale-ID dedup), warm-app `OnNewIntent`, notification-channel-disabled fallback to in-app only.
8. Notification permission denied / "never ask again" → settings recovery; channel re-enable.
9. Pairing across two real devices: QR scan, camera deny/deny-permanently/settings recovery, expiry, double-tap, one phone closed mid-pair, Wi-Fi drop mid-pair.
10. Second full session immediately after Stop (stop/start cycles) with no leaked PeerConnection/VideoTrack/EGL surface.
11. Keep-awake actually cleared after viewer/sharer unmount (`dumpsys power`).
12. System font scaling / small screens / landscape rendering of every route.
13. Diagnostics report does not contain pair secret/QR/SDP/ICE/SSID/BSSID/full device ID (source-level sanitization is in place; visual confirmation on device).
14. Dark/light system-mode mismatch of status/nav bar (the P3 `userInterfaceStyle` item) — cosmetic, verify on device.
