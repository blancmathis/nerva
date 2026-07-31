---
context_room:
  kind: canonical
  scope: product
  status: draft
  canonical_for: accepted target product behavior and organization
  last_verified: 2026-07-26
  sources: [docs/product/PAIRING_target.md, docs/product/SITE_QA_RECORDER_target.md, docs/product/CURRENT_STATE.md]
---

# Nerva — target product specification

> This file records the accepted product target from the complete product interview. It does not prove that every behavior is implemented or physically verified. [`CURRENT_STATE.md`](./CURRENT_STATE.md) is the canonical implementation/evidence record.

## 0. Product name and direction

The public name is **Nerva**. Visible UI, installable metadata, and pairing use that name. Historical `codex-pad` / `CodexPad` identifiers remain internal compatibility details so upgrades do not lose paired devices, global state, or scripts.

Nerva begins as an iPad companion for Codex Desktop and can grow into a broader agentic-development interface: task supervision/control, voice interaction, Context Room, and bounded temporary visual cards during conversation. Agent-provided cards must use a strict Nerva schema; arbitrary HTML, JavaScript, CSS, URLs, and event handlers are forbidden.

## 1. Positioning and invariants

Nerva is a tactile and visual extension of Codex Desktop on the Mac, not a replacement. The iPad monitors and chooses tasks, organizes important work, invokes a small set of native actions, starts Mac-owned dictation, works with graphs, draws, adds photos, and reviews sites. The Mac remains the source of truth, execution host, repository owner, and Codex permission boundary.

Non-negotiable principles:

1. Every remote action targets the exact displayed task identifier. Title, project, URL, recency, position, or foreground window is never routing authority.
2. New tasks are created on the Mac. The iPad does not create, fork, archive, or delete Codex tasks.
3. The iPad exposes no terminal, arbitrary shell, raw CDP, or arbitrary computer-use primitive. Typed HTTP(S) navigation applies only to an explicitly selected, re-attested Codex Browser page for the exact Session.
4. All visible UI and any injected prompt text are English.
5. Agent activity is shown only when supported by reliable state. Nerva never invents what an agent is doing.
6. Nerva invokes Codex-native actions; it does not reimplement Queue/Steer, permission, model, or send semantics.
7. A missing or stale capability remains unavailable. No simulated success.
8. Browser automation is not physical Mac/iPad/Pencil proof.

## 2. Surface map

```text
Pairing → Home ↔ Capture Inbox
              ↓
           Session
    ┌─────────┼──────────┬────────────┐
    Draw     Photo      Sites       Saved Drawings
      ↓        ↓          ↓
   Boards    Review    Site Review → Site QA Recorder
```

Settings is globally reachable. System Diagnostics exists only in Settings. There is no separate Mission Control, Automatic by Status page, Artifact Wall, Arrange mode, or cross-session swipe.

## 3. Home and pinned Sessions

### 3.1 Displayed set

- Home shows 0–12 user-pinned Sessions; no default pins and no fake empty slots.
- Pinning a thirteenth asks which existing pin to remove.
- `Unpinned Sessions` lists non-pinned tasks, searchable and sortable by recent use or project.
- Unpinning only returns a Session to that list; it never archives or deletes the Codex task.
- A compact control opens the task currently active on the Mac.
- A partial catalog must not erase known pins. Only an explicit unpin or authoritative tombstone removes identity.

### 3.2 Codex usage

Home shows compact real Codex rate-limit windows, emphasizing remaining quantity rather than used quantity. It must fit the same vertical rhythm as `Open current Mac session`, show accessible reset timing, and display `Usage unavailable` rather than inventing values.

### 3.3 Cards

Cards are spacious, touch-first agent keys, not dense dashboard rows. They may show:

- Session name;
- project/repository;
- worktree and branch when known;
- status through both color/light and text;
- trustworthy duration/activity such as `Working for 8 minutes`, `Waiting for your answer`, or `Completed 2 minutes ago`.

State light: blue Working, amber Needs approval, red Error, violet Waiting, green Completed, silver Idle. Light should feel natural and materially integrated, not decorative glare.

