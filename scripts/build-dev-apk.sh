#!/usr/bin/env bash
# PartnerScreen DEVELOPMENT-ONLY Android APK build.
#
# Follows masters/05 "Development APK strategy":
#   1. npx expo prebuild --clean --platform android
#   2. generate an ephemeral/test keystore
#   3. configure release signing for that build only (throwaway key)
#   4. ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
#   5. clearly label the artifact development/test-only
#
# This is NOT a production release build. The APK produced here is not
# update-compatible with a production-signed APK unless the same key is kept.
#
# Usage:
#   npm run build:dev-apk            # full dev APK build
#   npm run build:dev-apk -- --preflight   # environment check only (no build)
#
# Environment overrides:
#   PARTNERSCREEN_ABIS   comma-separated Android ABIs (default: arm64-v8a)
#   ANDROID_HOME         Android SDK root (or ANDROID_SDK_ROOT)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARN: $*" >&2; }

preflight() {
  local ok=1

  command -v npm >/dev/null 2>&1 || { echo "  missing: npm (Node 22.13+ baseline)"; ok=0; }
  if command -v node >/dev/null 2>&1; then
    if ! node -e 'const [M,m]=process.versions.node.split(".").map(Number); if(M!==22||m<13) process.exit(1)' 2>/dev/null; then
      echo "  wrong Node: $(node --version) (baseline requires 22.13.x+ on the 22 line)"; ok=0
    fi
  else
    ok=0
  fi

  if command -v java >/dev/null 2>&1; then
    local major; major="$(java -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
    [[ "$major" =~ ^[0-9]+$ ]] || major=0
    if (( major < 17 )); then
      echo "  wrong Java: $(java -version 2>&1 | head -1) (17+ required by AGP)"; ok=0
    fi
  else
    echo "  missing: java (JDK 17+ required by AGP)"; ok=0
  fi

  command -v keytool >/dev/null 2>&1 || { echo "  missing: keytool (part of a JDK)"; ok=0; }

  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -z "$sdk" || ! -d "$sdk" ]]; then
    echo "  missing: Android SDK — set ANDROID_HOME (or ANDROID_SDK_ROOT) to the SDK directory"
    ok=0
  else
    [[ -x "$sdk/platform-tools/adb" ]] || { echo "  missing: platform-tools/adb ($sdk)"; ok=0; }
    [[ -d "$sdk/platforms/android-36" ]] || { echo "  missing: platforms/android-36 ($sdk)"; ok=0; }
    [[ -d "$sdk/build-tools/36.0.0" ]] || { echo "  missing: build-tools/36.0.0 ($sdk)"; ok=0; }
  fi

  if [[ "$ok" != "1" ]]; then
    echo "preflight: FAILED (see missing items above). Android build truth lives in the external build lane."
    return 1
  fi
  echo "preflight: OK — node $(node --version), $(java -version 2>&1 | head -1), SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
}

if [[ "${1:-}" == "--preflight" ]]; then
  preflight
  exit 0
fi

echo "==> PartnerScreen DEVELOPMENT-ONLY APK build (throwaway signing, not a production release)"
preflight

SOURCE_REV="${PARTNERSCREEN_BUILD_COMMIT:-}"
if [[ -z "$SOURCE_REV" ]] && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
  SOURCE_REV="$(git -C "$ROOT" rev-parse HEAD)"
fi
if [[ -z "$SOURCE_REV" ]]; then
  SOURCE_REV="unrecorded"
  warn "PARTNERSCREEN_BUILD_COMMIT is unset and no git HEAD is available; APK metadata will record source revision as unrecorded"
fi

ABIS="${PARTNERSCREEN_ABIS:-arm64-v8a}"
KS_DIR="artifacts/build-metadata"
KS="$KS_DIR/dev-keystore.jks"
KS_PASS="partnerscreen-dev-pass"
KS_ALIAS="partnerscreen-dev"
mkdir -p "$KS_DIR"

echo "==> 1/5 expo prebuild (CNG: generated android/ is build output, gitignored)"
CI=1 PARTNERSCREEN_BUILD_COMMIT="$SOURCE_REV" npx expo prebuild --clean --platform android --no-install

echo "==> 2/5 throwaway dev keystore (DEVELOPMENT ONLY)"
if [[ ! -f "$KS" ]]; then
  keytool -genkeypair -v \
    -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=PartnerScreen Dev, OU=Development, O=PartnerScreen, L=Local, ST=Local, C=ZA" >/dev/null
