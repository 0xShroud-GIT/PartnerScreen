# Local Expo Modules

Chirp-specific Android capability boundaries live here. Product/session state stays in TypeScript; these modules own only the native resources and primitives they expose.

Current modules:

- `chirp-pairing-transport` — bounded private-Wi-Fi pairing socket/framing primitives.
- `chirp-discovery-auth` — HMAC-SHA256 primitive used by trusted discovery.
- `chirp-discovery` — Android NSD registration/browsing/resolution, Wi-Fi/network binding and reachability capability.
- `chirp-control` — local trusted-session transport primitives.
- `chirp-request-notification` — incoming-request notification, permission/capability and launch/open routing primitives.

Screen capture and rendering are provided by the installed `react-native-webrtc` dependency through `getDisplayMedia()` and `RTCView`; Chirp does not maintain a custom screen-capture Expo module.

Keep APIs narrow and capability-oriented. Do not move product truth, durable trust decisions, request/session state, or UI state into native modules.

Repository-root `android/` and `ios/` CNG output is generated and non-canonical; native source under these local modules is canonical and tracked.