### 3.4 Card opening and drag

A tap opens that exact Session on the iPad and requests the exact task on the Mac when native navigation is available. A long press begins direct drag without entering a separate Arrange mode. Dropping must never open any Session. Clear hit targets and a no-click-after-drag lock are required.

### 3.5 Explicit navigation

Session switching is explicit. There is no invisible page-grab swipe, horizontal rail, pagination, or inferred neighbor order. The floating Nerva brand returns Home in one touch; the user then chooses another Session.

## 4. Home organization and attention

### 4.1 Durable layout

All pins start loose on Home. The user may create visible sections and cases only when useful:

- sections can contain cases and loose cards;
- cases can be created, named, recolored, moved, and deleted;
- sessions can move among loose Home, sections, and cases;
- deleting a case returns its Sessions directly to Home without unpinning them;
- a compact `New section` action is always available;
- manual structure, case placement, and order persist globally.

Sections behave like visible iPhone folders: their contents remain directly tappable without opening a separate folder page. The layout adapts from three to two to one column and scrolls rather than shrinking cards as the count grows.

### 4.2 Priority and status focus

One compact priority control temporarily surfaces tasks most likely to require attention. Base order:

1. pinned + attention;
2. other pinned;
3. unpinned + attention.

Direct `Approval`, `Error`, `Working`, `Waiting`, and `Completed` controls filter the same validated Session cards. A filter is temporary and never modifies pins, sections, cases, or order. No `Attention view` banner or `Open automatic status group` copy is needed.

## 5. Capture Inbox

Capture Inbox is a local library, not a routing queue. From Home, the user may capture Photo, Scan, Sketch, File, or Note without selecting a Session. Voice is excluded.

To use an item, the user first opens the exact Session, then opens Capture Inbox. Notes and images are copied into that Session's local Review through `Use in session`; a file-only selection uses `Attach to composer`, which adds one bounded batch to the exact visible Mac composer without submitting it. Captures remain reusable and are never assigned, consumed, queued, or sent on reconnect. Mixed selections are deliberately separated, and every deletion is directly accessible and confirmed. See [`CAPTURE_INBOX.md`](./CAPTURE_INBOX.md).

## 6. Mac ↔ iPad relationship

### Following Mac

By default, opening a task on the Mac opens it on the iPad. If the iPad is in Draw, Review, Sites, or another Session sub-surface, a Mac task change closes that surface and shows the new Session controls; it must not create a blank studio for the new task. The previous iPad position and unsent local draft are preserved for return.

Opening a Session on the iPad requests that exact task on the Mac. The Home control can return directly to the Mac's current task.

### Staying here

The Session page has a one-touch explicit navigation toggle:

- `Following Mac`: iPad follows Mac task selection;
- `Staying here`: iPad remains on its current Session while Mac changes.

Switching back to Following Mac immediately opens the task already active on the Mac. Pin/Unpin is unrelated to Follow/Stay.

## 7. Session page

The Session hero is a compact agent console showing only reliable state: status, project, branch/worktree, elapsed time, and supported activity text.

### 7.1 Primary actions

`Dictation`, `Draw`, `Photo`, and `Sites` are touch-primary controls. Sites remains visible even when no page has yet been proven so the user can inspect exact-session pages, choose a favorite, or type an HTTP(S) URL through the bounded Site flow.

### 7.2 One-touch secondary controls

- Pin/Unpin;
- Following Mac/Staying here;
- compact Send prompt;
- Skills;
- Model + Reasoning;
- Fast;
- Capture Inbox;
- Saved Drawings.

Secondary controls remain at least 44×44 points without taking over the page.

### 7.3 Contextual actions

The action dock changes only when supported by the exact state:

- working: Open on Mac, Open site, Draw, Dictation, Camera;
- approval: View command, Approve, Reject, Add instruction;
- completed interface: Open result, Compare, Annotate, Send correction;
- empty native slot: no fake new-task action—the iPad does not create tasks.

There is no general Steer control on the iPad. Native Codex decides Queue/Steer after a real composer submit.

## 8. Skills, dictation, and sending

### 8.1 Skills

