# PartnerScreen V2 Roadmap

**Purpose:** one execution plan for the next PartnerScreen milestones. Keep this file short; detailed evidence lives in `STABILIZATION_REPORT.md` and the ZeroLink teardown.

**Order is mandatory:** stabilize first → Wi-Fi Direct → UX/media improvements.

## Product invariants

Do not trade these away to gain reliability:

- One explicitly paired trusted partner.
- LAN/local transport only; no cloud relay, TURN, public ICE, audio, recording, or remote control.
- Android MediaProjection consent remains mandatory.
- WebRTC remains the primary encrypted media transport.
- Session IDs, stale/replay guards, private-host validation, and sanitized diagnostics remain intact.
- Never log/display pairing secrets, raw SDP/ICE, full IPs, or screen content.
- APK + Maestro qualification stays manual; normal work runs only the source gate.

---

# V2.0 — Make the current app deterministic

**Goal:** no force-stop recovery, no indefinite Connecting/Reconnecting, native code compiles, and diagnostics tell the truth.

Do this before adding Wi-Fi Direct.

### Fix now

1. **Native compile blocker**
   - Change modern WebRTC stats call to `pc.getStats(callback)`.
   - Verify all new Kotlin/Java modules against the actual Jitsi WebRTC M124 APIs.

2. **Deterministic media deadlines**
   - Add an overall initial-negotiation deadline.
   - Give every reconnect attempt its own absolute deadline independent of WebRTC callbacks.
   - Three bounded attempts only; exhaustion must return to a usable Retry/Request-again state.

3. **One coordinated recovery path**
   - Discovery updates must not silently clear `SessionController.Error`.
   - Recovery must reset session + control + pending request + media + capture + renderer/notification state together while preserving the trusted pair.
   - Replacement session gets a fresh `sessionId`; stale old-session events remain ignored.

4. **Immediate Stop → new session**
   - Fix the capture-service race where a new start can arrive while the previous service is still stopping.
   - A new capture request must either start or return an explicit retryable error; never disappear silently.

5. **Incoming request notification completion**
   - Request `POST_NOTIFICATIONS` at an appropriate app moment, not only when capture starts.
   - Notification tap must route to the matching incoming request.
   - Serialize/generation-guard notification show/clear operations so request A cannot overwrite request B or reappear after cancellation.

6. **Finish PiP correctly**
   - Use real remote video dimensions/rotation for PiP aspect ratio.
   - PiP-only UI must be minimal.
   - Session end/failure must leave PiP cleanly.

7. **Make media diagnostics real**
   - Wire `getMediaStats()` into the production media controller.
   - Persist only an allow-listed sanitized payload.
   - Record useful values where supported: bitrate/bytes, packet loss, RTT, jitter, FPS, frames encoded/decoded/dropped, NACK/retransmission/PLI/FIR counters, selected codec/candidate type, reconnect attempt/outcome.
   - Never persist raw stats objects, IPs, SDP or candidate bodies.

8. **Correct media-profile claims**
   - Either implement the intended start/current bitrate with supported APIs or remove the unused 800 kbps claim.
   - Check and surface failure from `sender.setParameters()` rather than assuming it applied.
   - Make `degraded` a real reachable product state or remove the misleading state.

9. **Diagnostics truthfulness**
   - Record keep-awake success only when native enable actually succeeds.
   - Treat lifecycle events as lifecycle evidence, not crash detection.
   - Physical `logcat` remains required to prove a native/JS crash.

### Freshness rule to add during V2.0

ZeroLink's strongest lesson is **freshness over backlog**: it captures the latest image, keeps only a tiny pending queue, and drops old frames instead of showing stale history.

PartnerScreen must keep WebRTC, but adopt the invariant:

> An obsolete screen frame is less valuable than a newer lower-quality frame.

Instrument frame/backpressure age where the current WebRTC APIs permit. Prefer reducing bitrate/FPS/resolution and dropping obsolete work over accumulating multi-second latency.

### V2.0 gate

Before moving on:

- Source gate green.
- One manual native APK build green.
- Maestro green.
- Two-phone test proves: request notification, consent, first frame, keep-awake, PiP, rotation, degraded/reconnect, retry without force-stop, Stop→immediate new session.
- Capture/log diagnostics during poor Wi-Fi.
- Confirm actual negotiated NACK/RTX/RED/ULPFEC capabilities without storing SDP.

**Do not enable FEC yet.** Measure packet loss, RTT, NACK/RTX/retransmissions and frame freshness first. On a low-RTT LAN, extra FEC can waste bandwidth and worsen congestion.

