# PartnerScreen V2 — Architecture / GUI Integration Contract

This file is the seam between media/network engineering and product UI.

## 1. One canonical product state

The GUI never infers transport truth from labels or component-local state.

Architecture publishes a sanitized `SessionPresentationState`.

Minimum fields:

```text
partner
  displayName
  trustState
session
  state: idle | requesting | incoming | connecting | live | reconnecting | error
  role: sharer | viewer
connection
  route: wifi_direct | lan | internet | relay
  direct: boolean
  engine: local_fast | webrtc
  health: excellent | good | degraded | poor
media
  codec
  width / height
  targetFps / actualFps
  bitrate
  frameAgeMs
  frameAgeConfidence: measured | estimated | unavailable
  backlogFrames
metrics
  rttMs
  jitterMs
  packetLossPct
  droppedFrames
  nackCount
  recoveredCount
recovery
  attempt
  maxAttempts
  lastFrameAgeMs
security
  encrypted
  relayActive
capabilities
  pip
  wifiDirect
  localFastPath
```

All fields are optional/capability-aware where platform APIs cannot supply them. `frameAgeMs` must never be presented as exact when cross-device clock correlation is unavailable.

## 2. Simple vs Advanced

Simple and Advanced consume the same canonical state.

Simple:
- route
- direct/relay
- health
- latency/frame age
- resolution/FPS
- meaningful adaptation/recovery

Advanced:
- engine/protocol/codec
- bitrate
- queue/backlog
- loss/jitter/RTT
- recovery counters
- detailed route policy

No duplicate state machines.

## 3. Theme Packs

Themes receive semantic tokens and presentation state only.
Themes cannot:
- change route choice
- change media profile
- change retry behavior
- weaken security
- expose sanitized-away values

## 4. Required GUI events

Architecture -> GUI:
- partner availability changed
- route probing
- route selected
- Wi-Fi Direct setup/teardown
- request received
- consent required
- media negotiating
- first frame
- live
- quality adapted
- route changed
- reconnect started/attempt/recovered/failed
- relay activated/deactivated
- session ended

GUI -> Architecture:
- request screen
- accept / decline
- stop sharing / stop session
- reconnect
- connection-policy change
- streaming-profile change
- enter PiP
- viewer fit/zoom state (presentation only)

## 5. LIVE definition

`LIVE` is earned only after a current-session remote frame is actually rendered.

Availability, signaling, offer/answer, ICE connectivity, capture start, track attachment, or mounting a renderer do not by themselves mean LIVE.

## 6. Adaptation disclosure

When automatic adaptation materially changes the stream, emit a structured reason:

```text
from: 720p60
to: 540p60
reason: frame_age | encoder_backlog | network_loss | thermal | codec_limit
```

Simple may show one sentence.
Advanced may show the reason and triggering metric.

## 7. Route disclosure

GUI labels:
- `Wi-Fi Direct • Direct`
- `LAN • Direct`
- `Internet • Direct`
- `Internet • Relay`

Do not display TURN as if it were a separate user destination; Relay is the user-facing route state.
Advanced details may identify TURN as the relay mechanism.

## 8. Error behavior

Errors never destroy trusted pairing unless the trust relationship itself is revoked.

UI must distinguish:
- partner offline
- route unavailable
- capture/consent failure
- media failure
- reconnect exhaustion
- relay unavailable

The action label must match the recovery operation.