Skills are loaded for the exact Session cwd. Automatic grouping should reduce scanning:

- provider/family groups with at least two skills become collapsible folders;
- a single skill remains directly visible, not wrapped in an empty-looking folder;
- the user can arm one or more skills for the next Nerva-controlled text payload.

The injected skill instruction is always the absolute final text of that payload, even if skills were selected before later transcription. Image-only Draw/Photo delivery contains no skill suffix and keeps armed skills for the next text-bearing action. Nerva does not intercept text typed directly on the Mac.

### 8.2 Native dictation only

Session Dictation presses Codex Desktop's exact native microphone binding. The Mac-selected microphone, Codex transcription, and native composer remain authoritative. The iPad records no Session audio, shows no transcript editor, and requests no microphone permission for Session Dictation.

If the user taps Send prompt during active dictation, Nerva first releases the exact dictation control, waits for a confirmed stop and refreshed native state, then submits the exact composer. Failure or unknown stop result means no automatic submit.

### 8.3 Images and Send action

Draw and Photo have one direct `Send`. There is no instruction field or `Review before send` label. Confirmed output is attached to the exact visible native Mac composer and never submits it. The send animation starts only after real confirmation.

On failure or unknown outcome, the draft and same idempotent identity remain available. Recovery may restore the iPad copy without deleting any Mac attachment already present. No automatic retry, alternate task, fork, queue, or steer occurs.

The separate compact `Send prompt` invokes only the exact native composer submit. Codex Desktop owns whether that becomes Queue or Steer under user settings; Nerva does not present fabricated queued/sent tracking.

### 8.4 Future Nerva Voice

Nerva Voice is outside the current delivery target. It may later provide conversational control and bounded visual cards, but it must not weaken exact-task routing, user review, or schema safety.

## 9. Draw, Photo, Boards, and Saved Drawings

### 9.1 Shared editor

Draw is a virtually infinite vector board with most of the screen reserved for the canvas. Pencil draws; one palm/finger is passive in Pencil mode; two fingers pan and zoom; Hand supports mouse/finger camera navigation. A unified Select tool directly moves or uniformly resizes ink, shapes, text, photos and graph blocks, and an empty-area drag selects several items. Tools remain in an edge rail or compact bottom palette and never cover the working area unnecessarily.

The board can contain freehand ink, shapes, arrows, text, photos, and structured collaborative graphs in one world coordinate system. Undo is operation-based. Autosave and async imports must be generation-safe; Clear is a barrier that old saves cannot undo.

### 9.2 Finishing and export

Visible Send choices are only `Whole board` and `Select area`. Small content exports as one PNG. Large content exports a self-explaining package:

- first image is a global map;
- deterministic named rectangular regions;
- 12% overlap, neighbor references, shared alignment marks, and stable filenames;
- structured graphs add block/region and cross-region connection indexes;
- all navigation metadata exists only in exported copies, never the editable board.

At most 12 ordered images are produced under bounded pixel/byte budgets. Exact-version native multi-image attachment requires attestation; otherwise Nerva produces one 4096×4096 compatibility atlas. No text is injected and the composer is not submitted.

After confirmed Send, the board receives a `Sent` checkpoint and remains in `Boards`; the studio closes and the next Draw starts blank. Failure/unknown keeps the active board and exact export bytes. A partial batch requires resolution on the Mac and is never automatically completed.

### 9.3 Saved Drawings

`Keep` saves an explicit private Mac record with thumbnail and source Session. Saved Drawings can filter, reopen as an independent working copy, and delete manually. Editing a copy never mutates the kept original.

### 9.4 Collaborative graphs

Codex can publish multiple structured graphs into the exact task. Each graph is rendered directly in the shared infinite board rather than inside a fixed diagram frame. The iPad can choose, reopen, move or resize blocks, add a block at the current camera position, edit labels/links, combine the graph spatially with photos or other marks, and annotate with Pencil. Codex and iPad writes use expected revisions and provenance. Structured graph and freehand ink remain separate; a new Codex revision never silently erases Pencil work. A structured conflict requires an explicit choice.

