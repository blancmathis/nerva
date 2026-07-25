# ADR 006: Send one ordered multimodal review as one turn

- Status: Accepted current app-server Review implementation; Drawing/Photo composer attachment is a separate path
- Date: 2026-07-20
- Scope: Review frames, photos, vector annotations, atomic send, and
  before/after iterations. PWA voice capture and native Codex dictation are
  outside the review payload.

> **Product boundary:** this ADR covers the text-bearing ordered Review deck and its deterministic manifest. Drawing/Photo use a separate direct image-only `Send` that attaches one PNG to the exact native composer without submitting it, with no message field or skill suffix. Review does not use that composer primitive. See [`docs/product/FEATURES_target.md`](../product/FEATURES_target.md).

## Context

Nerva is an extension of Codex Desktop, not a replacement. The iPad surface
is valuable where touch, Pencil, camera, and immediate visual review are better
than the Mac. A review may move through several site states and
physical references before the user is ready to ask Codex to act.

Sending each capture as a separate message could trigger concurrent or partial
work. Identifying a capture only by URL is also incorrect: the same URL can show
different application state, viewport, scroll position, or iteration.

## Decision

A review is a local, ordered deck of distinct media items. Sending a review
creates one explicit instruction and one atomic app-server turn containing all
retained images in deck order. Deleting an item is the explicit way to omit it.

### Ordered review frames

Each captured site state is an immutable review frame with its own `frameId`.
Its identity does not derive from its URL. A frame records:

- visit order, capture time, URL, and title;
- screenshot provenance and local blob identity;
- viewport dimensions, device preset, and scroll position when proven by the
  capture driver;
- an editable vector annotation scene;
- a user-editable instruction/caption; the frame remains part of send until it
  is deleted.

Two frames may have the same URL and title while remaining separate ordered
items. Navigating away may save the current frame only after capture succeeds;
failure stays visible and never creates a frame that pretends to contain a
screenshot.

The vector scene is authoritative while editing. Pen, highlighter, arrows,
rectangles, ellipses, strike marks, and text remain editable. A flattened,
bounded PNG is derived only for preview and send.

### Photos in the same deck

Camera captures and files explicitly imported from Photos or Files use stable
media-item identities and can appear between site frames in any order. Each
photo has its own vector annotation scene and caption. Input MIME, magic bytes,
byte size, decoded dimensions, and pixel area must pass the same bounded image
pipeline as drawing imports.

Before browser decode, that pipeline retains at most 256 KiB of header/table
inspection data and visits at most 4,096 header/container structures for
non-animated PNG, JPEG, static WebP, or structurally supported HEIC/HEIF. A JPEG
may stream-scan as much as the 15 MiB compressed-file ceiling with a 64 KiB
working chunk to locate late markers, without bitmap decode. It scans PNG chunks through `IEND` and rejects
APNG, animated WebP, malformed/truncated input, unsupported or ambiguous
HEIC/HEIF item constructions, files over 15 MiB, an individual dimension above
16,384 pixels, or review area above 32 megapixels before any image, canvas, or
DataURL allocation.

Accepted HEIC/HEIF must expose exact item extents and codec configuration;
coded and conformance-cropped display dimensions are bounded, in-band parameter
sets fail closed, grids contain at most 256 tiles, and their aggregate coded
tile pixels stay within the caller's area limit. Drawing imports use the same
limits except for a stricter 16-megapixel area. The decoded dimensions must
match the inspected primary output.

Send preparation inspects every retained outbound image before conversion and rejects a
deck above 64 megapixels of aggregate decoded surface. It then normalizes frames
sequentially to PNG, with an 8 MiB per-frame limit and a 24 MiB atomic image
bundle limit. No converted prefix is sent if a later frame fails. Drawing export
re-renders the vector scene toward 92% of the 8 MiB ceiling; the bridge
canonicalizes from the original and, if needed, resizes iteratively while
preserving at least a 1,024-pixel long edge, or asks the user to crop or resize.

Local draft validation allows at most 12 frames and 20 image records. The
outbound contract permits at most 12 ordered images and an 8,000-character
complete instruction/metadata manifest. These are separate limits: a valid
local draft can still need editing before it can send.

