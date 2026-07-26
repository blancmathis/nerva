---
context_room:
  kind: index
  scope: product
  status: current
  canonical_for: product documentation navigation
  last_verified: 2026-07-26
  sources: [docs/product/FEATURES_target.md, docs/product/SITE_QA_RECORDER_target.md, docs/product/CAPTURE_INBOX.md, docs/product/PAIRING_target.md, docs/product/CURRENT_STATE.md, docs/COLLABORATIVE_DIAGRAMS.md]
---

# Nerva — product documentation

This directory is the editorial source of truth for the product. It deliberately separates accepted target behavior from implementation evidence.

## Reading order

1. [`CURRENT_STATE.md`](./CURRENT_STATE.md) — what is observable in the repository and which runtime or physical proofs remain open.
2. [`FEATURES_target.md`](./FEATURES_target.md) — the accepted target product specification from the product interview.
3. [`SITE_QA_RECORDER_target.md`](./SITE_QA_RECORDER_target.md) — the Recorder target contract; Current State owns implementation claims.
4. [`CAPTURE_INBOX.md`](./CAPTURE_INBOX.md) — the implemented local capture library and its no-send guarantees.
5. [`PAIRING_target.md`](./PAIRING_target.md) — the no-typing pairing target, under-two-minute objective, and security invariants.
6. [`../COLLABORATIVE_DIAGRAMS.md`](../COLLABORATIVE_DIAGRAMS.md) — the implemented Codex → Draw → graph/Pencil → Mac protocol and limits.
7. [`../RELIABILITY.md`](../RELIABILITY.md) — capability evidence, PWA updates, notifications, and bounded integrations.

## Interpretation rule

- Target-specification documents describe what the product **must become**. They are not proof that a behavior is implemented or physically verified.
- `CURRENT_STATE.md` and `CAPTURE_INBOX.md` describe the currently observed implementation and name their evidence boundaries.
- The full GRILL ME interview is the source of accepted product decisions. A later correction replaces an earlier answer. After the user established “no answer means the recommendation is accepted,” an unanswered recommendation is treated as confirmed.
- Technical documents under `docs/` describe current architecture and setup. They cannot silently redefine the product target. Use target files for future behavior and Current State for present behavior.

## Status vocabulary

- **Accepted target:** an explicit user decision or an accepted recommendation. Implementation must respect it, but it may not exist yet.
- **Implemented:** present in source and covered by identified local evidence.
- **Live verified:** observed against the exact installed Mac/Codex runtime.
- **Physically verified:** completed on the named real iPad/Mac hardware.
- **Unknown:** required evidence is missing; this does not reopen the accepted product decision.

## Documentation ownership

| Topic | Canonical owner |
| --- | --- |
| Short public installation path | [`../../README.md`](../../README.md) |
| Detailed Mac procedure | [`../SETUP_MAC.md`](../SETUP_MAC.md) |
| Detailed iPad procedure | [`../SETUP_IPAD.md`](../SETUP_IPAD.md) |
| Supported/observed versions | [`../COMPATIBILITY.md`](../COMPATIBILITY.md) |
| Repair procedures | [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) |
| Dated validation evidence | [`CURRENT_STATE.md`](./CURRENT_STATE.md) |
