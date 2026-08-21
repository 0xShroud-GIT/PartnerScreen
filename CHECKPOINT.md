# PartnerScreen Checkpoint

**Updated:** 2026-08-21  
**Phase:** C09 Android build + physical qualification  
**Last accepted source checkpoint:** `69afe2af4a01453009a4df52e0e8f00eb92c8008` (C08R2)  
**Current repository state:** Canonical GitHub repository initialized on `main`. Import commit `575df375cfb2c2b12e4b5c4afb86e7e37cdd6a8f` exactly matched the cleaned 168-file tree (`627235b5739c127db6667660c81a7051b7c48893`). Application/runtime source remains the C08R2 source plus the C09 development-APK build-script recovery.

## Current truth

C08R2 completed the source/lifecycle remediation pass. At that checkpoint:

- `test:product`: **134/134 passed**;
- static contract checks: **13/13 passed**;
- focused M1–M8 suites were green;
- Android build/device truth was not claimed from the headless source environment.

The C09 build attempt then exposed a real defect in `scripts/build-dev-apk.sh`: its injected Gradle development signing config referenced `keystoreProperties` without loading the generated `android/keystore.properties` file.

The script in this repository already contains the recovery:

- loads the generated keystore properties before using them;
- keeps the Gradle patch idempotent;
- validates Expo SDK 57 generated `hermesEnabled=true` rather than injecting an environment-specific Hermes override;
- requires C09 Android lane inputs including platform-tools/ADB, API 36 platform, and build-tools 36.0.0;
- records the candidate revision from `PARTNERSCREEN_BUILD_COMMIT` or Git HEAD.

No pairing, trust, discovery, control, MediaProjection, WebRTC, renderer, session or UI runtime source was changed by that recovery.

## Repository cleanup performed for GitHub

The source handoff was converted into the intended live GitHub repository layout:

- application moved to repository root;
- duplicate agent/governance systems removed;
- historical Arena/mission/evidence/handoff material removed;
- stale GitHub/CI documentation removed;
- durable product/architecture/security/verification knowledge condensed into `docs/`;
- one permanent `AGENTS.md` retained;
- this single current `CHECKPOINT.md` created;
- `README.md` rewritten as the permanent repository entry point.

Runtime application source and active application configuration were not rewritten as part of this cleanup.

## Packaging validation

During this cleanup/repack:

- **159 retained application/config/test/native/tooling files** were SHA-256 compared with the upload and remained byte-for-byte identical;
- `bash -n scripts/build-dev-apk.sh`: PASS;
- `npm run check:baseline`: PASS;
- pairing + M1–M8 static contract checks passed before the combined contract command reached Expo autolinking;
- Expo autolinking/full TypeScript product replay was not completed in this packaging environment because dependencies could not be restored here; do not promote the historical 134/134 result into a post-cleanup/post-build-script-fix test run;
- `npm run sanitize` against the cleaned tracked tree: PASS.

The canonical GitHub repository now exists. The full source gate listed below still needs to be run against the current GitHub `main` before an APK is treated as a C09 candidate.

## GitHub verification and sanitation — 2026-08-21

- canonical import commit: `575df375cfb2c2b12e4b5c4afb86e7e37cdd6a8f`;
- import tree: `627235b5739c127db6667660c81a7051b7c48893`, exactly matching the cleaned local repository;
- tracked file count at import: **168**;
- `.import/` and temporary `.github/` importer content are absent from `main`;
- the two temporary import branch refs were repointed to the canonical `main` commit so they no longer expose staging trees;
- `npm run sanitize`: **PASS** on the exact canonical import tree;
- `npm run check:baseline`: **PASS** on the exact canonical import tree;
- additional high-confidence credential scan: **PASS** — no private keys, common cloud/API tokens, credential-bearing lockfile URLs, or npm auth tokens detected;
- no tracked `.env`, signing keys/certificates, generated/cache directories, database/log/archive artifacts, or files over 1 MiB were found.

This sanitation pass did not change application/runtime/native/test source.

## Current blocker

**C09 does not have Android B-PASS yet.**

The recovered build script is committed in the canonical GitHub repo. All source gates must still be rerun against the exact current commit, and an APK must be successfully built on an Android SDK-equipped machine before physical qualification begins.

Do not describe C09 as passed and do not begin device evidence against an unfrozen/unidentified APK.

## Next work

1. Run the full source gate against the exact current GitHub `main`:
   - `npm ci`
   - `npm run typecheck`
   - `npm run test:product`
   - `npm run check:contracts`
   - `npm run check:baseline`
   - `npm run sanitize`
   - `npm run config:check`
   - `npm run deps:check`
2. On an Android SDK/JDK-equipped build lane, set `PARTNERSCREEN_BUILD_COMMIT` to that exact commit.
3. Run `npm run build:dev-apk -- --preflight`, then `npm run build:dev-apk`.
4. Freeze and record the resulting APK SHA-256.
5. Perform C09 physical qualification on the exact frozen APK, including two-phone request/accept/decline, MediaProjection consent/revoke, notification Stop, real first-frame LIVE truth, orientation/renderer lifecycle, Wi-Fi interruption/recovery, teardown, and a second complete session.
6. Fix only reproduced defects, add focused regression coverage, rerun applicable gates, and update this checkpoint.

## High-risk invariants to protect during C09 fixes

- native capture callbacks are generation/session scoped and cannot leak from replaced session A into B;
- control listener failures invalidate only the exact owned listener; Wi-Fi rebinding does not kill unrelated active authenticated connections;
- capture-originated terminal events end only the exact current product session;
- stale SDP failure callbacks still settle their promises exactly once;
- LIVE requires the current renderer/session/track epoch's actual first frame;
- reconnect/retry uses fresh resources and rejects stale events;
- local teardown remains authoritative and idempotent.

## Evidence status

| Layer | Status |
| --- | --- |
| Source/product tests at C08R2 | PASS — 134/134 |
| Static contracts at C08R2 | PASS — 13/13 |
| Post-build-script-fix full source replay | **Required** |
| Android APK build for current Git commit | **Required / not yet PASS** |
| Physical one-device qualification | **Not started for current candidate** |
| Physical two-device qualification | **Not started for current candidate** |

When these facts change, update this file instead of adding mission reports or additional checkpoint documents.
