# Local Expo Modules

Chirp-specific Android capability boundaries live here. Product/session state stays in TypeScript; these modules own only the native resources and primitives they expose.

Current modules:

- `partner-pairing-transport` — bounded private-Wi-Fi pairing socket/framing primitives.
- `partner-discovery-auth` — HMAC-SHA256 primitive used by trusted discovery.
- `partner-discovery` — Android NSD registration/browsing/resolution, Wi-Fi/network binding and reachability capability.
- `partner-control` — local trusted-session transport primitives.
- `partner-screen-capture` — MediaProjection consent/FGS/capture ownership, native WebRTC integration and remote renderer/first-frame events.

Keep APIs narrow and capability-oriented. Do not move product truth, durable trust decisions, request/session state, or UI state into native modules.

Repository-root `android/` and `ios/` CNG output is generated and non-canonical; native source under these local modules is canonical and tracked.
