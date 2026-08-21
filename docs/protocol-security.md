# Protocol & Security

## Security stance

- Treat the LAN as untrusted.
- QR bootstrap material can be photographed/replayed; keep it short-lived and one-time.
- Durable pair trust is separate from temporary session/network state.
- Authentication, decryption, replay, identity, ownership or state ambiguity fails closed.
- Screen capture authority remains local to the sharing phone and Android MediaProjection consent.

## Pairing

Pairing uses a fresh QR bootstrap credential to establish an authenticated local bootstrap channel, exchange authenticated device identity, obtain human confirmation, and converge on a fresh durable pair key.

Canonical bootstrap messages:

- `PAIR_HELLO`
- `PAIR_IDENTITY`
- `PAIR_CONFIRM`
- `PAIR_COMMIT`
- `PAIR_COMMIT_ACK`
- `PAIR_CANCEL`
- `PAIR_ERROR`

Important rules:

- remote identity is shown only after authenticated bootstrap;
- self-pairing and already-paired/invalid attempts are rejected visibly;
- temporary QR/bootstrap material is not persisted;
- the durable pair secret is stored only through secure storage;
- ordinary persisted partner metadata contains no secret;
- unconfirmed/staged pair state does not become trusted Home truth after restart;
- cancellation/revoke destroys required temporary/durable material and surfaces cleanup failure rather than pretending success.

## Trusted control messages

Product-session messages remain intentionally narrow:

- `REQUEST_SCREEN`
- `REQUEST_CANCEL`
- `ACCEPT_SCREEN`
- `DECLINE_SCREEN`
- `CAPTURE_DENIED`
- `RTC_OFFER`
- `RTC_ANSWER`
- `RTC_ICE`
- `SESSION_END`
- `SESSION_ERROR`

Do not add speculative message types or use a transport event as product state truth.

## Envelope / validation

Trusted control traffic carries protocol version, message identity/type, product `sessionId` where applicable, authenticated sender context, timestamp and typed payload.

Before side effects:

1. decrypt/authenticate;
2. confirm the expected trusted partner;
3. validate supported version/type and payload shape;
4. validate the session belongs to the active/pending state;
5. validate timestamp/freshness;
6. reject duplicate/replayed message IDs;
7. enforce busy/state rules;
8. route exactly once.

Unknown/malformed/stale input yields a typed rejection/diagnostic rather than an unchecked crash or permissive fallback.

## Pairing crypto boundary

The implemented pairing wire uses AES-256-GCM with authenticated attempt/sender/version/sequence context and a canonical `h1:` hexadecimal representation. Production adapters self-test the AES boundary before use. The exact implementation and tests are authoritative if this summary becomes stale.

The QR bootstrap credential is not claimed to provide forward secrecy if an attacker both captures that credential and records the full bootstrap exchange. A cryptographic protocol change requires explicit threat-model review.

## Diagnostics/logging

Never persist or print:

- pair/bootstrap/durable trust secrets;
- secure-store/keystore key material;
- raw QR secret payloads;
- full SDP;
- ICE usernames/passwords;
- screen pixels/content;
- private native stack/endpoint details that could leak sensitive network information.

Prefer bounded event kinds, session-safe identifiers where necessary, lifecycle stages, sanitized failure classes and build identity.

## Runtime infrastructure boundary

Do not silently introduce Firebase/Supabase/API routes/hosted signaling/cloud media/TURN to solve local connectivity. Build services may produce binaries; they are not PartnerScreen runtime infrastructure.
