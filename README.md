# Chirp

Chirp is an Android app for two trusted phones to pair once and privately share either phone's screen over the same local Wi-Fi network.

The product boundary is deliberately small:

- explicit trusted-device pairing
- authenticated local discovery and control
- owner approval plus Android MediaProjection consent for every share
- direct peer-to-peer WebRTC video over private LAN host candidates
- no accounts, cloud signaling, TURN relay, recording, remote control, analytics, ads, or microphone capture

## Runtime

- Expo SDK 57
- React Native 0.86.2 / React 19.2.3
- TypeScript 6
- `react-native-webrtc` 124.0.8
- Expo Router
- five local Kotlin Expo modules for pairing, discovery, authenticated control, discovery authentication, and request notifications
- Android only
- 64-bit ABIs only: `arm64-v8a` for physical phones and `x86_64` for emulators

Screen capture and rendering are owned by `react-native-webrtc`: Chirp uses `getDisplayMedia()` and `RTCView` directly. Chirp does not maintain a custom PeerConnection engine, capturer, renderer, EGL layer, or MediaProjection implementation.

## Repository

```text
app/        Expo Router screens
src/        pairing, discovery, product session, control, media, security, diagnostics
modules/    five Android native modules that are specific to Chirp
plugins/    minimal Expo config required by react-native-webrtc
scripts/    repository hygiene and APK build commands
tests/      TypeScript product/security/policy tests
```

Generated `android/`, APKs, keystores, `node_modules/`, historical milestone scaffolding, runtime laboratories, and generated evidence do not belong in source control.

## Development

Requirements:

- Node `>=22.13.0 <23`
- npm 10.x
- Android SDK/JDK for native builds

```bash
npm ci
npm run ci
```

For local Expo development:

```bash
npm start
```

For a clean Android APK build:

```bash
npm run build:apk
```

The APK build performs a clean Android prebuild and writes development artifacts to `dist/`.

## Architecture rule

Product-session, control-connection, and WebRTC lifetimes are separate. Chirp does not emulate encoder or decoder recovery in application code: native libwebrtc owns RTCP feedback such as PLI/FIR and keyframe recovery.

```text
Missing/undecodable frame -> native WebRTC RTCP feedback + stats
Bad ICE/DTLS transport    -> bounded ICE restart
Bad control transport     -> authenticated control reconnect
Persistent media failure  -> fail the product session
```

Only product-session code decides that the user-visible sharing session is over. A MediaProjection track is capture ownership, not an encoder-control primitive: while a share is active it is never disabled or restarted to manipulate WebRTC.