Graphs are shared working documents, not one final diagram. See [`../COLLABORATIVE_DIAGRAMS.md`](../COLLABORATIVE_DIAGRAMS.md).

## 10. Site Review

### 10.1 Opening and identity

Sites is a dedicated page for the current Session. It shows only HTTP(S) pages whose Codex Browser conversation binding is proven for that exact task, with no linked/unlinked distinction. The user may choose a proven page, type an HTTP(S) URL for that chosen bounded browser flow, or use global favorites.

### 10.2 Navigation and annotation

The user can touch, scroll, enter bounded text, use supported keys, go back/forward, reload, and navigate to a typed/favorite HTTP(S) URL. Pencil—or touch when explicitly selected—freezes the visible frame into minimal annotation mode. Site Review does not show Drawing's filmstrip, blank frame, Camera, Photos, or Files.

`Send` attaches only the annotated PNG to the exact Mac composer and does not submit it. `Record flow` opens the Site QA Recorder contract in [`SITE_QA_RECORDER_target.md`](./SITE_QA_RECORDER_target.md).

### 10.3 Authority limits

Before every frame and gesture, the bridge re-proves that the opaque page belongs to the exact task. Duplicate/ambiguous mappings are omitted. The iPad receives no query strings, fragments, credentials, debugger URL, raw CDP, arbitrary JavaScript, client-provided selector, clipboard, filesystem, or full-desktop control.

## 11. Persistence, offline use, and iPad replacement

Global Mac-backed state includes pins, sections/cases/placements, preferences, selected Model + Reasoning presets, Site favorites, and Saved Drawings. Writes are revisioned and merge product domains so stale clients cannot erase unrelated changes.

Local-only state includes unsent Draw/Review drafts and Capture Inbox. The offline shell may show last-good orientation state, but mutations remain disabled until authenticated socket attestation and a fresh exact-target snapshot. Nothing local is sent automatically after reconnect.

Replacement pairing restores global state but not local-only captures/drafts. Two simultaneous iPads are not a designed collaboration scenario; temporary overlap must remain corruption-safe.

## 12. Settings, notifications, and interface quality

- System theme by default, with equally complete Light and Dark modes;
- System Diagnostics only inside Settings;
- model presets chosen from the live Codex catalog—never a free-form model identifier;
- optional Web Push enabled by a direct installed-PWA gesture;
- notify only blocking question, approval, error, important pinned completion, or grouped ready results;
- notification opens the exact Session or Home priority focus;
- no sensitive approval action on the lock screen;
- global preferences restore on a replacement iPad where possible;
- 44-point minimum touch targets, safe areas, VoiceOver, visible focus, large text, reduced motion/transparency, and portrait/landscape/phone layouts;
- motion is functional: press, sheet, status, and transfer only.

## 13. Pairing

Pairing must be no-typing, private, revocable, and under two minutes after prerequisites. Base Nerva installation and pairing remain available in a safe degraded native topology. See [`PAIRING_target.md`](./PAIRING_target.md).

## 14. Explicitly out of scope

- task creation/fork/archive/delete from iPad;
- arbitrary shell, raw CDP, arbitrary JavaScript, or full remote desktop;
- a general Steer control;
- automatic send/replay on reconnect;
- cross-session swipe navigation;
- separate Mission Control or Automatic by Status layout;
- subagent inspection;
- Artifact Wall;
- general Nerva Voice and arbitrary Cards in this release;
- Guided Replay and Mac Site QA recording store;
- a primary two-iPad simultaneous workflow.

## 15. Evidence required for target completion

Target completion requires both automated gates and dated real-device proof: under-two-minute clean pairing, limited-mode pairing, Home Screen reopening, replacement iPad, Follow/Stay and exact bidirectional navigation, Mac microphone Dictation, Queue/Steer-respecting Send prompt, image-only native attachment without submission, Pencil/palm/pressure/tilt/two-finger behavior, Camera/Photos/Files, large graph export/reconstruction, exact-task cross-origin Sites and QA, sleep/Tailscale/suspension recovery without duplicates, and Web Push under Focus/background/full suspension.
