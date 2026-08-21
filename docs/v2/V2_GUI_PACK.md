# PartnerScreen V2 — GUI Pack

## 1. GUI philosophy

PartnerScreen does not hide technical truth and does not dump engineering internals on every user.

The product has three independent axes:

```text
Interface Mode   = Simple | Advanced
Theme Pack       = visual personality
Streaming Profile= Adaptive | Low Latency | High Motion | High Clarity
```

Changing Interface Mode or Theme Pack never restarts a session by itself.

**Simple shows what matters. Advanced shows why. Diagnostics shows everything safe to expose.**

## 2. Screen map

No bottom-tab requirement is imposed by V2. Navigation should remain compact.

Core screens:
1. Home
2. Pair Partner
3. Incoming Request
4. Sharing
5. Viewer
6. Connection
7. Settings
8. Diagnostics

### Home

Simple:
- trusted partner
- online/offline/reachable state
- selected/best route
- `Request Screen`
- last-session summary

Advanced additionally:
- all viable routes
- capabilities
- direct/relay
- media engine
- last-session latency/FPS/resolution/loss
- current connection policy

### Pair Partner

- Show QR
- Scan QR
- authenticated completion
- fingerprint/verification details in Advanced
- capability exchange
- no six-digit durable trust

### Incoming Request

Primary:
- partner identity
- requested/selected route
- `Share Screen`
- `Decline`

Advanced:
- media engine
- trust verification
- session fragment
- encryption state

Then invoke Android's MediaProjection consent.

### Sharing

Simple:
- partner
- LIVE
- route
- basic quality/latency
- `Stop Sharing`

Advanced:
- engine/protocol
- codec
- resolution/FPS/bitrate
- frame age
- encoder backlog
- loss/RTT
- adaptation reason

### Viewer

The video owns the screen.

Default controls auto-hide and reappear on tap.

Gestures:
- pinch zoom
- pan when zoomed
- double-tap Fit / 1:1
- reset on geometry/orientation change

Simple overlay:
- partner
- LIVE
- route
- latency
- resolution/FPS
- Fit
- Quality
- PiP
- More
- Stop Session

Advanced overlay can expand:
- engine/protocol
- codec
- frame age
- bitrate
- encode/decode/render FPS
- RTT/jitter/loss
- backlog/drops
- NACK/recovery
- route and relay state

### Connection

Simple:
- Automatic
- current route
- route quality
- automatic-policy summary

Advanced:
- Automatic
- Wi-Fi Direct only
- LAN only
- Internet only
- local fast path preference
- local WebRTC fallback
- Internet enable
- TURN relay enable
- currently viable routes

### Settings

Sections:
- Interface: Simple / Advanced
- Appearance: Theme Pack, System/Dark/Light, Motion
- Device
- Trusted Partner
- Connections
- Streaming
- Browser Access
- Notifications
- Privacy & Security
- Diagnostics
- About

### Diagnostics

Simple:
- route
- connection health
- latency
- frame age
- video mode
- loss
- encryption
- clear problem summary
- export sanitized report

Advanced:
- complete sanitized network/media/recovery/session telemetry

## 3. Button language

Use explicit verbs.

Primary:
- Request Screen
- Share Screen
- Reconnect
- Retry Connection
- Request Again
- Open Viewer

Termination:
- sharer: Stop Sharing
- viewer: Stop Session

Trust destruction:
- Forget Partner (confirmation required)

Avoid vague `Retry` when the resulting action can be named precisely.

## 4. Overlay system

Overlays are a first-class Viewer/Sharing interaction model.

Priority:
1. Security / consent
2. Terminal connection error
3. Reconnecting
4. Incoming request
5. Route change
6. Quality adaptation
7. Stats / controls
8. Gesture hints

Examples:

**Reconnecting**
- keep the last good frame visible, slightly dimmed
- show attempt and last-frame age
- do not eject the user to Home

**Adaptation**
- briefly disclose `720p60 -> 540p60`
- Advanced shows reason (frame age/backlog/loss)

**Relay switch**
- show `Internet • Relay`
- explain that direct route was unavailable and encrypted media is relayed

**Wi-Fi Direct**
- show setup state
- disclose possible temporary Internet interruption

**PiP**
- minimal system-appropriate actions only
- complex stats/settings return in full viewer

## 5. Visual system

Direction:
**technical-premium, precise, connected, calm.**

Core principles:
- dark-first but light-mode capable
- restrained glass
- crisp typography
- route/state color semantics
- motion communicates state, not decoration
- low-GPU viewer variants
- high contrast and accessibility
- no UI effect may compromise video freshness

Use Expo/native capabilities where appropriate:
- BlurView / performance-safe fallback
- native/universal bottom sheets
- gradients
- Reanimated
- haptics
- native symbols/icons
- platform-native controls
- platform glass enhancements only when supported

## 6. Theme Packs

V2 ships eight curated first-party packs:

1. **Signal Glass** — default; obsidian + cyan/blue, restrained glass.
2. **Carbon Relay** — industrial, low blur, acid-lime operational accents.
3. **Aurora Link** — elegant cyan/indigo/violet aurora treatment.
4. **Prism HUD** — instrumentation/telemetry-first advanced feel.
5. **Frosted Circuit** — calm native-premium, strongest light/dark symmetry.
6. **Redline Broadcast** — high-contrast live/ops visual language.
7. **Monochrome Flux** — grayscale luxury minimal; route/state provides color.
8. **Spectral Connect** — expressive cyan/violet/magenta showcase theme.

**Default:** Signal Glass.

Every theme defines:
- semantic colors
- route colors
- type
- surfaces
- radius
- blur/glow
- buttons
- overlays
- icon treatment
- motion
- haptic intensity
- full / reduced-motion / low-GPU / viewer / PiP variants

Theme changes do not alter session/network/media behavior.

## 7. Route semantics

Labels are always present; color is supplementary.

Semantic concepts remain stable across themes:
- Wi-Fi Direct
- LAN
- Internet
- Relay
- Live
- Warning
- Error

A theme may vary the exact hue, but must preserve accessibility and avoid semantic collisions.

## 8. Typography

Theme packs may select an approved readable family, but telemetry uses tabular numerals. Theme font names are design intent until implementation verifies licensing, package size, platform rendering, and Expo compatibility; no theme may introduce an unreviewed font dependency.

Recommended practical families:
- Inter
- Geist
- Space Grotesk
- Rajdhani (Carbon)
- Roboto Condensed / Barlow Condensed (Redline)
- system UI where appropriate (Frosted Circuit)

Avoid typography that reduces small-metric readability.

## 9. Glass / effects performance rules

Glass is strongest in:
- viewer control overlays
- status HUD
- connection/quality sheets
- floating request/recovery surfaces

Avoid:
- permanent full-screen blur
- every Home/Settings row as glass
- animated shader work over live video

Enhanced themes can animate on Home/pairing.
During high-load viewing they retain their identity using static or low-cost variants.

## 10. Generated visual boards — usage rule

The four supplied concept boards are **style references**, not feature specifications.

Ignore any generated depiction of:
- remote control
- keyboard injection
- chat requirement
- audio requirement
- raw IP display
- AES labels not grounded in the selected transport
- permanent auto-accept

The written Architecture Blueprint and Integration Contract are authoritative.