Nerva does not crawl the photo library or upload background media. For
non-HEIC PNG, JPEG, and WebP imports, the original local draft blob is retained
unchanged and can therefore still contain EXIF/XMP, including location, until
the frame/draft is deleted, local garbage collection removes it, or site data
is cleared. Outbound PNG normalization strips that metadata before the image
crosses the bridge boundary.

### No Review microphone, audio, or transcription path

Review never requests iPad microphone permission and never invokes
`getUserMedia`, `MediaRecorder`, or browser `SpeechRecognition`. Production
responses set `Permissions-Policy: microphone=(self)` solely for the separate,
explicit Site QA checkpoint voice note. Capture Inbox has no Voice action, as
defined by [ADR 008](008-capture-inbox.md).
The Review model still has no audio store, voice segment, transcript editor,
transcription adapter, `localAudio` field, or transcript-to-review route. A
review contains typed instructions and images only.

Dictate is a separate native Codex Desktop action, not a review input. It is
available only for the exact selected native task after the bridge has a fresh
authoritative snapshot and immediately revalidates the observed Dictate keycap
and native action identities. A missing, stale, changed, or unverified binding
fails before the first native event; there is no app-server text, guessed
shortcut, alternate-task, or iPad-capture fallback.

After a proven dispatch, Codex Desktop owns recording and transcription with
the microphone selected on the Mac. Nerva neither receives nor persists the
audio or resulting text, and dictated text is never added to this review
manifest. No live exact-task Dictate dispatch has been observed on the audited
baseline. See [ADR 002](002-cdp-adapter.md).

### One atomic multi-image turn

The send preview shows the exact thread destination and command suffix, overall
instruction, frame/image counts, and ordered media labels with MIME type and
per-image bytes.
For an annotated frame, the flattened composite already contains the source
capture and is therefore the frame's sole primary outbound image. The source
capture is not sent a second time. An unannotated frame sends its capture;
explicit Before, After, and photo items remain separate ordered images.
After confirmation, the bridge constructs one deterministic `UserInput[]`:

1. one text manifest containing the overall instruction and numbered metadata
   for every retained item;
2. one `localImage` for each retained annotated frame or photo, in the same
   displayed order.

The bridge issues one `turn/start` when the exact thread is authoritatively
idle, or one capability-proven `turn/steer` with the exact active turn ID. It
never emits one turn per image. Here, atomic means one app-server request and
one Codex turn; it does not claim transactional rollback after Codex accepts the
turn.

The command has one durable idempotency key. The bridge validates every image
and the aggregate byte/pixel/count limits before dispatch. Ordinary proven
one-image transport permits a one-image review when the independent exact-
target and one-shot final-write authority gates also pass. A deck containing 2–12 images remains
complete and editable locally unless an explicit bounded multi-`localImage`
attestation matches the current binary, schema, and app-server identity. That
attestation authorizes only the probed multi-image `turn/start` shape; it does
not prove shared Desktop ownership, the live target, or image steering. Codex
Pad never drops an item, silently sends only the first image, or splits the deck
into several turns.

Exact-thread routing, busy behavior, temporary-file handling, and acknowledgement
follow [ADR 001](001-thread-transport.md).

A final successful acknowledgement clears only the retry marker whose exact
thread, draft revision, and command ID match that acknowledgement. A late ACK
from another tab cannot clear a newer delivery identity. The editable
draft, iteration history, source media, and composites remain local so the same
deck can seed the next Before/After cycle. The send sheet offers a separate,
confirmed **Clear local review** action; only that action deletes the draft,
saved iterations, unshared media, and pending-delivery marker, and only while
the stored deck still exactly matches the revision shown in that send sheet.
A stale panel refuses deletion and preserves the newer tab's state. In-flight,
unknown, failed, or retryable delivery never triggers local deletion.

### Before/after is an iterative review

A completed send creates a review-iteration record without mutating its source
frames. A later bridge-produced capture may be linked as the proposed result of
that iteration. A native unread-complete signal may invite the next step, but it
captures nothing automatically. The user must explicitly import an After image
or request a registered-route capture; that capture comes from a fresh isolated
Mac browser context and is not represented as the exact page state the agent
changed.

The user can compare two explicitly chosen frames using:

- side by side;
- an overlay slider;
- alternating blink;
- a local pixel-difference heatmap.

Diff decodes Before and After sequentially, requires identical dimensions, and
computes a thresholded heatmap within a two-megapixel budget. It reports changed
pixel statistics and remains explicitly unavailable when either local image is
missing or dimensions differ. This is local derived analysis only; it does not
claim semantic correctness or prove what the agent changed.

Comparison controls never edit either source. New feedback creates a new vector
annotation layer and, when sent, a new review iteration. A result can become the
next iteration's baseline, preserving the sequence:

```text
view -> annotate -> explain -> send -> agent changes
     -> compare -> annotate again -> send
```

## Local-first and privacy boundary

Review frames, vector scenes, photos, and iteration links remain in local
PWA/bridge storage. Nothing is synchronized through a Nerva cloud service,
and no content telemetry is emitted. Only the user-confirmed typed manifest and
normalized images cross the authenticated local app-server boundary. Local
retention and deletion controls must distinguish editable drafts from temporary
send files. Native Desktop dictation remains outside both the PWA storage model
and the review transport.

## Rejected alternatives

- One message per frame: can trigger partial or concurrent work.
- URL as frame identity: collapses different states of the same page.
- Flattening annotations at capture time: destroys editability and iteration.
- Recording or browser transcription inside Review: adds an implicit review
  input and bypasses exact native Dictate ownership. Site QA may retain a raw
  local checkpoint voice note, but it cannot enter this payload.
- Sending audio through an invented `localAudio` field: is unsupported by the
  installed schema and would make the visible payload contract false.
- Partial send when one image fails validation: makes the visible preview false.
- Overwriting the previous frame with an after capture: destroys review history.

## Consequences

- A review preserves narrative order across web states, photos, typed
  instructions, and repeated feedback cycles.
- The bridge needs aggregate validation and one-turn idempotency, not merely a
  loop around the existing single-image endpoint.
- Storage pressure and iPadOS suspension must be handled explicitly because
  media drafts remain local.
- Native Dictate capability and review-send capability remain independent; one
  cannot silently substitute for the other.

## Current proof boundary

Local automated tests cover distinct same-URL frame identities, ordering,
restore, editable annotation state, deterministic manifests, photo validation,
mocked browser-decoder HEIC/HEIF normalization and unsupported-decoder fallback,
before/after comparison state, aggregate media validation, and refusal to send
multiple images without an explicit bounded runtime capability. Browser-contract
tests exercise the review surface with synthetic media. This is implementation
proof against local fakes and fixtures.

The isolated feasibility spike proved only one PNG `localImage` in one
disposable app-server turn. It did not prove multiple images in one live shared
Desktop turn, shared Desktop co-presence, physical iPad/Pencil/camera input, an
actual Photos/Files HEIC/HEIF sample on Safari, live native Dictate dispatch,
or a real agent-produced page change followed by a live After capture. The
complete live review loop therefore
remains unproven even though its local model, UI, validation, and fail-closed
gates are implemented.

## Validation gate

Readiness requires automated and real-device evidence for:

1. two distinct frames with the same URL surviving save, reorder, and restore;
2. editable vector annotations and deterministic flattened previews;
3. interleaved site frames and photos retaining exact deck order;
4. `Permissions-Policy: microphone=(self)` plus proof that microphone access is
   limited to the explicit local Site QA checkpoint voice action, while Review has
   no audio, browser-recognition, voice-segment, or transcript-routing path;
5. native Dictate remaining disabled until exact selected-task ownership and
   current keycap/action identities are proven, with stale or changed bindings
   failing before the first native event;
6. one app-server request containing the typed text manifest and every
   retained image in order, with no duplicate or partial turn; an annotated
   capture counts as one flattened composite rather than source plus composite;
7. aggregate count, byte, dimension, and pixel-limit rejection before dispatch;
8. immutable before/after sources and repeatable review iterations;
9. no Nerva-managed cloud upload or content telemetry, no audio or
   transcript data in PWA storage or review payloads, and no claim of live
   native Dictate proof without exact runtime evidence;
10. successful delivery retaining the local deck for Before/After until an
    explicit confirmed clear, while unknown or failed delivery retains both
    media and its idempotent retry identity.
