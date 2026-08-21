# Trusted presence lifecycle (P0-D)

**Status:** source design. Background behavior is not physically proven.

## Decision

Use an Android 14+ `connectedDevice` foreground service
(`FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`) while a confirmed pair requires
local availability/control.

This is the minimum Android-sanctioned mechanism for keeping a local trusted
device session alive. Google documents `connectedDevice` for ongoing interaction
with an external device over Bluetooth, USB, or **network**. A paired PartnerScreen
phone on private Wi-Fi is that external device.

`CompanionDeviceManager` was considered and rejected: PartnerScreen already has
persistent cryptographic pair trust. Replacing it with a system companion
association would change the trust model.

No AccessibilityService. No cloud wake. No auto-accept. MediaProjection still
requires explicit accept plus Android consent.

## Ownership

| Layer | Owns |
| --- | --- |
| `PartnerTrustedPresenceService` | Process priority + persistent notification, only while paired availability is required |
| `PartnerControlModule` process-scoped runtime | ServerSocket listener, accept/classify/read, event buffer |
| JS `ControlSession` | Pair authentication, handshake, product request/accept |
| JS UI | Presentation only. Not required to stay mounted for the listener |

## Handoff

1. Pair activate → JS `startTrustedPresence()` → FGS starts → `ensureListening()`.
2. Module `OnDestroy` does **not** close the listener while presence is required.
3. Activity/JS recreation reattaches the event sink and replays bounded pending
   control events, then `ensureListening()` returns the existing native listener.
4. Pair deactivate / unpair → `stopTrustedPresence()` → listener shutdown + FGS stop.

Inbound TCP without a first handshake frame is treated as a reachability probe
and never becomes a session. No request is accepted in native.

## What this does not claim

Physical background request delivery, OEM battery restrictions, and FGS
exemption behavior remain unproven until the next APK qualification.
