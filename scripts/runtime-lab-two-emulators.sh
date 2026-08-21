#!/usr/bin/env bash
set -euo pipefail

PACKAGE="com.partnerscreen.app"
ACTIVITY="${PACKAGE}/.MainActivity"
PAIR_QR_EXTRA="partnerscreen_runtime_lab_pairing_qr_b64"
MIN_EMULATOR_VERSION="37.1.11"

ADB_A="${ADB_A:-emulator-5554}"
ADB_B="${ADB_B:-emulator-5556}"
MAESTRO_BIN="${MAESTRO_BIN:-maestro}"
EMULATOR_BIN="${EMULATOR_BIN:-emulator}"
APK_PATH="${APK_PATH:-}"

fail() {
  printf 'Runtime Lab emulator failure: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is unavailable"
}

version_at_least() {
  local actual="$1" minimum="$2"
  [[ "$(printf '%s\n%s\n' "$minimum" "$actual" | sort -V | head -n1)" == "$minimum" ]]
}

maestro_on() {
  local serial="$1" flow="$2"
  shift 2
  # --device is a Maestro global option and must precede the test subcommand.
  "$MAESTRO_BIN" --device "$serial" test "$@" "$flow"
}

require_command adb
require_command "$MAESTRO_BIN"
require_command "$EMULATOR_BIN"
require_command zbarimg
require_command base64
require_command cmp
require_command sort

[[ -n "$APK_PATH" ]] || fail "set APK_PATH to an already-built Runtime Lab debug APK"
[[ -f "$APK_PATH" ]] || fail "APK_PATH does not exist: $APK_PATH"
[[ "$ADB_A" != "$ADB_B" ]] || fail "ADB_A and ADB_B must identify two different emulators"

emulator_version="$($EMULATOR_BIN -version 2>&1 | sed -nE 's/.*version ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n1)"
[[ -n "$emulator_version" ]] || fail "could not determine Android Emulator version"
version_at_least "$emulator_version" "$MIN_EMULATOR_VERSION" || \
  fail "Android Emulator $MIN_EMULATOR_VERSION+ is required for same-host peer NSD/networking; found $emulator_version"

adb -s "$ADB_A" wait-for-device
adb -s "$ADB_B" wait-for-device

adb -s "$ADB_A" install -r -t "$APK_PATH" >/dev/null
adb -s "$ADB_B" install -r -t "$APK_PATH" >/dev/null

# run-as succeeds only for debuggable packages. Native Runtime Lab hooks also check
# ApplicationInfo.FLAG_DEBUGGABLE independently.
adb -s "$ADB_A" shell run-as "$PACKAGE" true >/dev/null 2>&1 || fail "APK on $ADB_A is not debuggable"
adb -s "$ADB_B" shell run-as "$PACKAGE" true >/dev/null 2>&1 || fail "APK on $ADB_B is not debuggable"

# Level 3 is a pairing/session/WebRTC/renderer gate, not a notification-permission
# qualification. Pre-grant POST_NOTIFICATIONS so Android's runtime dialog cannot
# obscure the UI under test. Permission semantics remain covered by Level 2 and
# physical milestone qualification.
for serial in "$ADB_A" "$ADB_B"; do
  sdk="$(adb -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
  if [[ "$sdk" =~ ^[0-9]+$ ]] && (( sdk >= 33 )); then
    adb -s "$serial" shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS >/dev/null
  fi
done

workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

maestro_on "$ADB_A" .maestro/runtime-lab/setup-device.yaml -e DEVICE_NAME=LabAlice
maestro_on "$ADB_B" .maestro/runtime-lab/setup-device.yaml -e DEVICE_NAME=LabBob
maestro_on "$ADB_A" .maestro/runtime-lab/creator-start.yaml

# Decode the actual one-time QR rendered by the creator. Keep the payload only in
# shell variables; never echo it or write it to a report/artifact.
adb -s "$ADB_A" exec-out screencap -p > "$workdir/creator-qr.png"
pair_qr="$(zbarimg --quiet --raw "$workdir/creator-qr.png" 2>/dev/null | head -n1 || true)"
[[ "$pair_qr" == PS1:* ]] || fail "could not decode the creator PartnerScreen QR"
pair_qr_b64="$(printf '%s' "$pair_qr" | base64 | tr -d '\r\n')"
unset pair_qr

# Restart only the scanner Activity so its persisted device identity remains, then
# provide the real QR through the debuggable camera-substitution intent. The app
# still calls PairingService.startScanner() and performs the normal authenticated
# network handshake and two-sided confirmation.
adb -s "$ADB_B" shell am force-stop "$PACKAGE"
adb -s "$ADB_B" shell am start -n "$ACTIVITY" --es "$PAIR_QR_EXTRA" "$pair_qr_b64" >/dev/null
unset pair_qr_b64

maestro_on "$ADB_B" .maestro/runtime-lab/scanner-confirm.yaml -e EXPECTED_PARTNER=LabAlice
maestro_on "$ADB_A" .maestro/runtime-lab/creator-confirm.yaml
maestro_on "$ADB_A" .maestro/runtime-lab/wait-available.yaml
maestro_on "$ADB_B" .maestro/runtime-lab/wait-available.yaml

maestro_on "$ADB_A" .maestro/runtime-lab/request-screen.yaml
maestro_on "$ADB_B" .maestro/runtime-lab/accept-screen.yaml
maestro_on "$ADB_A" .maestro/runtime-lab/viewer-live.yaml

# Synthetic frames contain a moving luma pattern. With the status bar hidden in
# Viewer, two identical full-screen captures one second apart are a strong smoke
# signal that the rendered video has frozen.
adb -s "$ADB_A" exec-out screencap -p > "$workdir/frame-a.png"
sleep 1
adb -s "$ADB_A" exec-out screencap -p > "$workdir/frame-b.png"
if cmp -s "$workdir/frame-a.png" "$workdir/frame-b.png"; then
  fail "viewer screenshots are byte-identical; synthetic video appears frozen"
fi

maestro_on "$ADB_A" .maestro/runtime-lab/stop-session.yaml
maestro_on "$ADB_A" .maestro/runtime-lab/wait-available.yaml
maestro_on "$ADB_B" .maestro/runtime-lab/wait-available.yaml

printf 'Runtime Lab two-emulator gate passed: pairing, availability, request, synthetic WebRTC LIVE, freshness smoke, teardown.\n'