---

# V2.1 — Wi-Fi Direct

**Goal:** PartnerScreen works phone-to-phone without a router while keeping the existing trust/security model.

ZeroLink proves Wi-Fi Direct is the highest-value connectivity feature to harvest.

### Architecture

`trusted PartnerScreen pair → establish/select Android Wi-Fi Direct Network → bind discovery/control/WebRTC to that Network → encrypted WebRTC session`

Wi-Fi Direct is a **network path**, not a new pairing model.

### Implement

1. Native Wi-Fi Direct coordinator.
2. Android 13+ `NEARBY_WIFI_DEVICES` permission flow with older-version compatibility.
3. Group-owner/client create, join, cancel, teardown and BUSY retry handling.
4. Bind sockets/discovery/WebRTC network operations to the selected Android `Network` where required.
5. Run the existing authenticated availability/control protocol over the P2P network.
6. Ensure WebRTC produces/accepts only valid private host candidates on the P2P interface; no TURN/STUN/public/relay fallback.
7. Preserve current trusted pair and request/accept/MediaProjection flow.
8. Clear UX for:
   - Same Wi-Fi available.
   - Wi-Fi Direct required.
   - Connecting direct.
   - Direct connection failed/retry.
   - Internet may temporarily be unavailable while Direct mode owns Wi-Fi.
9. Cleanly return from P2P to normal Wi-Fi without poisoning future discovery/sessions.
10. Optional QR may bootstrap the **network path**, never replace persistent trust or expose a durable secret.

### V2.1 gate

Two physical Android vendors/devices must pass:

- No router/hotspot scenario.
- Same-Wi-Fi → Direct fallback.
- Direct → normal Wi-Fi teardown/recovery.
- Rotate/background/PiP during Direct session.
- Temporary P2P loss and reconnect.
- Stop → immediate new Direct session.
- No public/relay candidate regression and no secret leakage.

---

# V2.2 — Make viewing feel better

Only after V2.0 and V2.1 are stable.

1. **Viewer zoom/pan**
   - Pinch zoom, pan, Fit/reset; reset transform when stream geometry changes.

2. **Rotation resilience**
   - Rotation must never require a new trusted/session flow.
   - Preserve renderer/session ownership and correct PiP/video aspect.

3. **Stream profiles, only if field data justifies them**
   - Prefer human labels: `Low latency`, `Balanced`, `Sharper text`.
   - WebRTC congestion control remains active; do not expose raw codec knobs by default.

4. **Scoped network-lifetime experiment**
   - A/B test a Wi-Fi lock only during active media.
   - Keep it only if physical disconnect/recovery data materially improves.
   - Do not add a permanent/global CPU wake lock.

5. **Latency targets**
   - Establish measured first-frame and visible-frame-age targets from physical testing.
   - Freshness remains more important than resolution.

---

# V2.3 — Evidence-led transport tuning

Do not start this phase from assumptions.

- Inspect actual negotiated codec + NACK + RTX + RED/ULPFEC/FlexFEC capabilities in sanitized form.
- Use real loss/RTT/retransmission/frame-age data to decide whether FEC is worth an experiment.
- If tested, compare FEC vs NACK/RTX under repeatable Wi-Fi impairment and keep it only if latency/reliability improves without unacceptable bandwidth cost.
- Revisit receiver foreground-service behavior only if background/PiP reliability still needs it.
- Prepare for Android 17 / target SDK 37 local-network permission requirements before raising target SDK.

---

# Explicitly reject

Do **not** copy these ZeroLink choices:

- JPEG-over-raw-TCP as the primary media transport.
- Cleartext screen/control traffic.
- Six-digit PIN as durable trust.
- Pairing/session secrets or full IPs in logs/notifications.
- AccessibilityService remote control.
- Broad cloud analytics/telemetry dependency without a product requirement.
- `largeHeap` or permanent wake locks as substitutes for correct lifecycle/memory handling.

---

# Agent execution rule

Work one milestone at a time. Do not mix Wi-Fi Direct or later UX work into V2.0 fixes.

For each milestone:

1. Reproduce/confirm the specific failure or requirement.
2. Make the smallest coherent implementation.
3. Add behavior tests plus native/static contracts where appropriate.
4. Run the automatic source gate.
5. Do **not** trigger APK/Maestro unless the milestone explicitly reaches its manual qualification gate.
6. Update this file only when a gate is actually proven.
