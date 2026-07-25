# ADR 005: Keep Home organization presentation-only

- Status: Accepted and implemented in the current visible PWA
- Date: 2026-07-20
- Scope: Pinned sessions, manual sections/cases, temporary priority/status filters and `Unpinned Sessions`

## Context

The owner needs a touch-first overview that can show fewer or more sessions than the six native Micro slots. Pinned sessions must be easy to arrange without turning placement into a queue, workflow engine or Codex-state mutation.

The former design used a fixed six-slot Cockpit plus a separate optional Spatial explorer. That navigation was superseded: spatial organization now belongs directly to Home, and every non-pinned session belongs in one `Unpinned Sessions` drawer.

## Decision

Home shows between zero and twelve pinned sessions and no fake empty slots. Pinning a thirteenth requires the user to choose one pinned session to replace. Unpinning changes only Home membership and returns the session to `Unpinned Sessions`; it never archives, deletes or otherwise changes the Codex thread.

All placement is presentation metadata. A card title, project label, box, section, selected view or physical proximity can never become thread-routing authority.

### Durable manual layout

The visible hierarchy is:

```text
section → case → session
```

- A pinned session may also remain loose directly on Home.
- Sections and cases have stable bounded IDs, names, colors and order.
- A case is visible with its cards; it is not a folder that must be opened first.
- A session appears exactly once in the manual layout.
- Removing a case returns its ordered sessions directly to Home.
- Removing a section returns the sessions from all its cases directly to Home.
- Moving or renaming layout objects never changes Codex status, ownership or execution.

The current schema permits at most 12 sections and 48 cases, which is deliberately above the 12-card Home limit while keeping storage and rendering bounded.

### Temporary priority and status focus

Home has no second automatic layout and no separate Mission Control page. A compact priority button and five direct status buttons temporarily replace the board contents with the same `SessionCard` component:

1. `Approval`
2. `Error`
3. `Working`
4. `Waiting`
5. `Completed`

Each status button filters the complete validated catalog, so matching pinned and unpinned sessions remain one tap away. The priority focus contains every pinned session plus every unpinned non-idle session, ordered as pinned attention, other pinned, then unpinned attention. Within a group, reliable status priority and recent activity decide presentation. Toggling the active button off returns to the exact manual sections, cases, colors and order.

These focuses are read-only presentation projections. They are not stored in Product State, do not permit drag/reclassification, and never change pin membership or Codex state. Idle unpinned sessions remain in `Unpinned Sessions`.

### Session catalog

Every session not in `pinnedThreadIds` is presented in `Unpinned Sessions`, with search and recent/project organization. All-session visibility is part of the accepted product, so there is no legacy `Include all Codex sessions` opt-in.

The six native slots remain a separate compatibility boundary. A catalog or pinned session outside those six can be displayed and opened only through its exact supported identity; it never inherits a native Micro action merely because it is on Home.

### Persistence and replacement iPad

The authoritative Home layout is stored in Mac-owned Product State and synchronized to authenticated iPads. Updates include an expected revision; a stale writer receives a conflict and reloads current state instead of silently overwriting it. Local browser storage is a startup/offline fallback, not the cross-device authority.

No simultaneous multi-iPad collaboration UX is required. The revision boundary only needs to prevent corruption if two authenticated clients briefly overlap.

### Interaction

- A short tap opens the exact session.
- Home has no separate Arrange mode. In the unfiltered manual layout, a 420 ms long press starts direct movement on the same contact; movement before activation remains page scrolling.
- The resulting touch drag can reorder before a card, enter another case, or return to the direct-Home area; a six-pixel threshold separates movement from a held stationary card.
- A committed drop suppresses card opening at Home level, including a synthetic click retargeted by the DOM reorder.
- Every drag operation has an accessible button/menu alternative.
- `New section` remains a compact persistent Home-bar action; section and case controls open locally instead of changing the whole page into an editing state.
- Touch targets follow the app's minimum target size and important behavior is never hover-only.
- Reduced Motion changes choreography, not the resulting layout.

Manual organization and temporary status focus stop at the Home boundary. Session deliberately has no derived traversal order, previous/next rail or whole-page swipe gesture. Horizontal and diagonal page drags do not open another task; vertical movement remains native page scroll. The floating product mark is the single one-touch route back to Home, where selecting a card uses the existing exact-thread opening path. Draw, Review and controls keep ownership of their own touch interactions.

## Rejected alternatives

- A permanent fixed six-card Home: conflicts with the accepted 0–12 pinned model.
- A separate Spatial page: hides the primary organization behind another mode.
- Boxes as workflow columns: invents state and drag side effects Codex does not own.
- Dragging work between agents or threads: conflates presentation with orchestration.
- Inferring placement or identity from project paths and titles: unstable and unsafe.
- Third-party cloud synchronization: unnecessary outside the Mac/iPad private boundary.

## Consequences

- Home scales naturally from one important task to a full 12-session overview.
- The user can focus priority or one reliable status without creating or persisting a second organization model.
- Product State becomes the global source of truth for layout, while non-Keep drafts remain iPad-local.
- Every real Codex mutation still needs a separate explicit control and exact revalidated destination.

## Current proof boundary

Local unit and Playwright fixtures cover 0–12 pins, loose cards, sections/cases, direct long-press movement, post-drop click suppression, touch reordering, deletion return behavior, atomic 12-slot replacement, temporary status filtering, pinned/attention priority ordering, Product State revision conflicts, the absence of Session navigation after a page drag and explicit Home return through the product mark. The UI is responsive in automated iPad landscape, iPad portrait and phone viewports.

Physical long-press/drag ergonomics, Pencil coexistence, long iPadOS suspension and replacement-iPad restoration still require recorded device tests.

## Validation gate

1. Zero, one, two and twelve pinned sessions render without fake slots.
2. A thirteenth pin requires an explicit replacement choice.
3. Every non-pinned session appears in `Unpinned Sessions` and no pinned session does.
4. Manual sections/cases and loose membership remain exact before and after every temporary focus.
5. Status focus follows only reliable status, includes matching pinned and unpinned sessions, and never persists a classification.
6. Removing a case/section returns sessions to Home without unpinning or Codex mutation.
7. Touch, Pencil-safe gestures and accessible alternatives reach the same layout result.
8. A stale Product State revision cannot overwrite the Mac record.
9. An opened card targets its exact canonical thread identity, never a label match.
10. Manual organization and status focus affect Home presentation only; Session exposes no implicit traversal order or whole-page navigation gesture.
11. Vertical movement remains native scroll; only the floating product mark provides the one-touch Home route from Session.
