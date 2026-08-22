#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export CHIRP_BUILD_COMMIT="${CHIRP_BUILD_COMMIT:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
rm -rf android dist
mkdir -p dist

npx expo prebuild --clean --platform android
(
  cd android
  ./gradlew --no-daemon :app:assembleDebug
)

APK="android/app/build/outputs/apk/debug/app-debug.apk"
OUT="dist/chirp-debug-arm64-v8a-x86_64.apk"
test -f "$APK"
cp "$APK" "$OUT"
(
  cd dist
  sha256sum "$(basename "$OUT")" > SHA256SUMS.txt
  cat > DEVELOPMENT_ONLY.txt <<'EOF'
Chirp development APK. Not production-signed. Built for arm64-v8a physical devices and x86_64 emulators only.
EOF
)

echo "Built $OUT"
