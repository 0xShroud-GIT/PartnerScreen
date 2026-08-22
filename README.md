# Chirp

Chirp is an Android app for two trusted partners to pair once and, while on the same local network, request and explicitly approve live screen viewing.

The product is privacy-first: capture requires the owner's approval and Android MediaProjection consent, media is direct peer-to-peer WebRTC, and V1 has no accounts, cloud signaling, recording, remote control, analytics, ads, microphone sharing, or TURN relay.

## Stack

- Expo SDK 57
- React Native 0.86.2 / React 19.2.3
- TypeScript 6
- Expo Router
- Local Kotlin Expo Modules for Android-owned capabilities
- `org.jitsi:webrtc:124.0.0` inside the screen-capture native module
- Android V1 only

Chirp requires a custom development/production build. Expo Go is not a valid product runtime for the native discovery, transport, MediaProjection, or WebRTC capabilities used here.

## Repository

```text
Chirp/
├── README.md             # permanent human entry point
├── AGENTS.md             # permanent AI/developer working rules
├── CHECKPOINT.md         # current project state and next work
├── app/                  # Expo Router routes/screens
├── src/                  # TypeScript application/domain logic
├── modules/              # Chirp Kotlin Expo Modules
├── tests/                # product/regression tests
├── scripts/              # validation and Android build tooling
├── docs/                 # focused durable architecture/reference docs
├── app.config.ts
├── package.json
└── package-lock.json
```

GitHub is the canonical working repository. Historical handoff packets, generated evidence bundles, APKs, keystores, `node_modules/`, and generated root `android/` / `ios/` projects do not belong in source control.

## Start development

Requirements:

- Node `>=22.13.0 <23`
- npm 10.x (`package.json` currently records `npm@10.9.8`)

```bash
npm ci
npm run typecheck
npm run test:product
npm run check:contracts
npm run check:baseline
npm run sanitize
```

Useful focused suites remain available as `npm run test:m1` through `npm run test:m8`.

For Expo development:

```bash
npm start
```

For Android native generation/build work, use the development-build path rather than Expo Go. Generated `android/` and `ios/` directories are disposable CNG output and are ignored by Git.

## Development APK

On a machine with the required Android SDK/JDK:

```bash
export CHIRP_BUILD_COMMIT="$(git rev-parse HEAD)"
npm run build:dev-apk -- --preflight
npm run build:dev-apk
```

The build script creates development-only signing material and output; these artifacts must not be committed.

## Before changing code

Developers and AI agents should read:

1. `AGENTS.md` — permanent engineering rules.
2. `CHECKPOINT.md` — current status, blockers, and next intended work.
3. Only the relevant file under `docs/` for the subsystem being changed.
4. The implementation and tests themselves, which remain the final truth for current behavior.

## Durable references

- `docs/product.md` — product boundary, canonical flow, privacy and non-goals.
- `docs/architecture.md` — ownership, state, lifecycle and source map.
- `docs/protocol-security.md` — pairing, trusted control, replay and security rules.
- `docs/android-media.md` — Android native, MediaProjection, WebRTC and renderer rules.
- `docs/verification.md` — validation commands and physical-device acceptance.

Current progress does **not** belong in this README; update `CHECKPOINT.md` instead.
