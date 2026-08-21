# PartnerScreen V2 Blueprint

**Status:** reviewed, locked, and mission-ready.

## Read order

1. [`V2_MISSIONS.md`](V2_MISSIONS.md) — locked Arena mission sequence and stop conditions.
2. [`V2_ARCHITECTURE_BLUEPRINT.md`](V2_ARCHITECTURE_BLUEPRINT.md) — network/media/security architecture.
3. [`V2_INTEGRATION_CONTRACT.md`](V2_INTEGRATION_CONTRACT.md) — canonical product state and architecture↔GUI seam.
4. [`V2_IMPLEMENTATION_ROADMAP.md`](V2_IMPLEMENTATION_ROADMAP.md) — larger execution gates.
5. [`V2_GUI_PACK.md`](V2_GUI_PACK.md) — screens, overlays, Simple/Advanced modes and Theme Packs.
6. [`theme-packs.json`](theme-packs.json) — machine-readable design-token seed.
7. [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md) — short execution rules for agents.
8. [`sources/ZeroLink_2.1_PartnerScreen_Harvest_Report.md`](sources/ZeroLink_2.1_PartnerScreen_Harvest_Report.md) — teardown evidence, not product authority.
9. [`visuals/`](visuals/) — style references only.

## Authority rule

The written architecture/integration documents override generated visual boards. The boards may depict hallucinated controls such as chat, remote input, audio, raw IPs or auto-accept; those are **not** V2 features. PartnerScreen remains trusted, encrypted, explicit-consent and view-only.

`V2_MISSIONS.md` controls execution order. Arena completes one mission, opens a PR with evidence, and stops for review before starting the next mission.

## Review hardenings

Before repository integration this blueprint was tightened to require:

- RTP/RTCP protected by SRTP/SRTCP for the Local Fast Path.
- Standards-based SRTP key establishment tied to the authenticated session (prefer DTLS-SRTP); no custom cryptography.
- Measured/confidence-labelled cross-device frame age rather than guessed latency telemetry.
- No promise of seamless hot-switching between Local Fast Path and WebRTC until physical testing proves it.
- Theme font dependency/license/size/platform review before implementation.

## V2 in one sentence

Use the lowest-latency direct media path appropriate to the environment, preserve PartnerScreen trust and consent, prioritize the newest useful frame over stale completeness, expose meaningful connection truth through Simple and Advanced UI, and keep local operation independent of cloud infrastructure.
