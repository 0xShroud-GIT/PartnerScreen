# Verification

PartnerScreen distinguishes source, build and physical evidence. Passing one layer never implies another.

## Source gate

From repository root:

```bash
npm ci
npm run typecheck
npm run test:product
npm run check:contracts
npm run check:baseline
npm run sanitize
npm run config:check
npm run deps:check
```

Focused suites `test:m1` … `test:m8` are useful during development, but they do not replace the full product suite before handing off a material cross-cutting change.

## Evidence layers

1. **Source/static** — TypeScript compile, product tests, protocol/security/static contract checks, config/dependency inspection and repository sanitation.
2. **Android build** — clean CNG prebuild, local module autolinking, Kotlin/Java/native compile, generated manifest inspection and a successfully signed development/release candidate.
3. **Physical one-device** — install/launch, secure storage, permissions, MediaProjection consent/service/revoke, renderer/native lifecycle and diagnostics.
4. **Physical two-device** — real LAN pairing/discovery/control plus screen capture and remote rendering on two phones.

Never call a missing build/device layer PASS because source tests are green.

## Development APK gate

On an Android SDK/JDK-equipped lane, commit the exact candidate first and build from that revision:

```bash
export PARTNERSCREEN_BUILD_COMMIT="$(git rev-parse HEAD)"
npm run build:dev-apk -- --preflight
npm run build:dev-apk
```

Record the APK SHA-256 and use that exact artifact for physical testing. Do not mutate/repackage an APK after qualification starts.

## Required two-phone acceptance flow

At minimum, prove on two real Android phones on the same Wi-Fi:

`install → distinct device names → pair by QR → restart → rediscover trusted partner → request → decline → recover → request again → accept → Android capture consent → capture active → WebRTC → actual viewer first frame → LIVE → Stop → complete cleanup → second complete session succeeds`

Also exercise:

- request cancellation and stale/busy handling;
- QR camera permission/real scan;
- trusted discovery disappearance/reappearance;
- MediaProjection denial/revoke;
- foreground notification Stop;
- orientation and renderer/EGL lifecycle;
- Wi-Fi interruption/recovery/terminal behavior;
- process/background lifecycle where relevant;
- repeated sessions to catch leaked native resources.

Stop and fix the first reproduced invariant failure instead of accumulating unrelated changes.

## Anti-false-pass rules

- install success is not functional success;
- launch success is not lifecycle success;
- ICE connected is not LIVE;
- `onTrack` is not LIVE;
- generated/source assertions are not physical proof;
- a build from another commit is not evidence for the current commit;
- an unfrozen APK is not a qualification candidate;
- rerunning failures until one passes without understanding the failure is not evidence.

Keep current evidence/status in `CHECKPOINT.md`, not in new mission-report folders.
