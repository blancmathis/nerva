# ADR 001: Attach Drawing to the exact native composer without submitting

- Status: Accepted and implemented for Drawing/Photo; Review remains a separate app-server transport
- Date: 2026-07-21
- Scope: Exact-thread image attachment, acknowledgement and retry behavior

> **Product boundary:** Drawing and Photo expose one direct `Send` action. It
> attaches one image-only PNG/atlas or one attested ordered image batch to the exact selected native Codex composer and
> never submits that composer. There is no instruction field, hidden Skills
> suffix, delivery inbox, queue or steer action on the iPad. See
> [`docs/product/FEATURES_target.md`](../product/FEATURES_target.md#83-images-and-send-action).
>
> The Session page also has a separate compact `Send prompt` control. It never
> participates in Drawing delivery: it invokes only the exact live native
> `ACT12` / `CODEX` / `composer.submit` binding after the user has prepared the
> Mac composer. Codex Desktop owns the resulting Queue or Steer behavior.

## Context

Nerva must move one bounded visual export from the iPad drawing surface into the exact Codex
Desktop task selected by the user. A title, recent task, foreground window or
stale composer marker is not routing authority. Silent forking, guessed targets,
duplicate replay and starting an agent turn before the user finishes the Mac
message are unacceptable.

The earlier implementation called app-server `turn/start` with a temporary
`localImage` path. That both violated the desired composer-first UX and allowed
the temporary PNG to be deleted before the app-server consumed it. Drawing is
therefore no longer an app-server message operation.

Review is intentionally different: it owns a text manifest plus an ordered
image deck and continues to use the managed app-server contract described in
[ADR 006](006-multimodal-review.md). Proof for Review must never be used to
claim Drawing composer behavior, or vice versa.

## Current evidence

The observed Desktop baseline is `/Applications/ChatGPT.app`, bundle ID
`com.openai.codex`, version `26.715.61943` build `5628`.

On that build, the exact visible composer has one
`button[data-composer-navigation-target="add-context"]`. Traversing its live
React ancestors reaches the composer's `onPaste` handler. A bounded live
diagnostic dispatched one generated PNG `File` through that handler and
observed all of the following:

- the paste event was accepted;
- one attachment appeared with the remove label for the exact filename;
- no submit handler or app-server method was invoked;
- the diagnostic attachment could be removed through the visible UI.

Automated tests reproduce the handler contract with a fake DOM, assert that the
fixed expression contains neither `composer.submit` nor `turn/start`, verify
exact-target and authority checks, and exercise bridge idempotency including
definite pre-attachment failure and post-paste unknown outcome.

This proves the bounded primitive on the recorded Mac build. It does not prove
future Codex Desktop builds, a physical iPad tap, Apple Pencil behavior or
Review delivery.

## Decision

Drawing/Photo uses one native composer attachment path with a legacy one-image payload and a versioned ordered-batch payload:

1. The PWA sends a unique `commandId`, exact `bridgeInstanceId`, snapshot
   sequence, native slot, canonical thread UUID, board/checkpoint identity, scope, tiling manifest and PNG bytes. It sends an
   empty instruction and cannot provide a local Mac path.
2. The bridge authenticates the bearer and exact Origin, validates the command,
   and reserves the durable idempotency record before mutation.
3. The bridge validates PNG signature, dimensions, pixel area and byte limits,
   then re-encodes a canonical PNG. Its randomized mode-`0600` file is only a
   private normalization artifact; the Desktop composer never receives that
   path.
4. Immediately before attachment, the adapter refreshes the native renderer and
   requires the expected thread to remain the active, uniquely selected task in
   the expected native slot. `composerAttachment` must be live.
5. When Desktop ownership is attested, the bridge acquires and consumes the
   same one-shot final-write authority used by exact native controls. Without
   full ownership, the exact selected native target is still sufficient for
   this existing-target renderer operation.
6. The renderer operation accepts only the canonical expected UUID, one to twelve uniquely named Nerva PNGs no larger than 8 MiB each and 24 MiB together.
   It rechecks the exact visible composer and refuses zero or multiple native
   add-context controls.
7. The operation finds the live composer `onPaste` handler, creates every validated
   in-memory PNG `File`, places them in one `DataTransfer`, and dispatches one
   cancelable `ClipboardEvent("paste")` to that handler.
8. The fixed expression has no submit call, Enter shortcut, app-server RPC,
   arbitrary remote code or text mutation. It only attaches the image.
9. Success requires every uniquely named `Remove …` control to appear while the exact composer remains current. No visible file and a partially visible batch are separate unknown outcomes; a partial batch must be resolved on the Mac and is never completed automatically. Only complete confirmation may animate the iPad away.
10. After that postcondition, the bridge removes the temporary normalization
    file; the composer already owns the in-memory `File`.
11. A definite failure before paste is retryable through the same command
    identity. Any error after paste may have fired becomes `DELIVERY_UNKNOWN`
    and is never replayed automatically. The editable iPad board, exact exported bytes and immutable
    retry binding remain available for reconciliation. A confirmed send checkpoints the board and makes the next Draw blank; `Boards` can reopen that checkpoint.
12. Skills remain armed because Drawing contains no text. Nerva does not
    inspect or alter text typed or dictated into the native Mac composer.

The bridge advertises `composerAttachmentMaxImages: 1 | 12`. It remains `1` until the exact installed Desktop batch behavior has been attested, so Draw automatically emits one bounded atlas instead of sending a speculative batch.

The ordered payload is self-describing without composer text. `01-map` is
always first; optional `structure-index` and region details follow with stable
filenames derived from the immutable board/export identity. Export-only pixel
headers carry each region's ordinal, neighbors, scale and mini-map, while the
manifest retains the same board, checkpoint and scope binding. This does not
expand the command union or allow the PWA to inject instructions.

The path does not read app-server turn state and does not care whether the agent
is idle, working or waiting. Managed app-server reconnect backoff may disable
Skills, Model + Reasoning and Review, but it must not disable Drawing attachment
while the exact native composer remains verified.

## Review transport boundary

Review continues to use the private version-matched managed app-server control
socket. Its one-image and multi-image capability gates, idle/steer/busy rules,
temporary `localImage` ownership and optional bounded multi-image attestation
are documented in [ADR 006](006-multimodal-review.md) and
[Compatibility](../COMPATIBILITY.md).

Review never falls back to the Drawing paste primitive because its text
manifest and ordered multi-image atomicity would be lost. Drawing never falls
back to `turn/start` because that would submit a message the user did not send.

## Setup boundary

`npm run setup:mac` remains the user's explicit authorization to configure the
loopback CDP launch path, managed daemon, bridge LaunchAgent, local-daemon GUI
opt-in and private Tailscale Serve route. It never quits or relaunches Codex
Desktop. Runtime checks still verify the actual renderer and socket state rather
than assuming setup succeeded.

The native attachment capability is version- and structure-sensitive. A Codex
Desktop update that removes the unique control, live paste handler, `File`,
`DataTransfer`, `ClipboardEvent`, exact-thread marker or visible attachment
postcondition disables Drawing `Send` instead of guessing a replacement.

## Confirmed Drawing UX

1. `Send` prepares and attaches only the current PNG.
2. Existing Mac composer text is not read, changed or submitted.
3. Only a confirmed visible attachment closes the studio.
4. Failure or unknown outcome keeps the local editable draft and retry identity.
5. Reopening a draft never attempts to remove an image already attached on the
   Mac.
6. A later instruction is typed on the Mac or added with native Mac Dictation;
   the user submits from Codex Desktop.

## Consequences

- Drawing now matches the intended two-step interaction: attach from iPad,
  finish and send from Mac.
- App-server availability and agent busy state no longer block Drawing/Photo.
- The bridge owns more version-sensitive renderer compatibility code, but the
  exposed operation is smaller than a generic CDP or composer API.
- `Send` is a transfer label, not proof that a Codex task was queued or started.
- Review remains independently gated and can still be unavailable while Drawing
  works.

## Acceptance evidence still required

The remaining physical gate is one recorded iPad test that:

1. opens an exact selected task on both devices;
2. draws or imports a non-sensitive image;
3. taps `Send` once;
4. observes exactly one attachment in that Mac composer;
5. confirms existing composer text is unchanged and no turn starts;
6. adds an instruction on the Mac and submits it manually;
7. repeats a failure/unknown case without duplicate attachment.

Every Codex Desktop version change must repeat the structural and live bounded
attachment checks before compatibility is declared.
