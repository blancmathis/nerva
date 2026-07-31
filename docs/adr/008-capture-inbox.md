# ADR 008: Keep Capture Inbox neutral and reuse captures from an exact Session

- Status: Accepted and implemented locally
- Date: 2026-07-22
- Scope: Capture Inbox, local media, exact-session use and reconnect behavior

## Context

Touch, Pencil and camera make the iPad useful before the user knows which Codex task should receive a piece of context. Requiring a Session during capture interrupts that flow and fails when the Mac is temporarily unavailable.

Persistently assigning an Inbox item to a Session also creates unnecessary administration. The product need is simpler: enter the intended Session first, open the shared Inbox there, and choose the context to use now. The same reference may be useful in several Sessions.

Treating captures as an outbound queue would be unsafe. Reconnecting the Mac could deliver stale or sensitive material without a current user decision. Generic file attachment therefore remains an explicit, exact-target composer action rather than Inbox state.

## Decision

Nerva provides a separate Capture Inbox page. Photo, document-photo, sketch, arbitrary file and quick note records are stored in a dedicated local IndexedDB database with no thread identity.

The page has two contexts:

- from Home, it captures, searches, previews and deletes neutral local items;
- from a Session, it displays that exact Session temporarily and offers two disjoint actions: compatible notes/images are copied into its local Review through `Use in session`; file-only batches use `Attach to composer`.

The Session context is navigation state, not Inbox data. No destination, routing label, prepared mark or usage history is persisted on a capture. The same capture remains available for every Session after use.

Using is not sending. The Capture Inbox schema has no delivery queue, pending command, replay marker or reconnect worker. Bridge and WebSocket state changes do not inspect the Inbox.

For currently compatible media, `Use in session` prepares the exact thread's local Review:

- image captures become independent deterministic Review frames;
- quick notes append to the Review's general instruction;
- a pristine placeholder frame is removed when real image frames are added;
- the Review database and its image blobs are committed atomically;
- the originals remain untouched in Capture Inbox;
- the user still previews and confirms the existing Review send separately.

File-only selections do not enter Review. Nerva accepts one to four files, validates safe unique names and bounded MIME/base64 data, enforces 8 MiB per file and 16 MiB for the batch, and asks the bridge to paste the batch into the exact visible Codex composer. The native boundary revalidates the Session before and during confirmation, dispatches one paste event, waits for every unique attachment label, and contains no submit primitive. A rejected, partial, or unknown result preserves the originals and selection; reconnect never retries it.

Capture Inbox has no Voice action and never requests microphone access. Session Dictation and Site QA checkpoint voice are independent features with separate authority and storage.

## Migration

The IndexedDB schema version 2 removes legacy destination and Review-preparation fields. Existing legacy voice records are preserved as generic audio files: their bytes remain intact, the type becomes `file`, and the title changes from `Voice note…` to `Audio file…`. The migration does not reintroduce voice recording or infer a Session.

## Failure behavior

- IndexedDB unavailable or quota/limit exceeded: the capture is rejected with an actionable local-storage error.
- A selected Session disappears before use: the exact contextual target is no longer available and no substitute Session is chosen.
- One selected item changes or disappears before a Review transaction: the operation fails rather than partially applying a batch.
- Mixed notes/images/files, oversized file batches, unavailable exact target, or failed/uncertain native attachment: all originals remain in Capture Inbox and no fallback destination is chosen.
- Mac offline, bridge restart or reconnect: no delivery runs.

## Consequences

- Capture remains fast and independent from Mac availability.
- Using existing context is one tap away from the active Session.
- There is no Inbox assignment workflow to maintain or misunderstand.
- A capture can be reused across multiple Sessions without duplication or movement.
- Local-only material does not synchronize to a replacement iPad.
- Generic-file attachment is deliberately narrower than a file-delivery queue: it is bounded, exact-composer, user-triggered, non-submitting, and has no persisted replay state.

## Rejected alternatives

- Persist a chosen Session on every item: creates administration without helping the Session-first use flow.
- Auto-use in the active Mac Session: active focus is not destination authority.
- Auto-send after reconnect: violates explicit user control and can disclose stale context.
- Keep a Voice recorder in the Inbox: not needed for this capture library and duplicates better-defined voice surfaces.
- Convert documents into screenshots: loses the original and bypasses the explicit generic-file attachment contract.
- Store the Inbox in Mac Product State: contradicts the confirmed local-only product boundary and expands sensitive synchronization.
