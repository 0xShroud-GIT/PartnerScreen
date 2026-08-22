#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SOURCE_COMMIT="${CHIRP_BUILD_COMMIT:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Invalid Chirp source commit: $SOURCE_COMMIT" >&2
  exit 1
fi
export CHIRP_BUILD_COMMIT="$(printf '%s' "$SOURCE_COMMIT" | tr 'A-F' 'a-f')"

FORBIDDEN_PERMISSIONS=(
  android.permission.RECORD_AUDIO
  android.permission.SYSTEM_ALERT_WINDOW
)

rm -rf android dist
mkdir -p dist

npx expo prebuild --clean --platform android

DEBUG_MANIFEST="android/app/src/debug/AndroidManifest.xml"
test -f "$DEBUG_MANIFEST"
for permission in "${FORBIDDEN_PERMISSIONS[@]}"; do
  if grep -Fq "$permission" "$DEBUG_MANIFEST"; then
    echo "Forbidden permission remains in generated debug manifest: $permission" >&2
    exit 1
  fi
done

# A debug React Native APK expects a Metro server and is not a standalone
# physical-test artifact. Release mode embeds the JS/Hermes bundle while the
# generated Expo project still uses the development signing key.
(
  cd android
  ./gradlew --no-daemon :app:assembleRelease
)

APK="android/app/build/outputs/apk/release/app-release.apk"
OUT="dist/chirp-qualification-arm64-v8a-x86_64.apk"
test -f "$APK"

APK_ANALYZER="$(command -v apkanalyzer || true)"
if [[ -z "$APK_ANALYZER" && -n "${ANDROID_HOME:-}" ]]; then
  APK_ANALYZER="$(find "$ANDROID_HOME" -type f -name apkanalyzer -perm -u+x 2>/dev/null | sort | tail -n 1 || true)"
fi
if [[ -n "$APK_ANALYZER" ]]; then
  PERMISSIONS="$($APK_ANALYZER manifest permissions "$APK")"
  for permission in "${FORBIDDEN_PERMISSIONS[@]}"; do
    if grep -Fq "$permission" <<<"$PERMISSIONS"; then
      echo "Forbidden permission is present in final APK: $permission" >&2
      exit 1
    fi
  done
else
  MERGED_MANIFEST="$(find android/app/build/intermediates -type f -name AndroidManifest.xml \( -path '*release*merged_manifest*' -o -path '*release*packaged_manifests*' \) 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -z "$MERGED_MANIFEST" ]]; then
    echo "Unable to locate APK analyzer or merged release Android manifest for permission verification." >&2
    exit 1
  fi
  for permission in "${FORBIDDEN_PERMISSIONS[@]}"; do
    if grep -Fq "$permission" "$MERGED_MANIFEST"; then
      echo "Forbidden permission is present in merged release manifest: $permission" >&2
      exit 1
    fi
  done
fi

cp "$APK" "$OUT"
python3 - "$OUT" "$CHIRP_BUILD_COMMIT" <<'PY'
import json
import sys
import zipfile

apk_path, expected_commit = sys.argv[1:]
with zipfile.ZipFile(apk_path) as archive:
    names = set(archive.namelist())
    config = json.loads(archive.read('assets/app.config'))

    bundle_name = 'assets/index.android.bundle'
    if bundle_name not in names:
        raise SystemExit('Standalone JS bundle is missing from APK; this build would require Metro')
    bundle_size = archive.getinfo(bundle_name).file_size
    if bundle_size < 100_000:
        raise SystemExit(f'Standalone JS bundle is unexpectedly small: {bundle_size} bytes')

build_commit = config.get('extra', {}).get('buildCommit')
if build_commit != expected_commit:
    raise SystemExit(f'APK buildCommit mismatch: expected {expected_commit}, got {build_commit}')
if config.get('android', {}).get('package') != 'com.chirp.app':
    raise SystemExit('APK app.config package is not com.chirp.app')

abis = {name.split('/')[1] for name in names if name.startswith('lib/') and name.count('/') >= 2}
expected_abis = {'arm64-v8a', 'x86_64'}
if abis != expected_abis:
    raise SystemExit(f'Unexpected APK ABI set: {sorted(abis)}')
for abi in sorted(expected_abis):
    required = f'lib/{abi}/libjingle_peerconnection_so.so'
    if required not in names:
        raise SystemExit(f'Missing native WebRTC library: {required}')

blocked = set(config.get('android', {}).get('blockedPermissions', []))
for permission in ('android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW'):
    if permission not in blocked:
        raise SystemExit(f'APK app.config no longer blocks {permission}')

print(f'APK standalone bundle OK: {bundle_size} bytes')
print(f'APK identity OK: {build_commit}; ABIs={sorted(abis)}')
PY

(
  cd dist
  sha256sum "$(basename "$OUT")" > SHA256SUMS.txt
  cat > BUILD_INFO.txt <<EOF
sourceCommit=$CHIRP_BUILD_COMMIT
package=com.chirp.app
buildType=release
standaloneJsBundle=assets/index.android.bundle
abis=arm64-v8a,x86_64
webrtc=react-native-webrtc@124.0.8
EOF
  cat > DEVELOPMENT_ONLY.txt <<'EOF'
Chirp qualification APK. Standalone release-mode bundle signed with the development key; no Metro server is required. Not for store distribution.
EOF
)

echo "Built standalone $OUT from $CHIRP_BUILD_COMMIT"
