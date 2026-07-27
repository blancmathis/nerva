# ADR 007: Control explicitly selected Codex Browser pages through a bounded driver

- Status: Accepted and implemented locally
- Date: 2026-07-21
- Scope: Site discovery, live page interaction, annotation and composer attachment

## Context

Nerva must let an iPad user inspect the sites already open beside one exact Codex task on the Mac. The user explicitly rejected both a product distinction between linked and unlinked pages and a global cross-task inventory: local development pages, Nerva itself and external HTTPS pages use one picker, but only inside the Session that owns them.

Loading a sibling site directly in the PWA is not an acceptable substitute. It would lose the Mac tab's authenticated/runtime state, can be blocked by frame policy and would share a risky hostname cookie boundary with the bridge. Exposing DevTools or a general remote desktop would grant far more authority than the product needs.

## Decision

### One unified, task-scoped page picker

`Sites` lists only bounded HTTP(S) page targets whose Codex Desktop webview conversation is proven for the requested canonical thread. The list has no `Linked sites`, `Unlinked browser tabs`, registry or association category.

The inventory:

- accepts only `page` targets with an HTTP(S) URL;
- requires each debugger socket to resolve to loopback;
- uses the Desktop ownership identity when available to attest discovery;
- removes credentials, query strings and fragments;
- returns at most 64 rows with a sanitized title and URL;
- derives a stable opaque ID from Codex's conversation and Browser-tab identities;
- never returns the debugger socket;
- reads Codex's Browser snapshot and uses the tab's canonical `ownerRoutePath` instead of inferring ownership from the page title, displayed URL, project, focus, recency or spatial position;
- resolves the exact renderer webview by its conversation and Browser-tab identities, and verifies its `guestWebContentsId` against the snapshot;
- maps that webview to one loopback CDP target with a read-only navigation-generation fingerprint, so two pages with the same URL remain distinct;
- returns no page from another conversation and repeats the same proof before every frame or control operation.

Choosing a row is the user's explicit per-use instruction to operate that already task-scoped page from the currently visible Session. The browser association belongs to Codex Desktop, not a second persistent Nerva registry. A raw tab ID from another Session is rejected even if a caller bypasses the picker UI.

The legacy registered-site APIs remain compatibility code for the older image Review path. They are not used by the visible `Sites` picker and confer no authority on this live-tab driver.

### Fresh resolution and typed control

Before every frame or input operation, the bridge rediscovers the verified renderer and resolves the opaque ID again. A closed or replaced target therefore fails with a conflict instead of falling through to a similar page.

The authenticated API exposes only:

- one bounded current-viewport JPEG frame;
- tap coordinates from 0 to 8192;
- scroll coordinates plus deltas bounded to ±4000;
- text insertion bounded to 1000 characters;
- `Enter`, `Backspace`, `Escape` and `Tab`;
- Back, Forward and Reload.

Frame/control work is rate-limited and has per-device and bridge-wide concurrency leases. Mutation routes require the exact PWA Origin, bearer and mutation admission. The bridge keeps the CDP socket and commands private.

The PWA can request a new HTTP(S) page for the exact task through the durable `openBrowserTab` command. The bridge validates the URL, dispatches Codex's native `open-browser-tab` host message and observes the exact task inventory before confirming success. It never creates a raw CDP target or silently replaces the selected page. The API does not accept JavaScript, selectors, object paths, raw CDP payloads, downloads, clipboard reads, filesystem paths, browser permissions, extensions or desktop capture.

### Browse then annotate

The Site workspace displays the returned page frame full screen and refreshes it while browsing. Electron's hidden webview capture is normalized by the bridge from the Mac display's physical Retina resolution to the page's CSS-pixel viewport before transport. The PWA displays that JPEG as a native image and overlays one transparent bounded 1× ink canvas; it does not repaint the base page into a second Retina canvas in iPadOS. Touch gestures become typed tap or scroll controls; a compact dock provides Back, Forward, Reload and bounded text entry.

The first Pencil contact freezes the current frame and begins an ink stroke. A user without Pencil can enable `Touch + Pencil`, after which the first finger stroke performs the same transition. `Annotate` is also available explicitly.

Annotation is intentionally smaller than the general Drawing and Review surfaces. It provides colors, width, Undo, Clear, Browse and Send. It has no filmstrip, blank frame, Photo/Files, Camera, comparison deck or instruction field.

`Send` composites the frozen frame and ink into one PNG and reuses the exact native composer-attachment path. It supplies an empty instruction and does not submit the Mac composer or create an app-server Review turn.

## Failure behavior

- Empty discovery shows `No Browser pages are open for this task yet`; a validated URL or favorite can still create the first native page.
- A missing or changed private Browser adapter disables discovery/opening explicitly instead of guessing after a Codex update.
- Duplicate URLs remain separate rows because ownership and target resolution do not depend on URL uniqueness.
- A post-dispatch opening result that cannot be observed is recorded as unknown and is never retried automatically.
- A target that disappears or fails re-attestation becomes unavailable; no other page is selected automatically.
- Frame or control errors remain visible in the Site workspace and never cause replay against another tab.
- Browsing may remain available while native task mutation authority is degraded; final Send remains disabled until exact composer attachment is live.
- Returning to Browse discards the current frame's local ink and resumes fresh page frames.

## Rejected alternatives

- A visible linked/unlinked split: it does not match the user's page model and adds a false hierarchy.
- A global picker followed by manual choice: it exposes unrelated task context and lets a raw tab ID cross Session boundaries.
- Inferring task ownership from title, displayed URL, focus, project name or timing: it can select the wrong page.
- A generic URL proxy, iframe or raw `Target.createTarget`: it bypasses Codex's Browser ownership and permission flow, loses Mac state or expands storage, SSRF and frame-policy risk.
- Exposing CDP or arbitrary JavaScript: it grants general browser execution.
- Streaming the whole desktop: it exposes unrelated private content and turns the product into remote desktop software.
- Reusing the full Review/Drawing studio: filmstrip, imports, blank frames and comparison controls obstruct the simple browse-to-ink interaction.

## Consequences

- Every proven site for one exact Codex task is presented uniformly, while other tasks remain absent.
- Codex Desktop's conversation binding establishes task scope; user choice then authorizes one opaque target inside that scope for the interaction.
- Live navigation preserves the actual Mac tab state without loading its origin inside the PWA.
- The Site surface stays focused and touch-first, while imported-image Review remains a separate workflow.
- A browser restart or target replacement requires choosing the page again.

## Current proof boundary

Unit tests cover task-scoped snapshot parsing, duplicate URLs, cross-task exclusion, ambiguous target rejection, sanitized output, native page opening, exact-target commands, thread-bound frame/control routes and Retina-to-1× frame normalization. Playwright covers six Chromium/WebKit tablet/phone profiles, including opening the first page for an empty task, opening a typed address as a new native page, favorites, intentionally imperfect touch paths, automatic Pencil transition, finger annotation mode and absence of the old filmstrip/import controls.

These are local code and browser-fixture proofs. A physical iPad must still verify real Codex Browser rendering, Apple Pencil contact, palm behavior, orientation/background recovery and the visible annotated-PNG attachment in the exact Mac composer.