fi
cat > android/keystore.properties <<EOF
storeFile=$ROOT/$KS
storePassword=$KS_PASS
keyAlias=$KS_ALIAS
keyPassword=$KS_PASS
EOF

echo "==> 3/5 wire dev signing into generated android/app/build.gradle (idempotent)"
GRADLE_APP=android/app/build.gradle
[[ -f "$GRADLE_APP" ]] || fail "expected generated $GRADLE_APP (did prebuild succeed?)"
if ! grep -q "partnerscreenDevSigning" "$GRADLE_APP"; then
  python3 - "$GRADLE_APP" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

props_marker = '// [partnerscreenDevSigningProps] DEVELOPMENT-ONLY keystore properties'
props_block = '''// [partnerscreenDevSigningProps] DEVELOPMENT-ONLY keystore properties
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file("keystore.properties")
if (!keystorePropertiesFile.exists()) {
    throw new GradleException("Missing development signing properties: " + keystorePropertiesFile)
}
keystorePropertiesFile.withInputStream { keystoreProperties.load(it) }

'''
marker = '// [partnerscreenDevSigning] DEVELOPMENT-ONLY dev signing wired by scripts/build-dev-apk.sh'
dev_block = '''        dev {
            storeFile file(keystoreProperties["storeFile"])
            storePassword keystoreProperties["storePassword"]
            keyAlias keystoreProperties["keyAlias"]
            keyPassword keystoreProperties["keyPassword"]
        }
'''

if props_marker not in s:
    s = props_block + s

if marker not in s:
    if 'signingConfigs {' not in s:
        raise SystemExit('could not locate signingConfigs block in generated build.gradle')
    s = re.sub(r'(signingConfigs\s*\{\s*)',
               r'\1' + marker + '\n' + dev_block,
               s, count=1)

s2 = re.sub(r'(release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug',
            r'\1signingConfig signingConfigs.dev', s, count=1, flags=re.S)
if s2 == s and 'signingConfig signingConfigs.dev' not in s:
    raise SystemExit('could not locate release buildType signingConfig in generated build.gradle')
s = s2

open(p, 'w', encoding='utf-8').write(s)
PY
  echo "  patched $GRADLE_APP (dev signing)"
else
  echo "  already patched, skipping"
fi

# SDK 57's generated app/build.gradle consumes the Gradle property
# `hermesEnabled`. Validate the CNG output rather than injecting a
# lane-specific workaround into generated native source.
GRADLE_PROPS=android/gradle.properties
[[ -f "$GRADLE_PROPS" ]] || fail "expected generated $GRADLE_PROPS"
grep -Eq '^hermesEnabled=(true|false)$' "$GRADLE_PROPS" \
  || fail "generated $GRADLE_PROPS is missing hermesEnabled; refusing an ambiguous Hermes/JSC build"
echo "==> 4/5 gradle assembleRelease (ABIs: $ABIS)"
( cd android && ./gradlew assembleRelease -PreactNativeArchitectures="$ABIS" )

echo "==> 5/5 collect and label"
APK_SRC=android/app/build/outputs/apk/release/app-release.apk
[[ -f "$APK_SRC" ]] || fail "expected APK not produced: $APK_SRC"
VERSION="$(node -e "console.log(require('./package.json').version)")"
OUT="$KS_DIR/partnerscreen-dev-${VERSION}-${ABIS//,/-}.apk"
cp "$APK_SRC" "$OUT"
cat > "$OUT.DEVELOPMENT_ONLY.txt" <<EOF
DEVELOPMENT-ONLY APK — NOT A PRODUCTION RELEASE
Built by scripts/build-dev-apk.sh with a throwaway development signing key.
Not update-compatible with a production-signed APK unless the same key is retained.
Use for physical-device (two-phone) validation only.
Built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Version: $VERSION
ABIs: $ABIS
Source revision: $SOURCE_REV
EOF

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
APKSIGNER="$(ls "$SDK"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$APKSIGNER" ]]; then
  echo "  verifying signature:"
  "$APKSIGNER" verify --print-certs "$OUT" || warn "apksigner verify reported a problem (see above)"
fi

echo "==> DEVELOPMENT-ONLY APK ready: $OUT"
echo "    label: $OUT.DEVELOPMENT_ONLY.txt"
