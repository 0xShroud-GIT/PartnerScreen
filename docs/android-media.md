# Android Native & Media

## Native module boundary

PartnerScreen keeps Android-specific ownership in local Expo Modules under `modules/`:

- `partner-pairing-transport` — bounded private-LAN pairing socket primitives;
- `partner-discovery-auth` — HMAC-SHA256 primitive used by trusted discovery;
- `partner-discovery` — Android NSD/local-network discovery and reachability capability;
- `partner-control` — local control transport primitives;
- `partner-screen-capture` — MediaProjection, foreground service, screen capturer, WebRTC peer/track integration and remote renderer behavior.

Native modules own resources, not product/session truth. TypeScript validates and orchestrates those capabilities.

## Continuous Native Generation

Canonical native configuration is `package.json`, `app.config.ts`, Expo/config-plugin behavior and local module source. Root `android/` and `ios/` projects are generated/disposable CNG output unless the repository owner explicitly changes that architecture.

Do not fix generated files manually and then treat the edit as source truth.

## MediaProjection sequence

On an authenticated accepted request:

1. TypeScript requests Android capture consent through the native adapter.
2. Android displays `MediaProjectionManager` consent UI.
3. After grant, the native owner starts the mediaProjection foreground service and becomes foreground-ready.
4. The owner consumes the grant exactly once and starts one MediaProjection/capturer/local video track.
5. Only after usable capture/track state exists does WebRTC negotiation proceed.
6. Notification truth must reflect preparing vs active capture accurately.

User denial is not the same as technical capture failure.

`MediaProjection.Callback.onStop` is terminal for the owned capture. Notification **Stop sharing**, OS projection revoke, local Stop and fatal capture errors must stop local capture first and converge on idempotent cleanup even when JS or the peer is unavailable.

## WebRTC invariants

The native screen-capture module currently uses `org.jitsi:webrtc:124.0.0`.

Sharer order:

`capture track usable → fresh PeerConnection/session → addTrack succeeds → createOffer → setLocalDescription succeeds → send RTC_OFFER`

Viewer order:

`receive RTC_OFFER → setRemoteDescription succeeds → flush queued ICE → createAnswer → setLocalDescription succeeds → send RTC_ANSWER`

Rules:

- track-before-offer is mandatory;
- early ICE is queued per current session and flushed only after remote description succeeds;
- stale SDP/ICE callbacks cannot mutate a replacement PeerConnection/generation;
- failure promises still settle exactly once even if their generation became stale;
- retries/reconnects build fresh PeerConnections/resources;
- no TURN or audio in V1.

## Renderer / LIVE

The viewer's native renderer is keyed to the current remote track/session generation/renderer epoch. Replacing a remote track requires detaching/rebinding the renderer correctly; stale first-frame callbacks are ignored.

Only the actual first-frame callback for the current renderer/session/track epoch earns product `LIVE`.

## Orientation / lifecycle

Media and renderer ownership must survive ordinary React/activity lifecycle transitions without multiplying PeerConnections, renderers, capturers or foreground-service owners. Orientation changes must not produce hidden duplicate resources. Teardown must release EGL/surface/media resources deterministically, and a subsequent full session must succeed.

## Android permissions

V1 uses only permissions/capabilities required for local networking, QR scan and screen sharing. Do not add microphone/audio permissions. All PartnerScreen-owned Android components explicitly control export behavior; internal components default to non-exported unless a documented external contract requires otherwise.
