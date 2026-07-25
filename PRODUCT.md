# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Nerva is built for a developer supervising and steering agentic development from an iPad or phone while Codex Desktop runs on a paired Mac. The primary use is touch and Apple Pencil; mouse and keyboard remain supported but do not define the interaction model.

## Product Purpose

Nerva makes concurrent agentic work visible and controllable away from the Mac. It provides exact-session navigation, tactile visual input, bounded browser control, local capture, review, and decision surfaces while the Mac remains the authority for execution, native composition, permissions, repositories, and Codex behavior.

The canonical product documentation is [`docs/product/INDEX.md`](./docs/product/INDEX.md). Current behavior is owned by [`docs/product/CURRENT_STATE.md`](./docs/product/CURRENT_STATE.md); unimplemented completion bars stay in adjacent `_target.md` documents.

## Positioning

Nerva is not a remote desktop or a Stream Deck replacement. It uses the iPad as a full visual and tactile control surface: sessions remain exact, visual context can be drawn or captured, live Codex Browser pages can be inspected, and structured QA evidence can return to the agent that owns the work.

## Operating Context

- Installed Home Screen PWA on iPadOS or iPhone, connected privately to the Mac bridge through Tailscale Serve.
- Codex Desktop and its app-server remain the execution and task authority.
- The browser surface controls only HTTP(S) pages proven to belong to the exact Codex Session shown on the iPad.
- UI and generated prompt text are English; product documentation may be French.
- Local-first drafts must survive ordinary suspension and never auto-send after reconnection.

## Capabilities and Constraints

- Home exposes validated pinned sessions plus temporary priority/status filters across the complete catalog, without exposing subagents.
- Session actions use exact canonical thread identity; title, project, URL, focus, or recency never grant mutation authority.
- Drawing, Capture Inbox, Review, Site control, model/reasoning controls, Skills, notifications, global Product State, and Saved Drawings have separate capability and persistence boundaries.
- Site navigation may accept an explicit HTTP(S) address only for a user-selected, re-attested Codex Browser tab in the current Session. Credentials and non-HTTP(S) protocols are rejected.
- Site favorites are private global Product State, not public bookmarks or automatic site associations.
- Site QA Recorder produces a bounded, privacy-reviewed action manifest and evidence bundle; it never extracts auth state, a complete DOM, raw CDP, console, HAR, or network bodies.
- Skills selected for a Nerva-generated text payload are appended in English at the absolute end.
- Physical iPad/Pencil, long suspension, Focus, and real Codex Browser behavior require recorded device proof before being called complete.

## Brand Commitments

The public name is **Nerva**. The interface is calm, highly professional, touch-first, and explicitly inspired by the structural clarity of Apple platforms and the tactile luminous character of Codex Micro hardware, without copying proprietary assets. Liquid Glass is reserved for navigation, floating controls, and sheets; content surfaces remain opaque. Important controls feel physical, while secondary controls remain quiet.

## Evidence on Hand

- Product truth: [`docs/product/`](./docs/product/)
- Current architecture and proof boundaries: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), [`docs/RELIABILITY.md`](./docs/RELIABILITY.md)
- Adaptive visual tokens: [`apps/web/src/styles/tokens.css`](./apps/web/src/styles/tokens.css)
- Existing responsive screenshots: [`docs/screenshots/`](./docs/screenshots/)
- Automated browser fixtures and screenshots: [`apps/web/e2e/`](./apps/web/e2e/)

No customer claims, benchmarks, endorsements, or public deployment guarantees may be invented.

## Product Principles

1. Exact identity before convenience.
2. Touch should reveal capability without exposing dangerous authority.
3. Local capture and reconnect never imply delivery.
4. Degraded states remain useful but honest.
5. Visual evidence is reviewed before it becomes agent context.

## Accessibility & Inclusion

Every interactive target is at least 44 CSS pixels for coarse pointers. The interface supports safe areas, visible keyboard focus, increased contrast, reduced motion, reduced transparency, light/dark/system themes, portrait/landscape iPad, and phone layouts. No required action depends on hover.
