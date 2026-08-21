# Product Boundary

## Promise

PartnerScreen lets two trusted Android phones pair once. While both are on the same local network, either partner can request to view the other's screen. The sharing owner remains in control and capture never starts silently.

## Canonical flow

`Pair → persist trusted pair → discover trusted partner → Request Screen → authenticated pending request → Accept/Decline → Android MediaProjection consent → foreground service/capture → WebRTC negotiation → actual first rendered viewer frame → LIVE → Stop/revoke/fatal termination → complete cleanup → paired Home`

A second complete session must succeed after teardown.

## V1 scope

- Android only.
- Expo/React Native application with TypeScript product/domain state.
- Kotlin Expo Modules only at Android/native capability boundaries.
- Custom native development/production build; Expo Go is not product evidence.
- Same Wi-Fi/LAN operation.
- Local authenticated control/signaling.
- Direct peer-to-peer WebRTC video.
- One trusted partner relationship.

## Explicit non-goals

Do not add as implementation conveniences:

- recording or screenshots of the shared screen;
- remote touch/keyboard/mouse/shell control;
- microphone sharing or camera media streaming;
- accounts or cloud identity;
- hosted signaling, cloud media, TURN or VDO room architecture;
- analytics, advertising or tracking;
- file transfer, chat, multi-party rooms/calling;
- browser/Flutter runtime.

Changing these boundaries is a product decision.

## LIVE definition

Product `LIVE` means:

> the current viewer session has the expected remote video track attached and the native renderer has reported an actual first rendered frame for the current renderer/track epoch.

ICE connected/completed, signaling stable, `onTrack`, renderer mount, or a non-null stream are not LIVE truth.

## Privacy

- Screen capture begins only after request acceptance and Android's system capture consent.
- Media is direct to the paired partner on the local network in V1.
- PartnerScreen does not record the shared screen or provide remote control.
- Pair credentials use the secure-storage/Android Keystore boundary.
- Diagnostics must not contain pair secrets, encryption keys, raw QR secrets, full SDP/ICE credentials, private endpoint details, or screen content.

## Durable local state

Keep persistence deliberately small:

- stable local device ID and user-selected name;
- confirmed pair metadata plus secure pair secret;
- small settings such as availability/quality preference;
- pending authenticated request metadata where required;
- bounded sanitized diagnostics.

Ordinary non-secret metadata may use AsyncStorage. Secret/trust material belongs only behind the SecureStore/Android Keystore-backed boundary.
