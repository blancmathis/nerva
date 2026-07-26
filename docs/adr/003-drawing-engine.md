# ADR 003: Own the drawing scene and use perfect-freehand for stroke outlines

- Status: Accepted and implemented for local drafts, bounded export and Mac Saved Drawings
- Date: 2026-07-20
- Scope: Apple Pencil input, editable drafts, and PNG export

> **Current boundary:** live editing remains local to the iPad. `Keep in Saved Drawings` is implemented and transfers one validated scene plus PNG to the Mac-owned global store; ordinary in-progress strokes are never synchronized. See [`docs/product/CURRENT_STATE.md`](../product/CURRENT_STATE.md).

## Context

Nerva needs a focused annotation editor that survives PWA suspension and can
export a bounded PNG for the exact native Codex composer. Current tldraw packages
are excluded because their production licensing does not fit this project.

[`perfect-freehand`](https://github.com/steveruizok/perfect-freehand) is small,
MIT-licensed, and focused on converting point samples into visually pleasing
stroke outlines. It is not a complete scene graph, editor, renderer, or export
pipeline.

## Decision

Pin `perfect-freehand` to published version `1.2.3` and use its `getStroke`
function for pen and highlighter outline generation. Nerva owns every other
part of the drawing model.

### Serializable scene

Persist a versioned, project-owned scene per target thread in IndexedDB. It
contains:

- canvas background mode: white, transparent, or dark;
- an optional imported background image stored as a local blob plus dimensions;
- ordered elements for freehand strokes, arrows, rectangles, ellipses, and text;
- freehand samples with scene coordinates, pressure, timestamp, and tilt when
  available;
- style data such as tool, color, width, opacity, and highlighter blend mode;
- viewport state and an undo/redo command history or checkpoints.

The editable scene is authoritative. `perfect-freehand` polygons and exported
PNGs are derived artifacts and are not persisted as the only copy.

### Pointer policy

Use [Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent)
for pen, touch, and mouse input.

1. Track active gestures by `pointerId`, which is temporary and recyclable.
2. On `pointerdown`, capture the pointer with `setPointerCapture`.
3. Finish cleanly on `pointerup` and `lostpointercapture`. When WebKit emits
   `pointercancel` after valid Pencil samples, commit those already-visible
   samples as a partial element before releasing tracker state instead of
   erasing the whole stroke.
4. Transform `clientX/clientY` through the surface bounds and inverse viewport
   transform before storing samples.
5. For a pen, store normalized pressure and tilt. Set
   `simulatePressure: false` when pressure is meaningful; use velocity-based
   simulation for mouse or pressureless input.
6. Feature-detect `getCoalescedEvents()`. When it exists and returns samples,
   consume that list; otherwise consume the dispatched event once. Do not append
   the dispatched event again to a non-empty coalesced list.
7. In Pencil-only mode, only `pointerType === "pen"` can draw or place an
   editing tool. One touch is recorded only as a passive candidate and receives
   no pointer capture; exactly two touches promote into the custom pan/pinch
   viewport. When either finger ends, navigation stops rather than continuing
   as one-finger pan. Touches received while a pen is active are ignored and
   never inserted into the later gesture map. Unknown pointer types do not draw.
8. Apply `touch-action: none` only to the drawing surface, not the whole PWA.
   Retain explicit zoom controls for accessibility.
9. Suppress `selectstart`, browser text selection, touch callouts and overscroll
   across the full-screen drawing studio. Re-enable ordinary selection only for
   true editable controls. This prevents Pencil plus palm contact from selecting
   surrounding page chrome without making the rest of Nerva non-selectable.

`getCoalescedEvents()` is secure-context-only and remains limited availability,
including on older iPads, so the fallback is a required path rather than a
polyfill afterthought.

### Tools and editing

- Pen and highlighter use `getStroke`; live strokes use `last: false` and are
  recomputed with `last: true` on completion.
- Erasing removes or splits scene geometry. It never paints with the background
  color, which would fail on transparent, dark, or image backgrounds.
- Arrow, rectangle, ellipse, text, selection, transforms, hit-testing,
  undo/redo, and clear confirmation are project-owned.
- Imported images are decoded and normalized before entering the scene. The
  decoder enforces MIME magic bytes, upload bytes, pixel dimensions, and a
  decompression-bomb limit.

### PNG export

Export renders the authoritative scene into a bounded, self-describing visual
package. The editable board is never decorated with export metadata.

1. `Whole board` uses the real content bounds. `Select area` uses the explicit
   world-space rectangle chosen by the user.
2. A legible region becomes one PNG up to 4096 × 4096. A larger region becomes
   one map plus at most eleven detail views, or one compatibility atlas when
   native multi-attachment is not attested.
3. The rectangular planner assigns stable regions such as `A1` and `B2`. Detail
   cores cover the requested bounds without gaps; their render bounds add 12%
   symmetric overlap. Candidate seams minimize, in order, cuts through blocks,
   text or photos; structured connections; freehand strokes; and poor empty-space
   or aspect-ratio choices.
4. The map is always first. It shows every region, the overlap, export identity,
   and Diagram revision when present. Details use an external header containing
   their region, ordinal, scale, neighbors and a highlighted mini-map. Known
   structured connections crossing a seam receive matching continuation codes.
   Every neighboring pair also shares one deterministic registration marker
   such as `R-A1-B1`, repeated with the same visual motif in both external
   gutters. Freehand ink never receives invented semantic labels.
5. A structured Diagram adds a compact region/node and cross-region edge index.
   When that index cannot remain legible on the map, it becomes a separate
   `structure-index` PNG before the details.
6. Filenames are deterministic inside one immutable export:
   `Nerva Board <board>-<export> 01-map.png`, optional
   `02-structure-index.png`, then numbered region details. Every image therefore
   remains localizable if the composer displays attachments out of order.
7. The compatibility atlas reserves approximately 40% of its 4096 × 4096 area
   for the map and places the remaining views in reading order. It reports
   `Overview detail` instead of implying that an arbitrarily large board remains
   fully legible in one raster image.
8. Every PNG is normalized and bounded to 8 MiB; an attested native batch is
   bounded to 24 MiB and 64 decoded megapixels. Canvases are produced
   sequentially and released between images.
9. A dirty structured Diagram revision is synchronized before image generation,
   so the stored structure and exported pixels share the same revision.
10. `Send` attaches only PNG files to the exact visible native composer. It adds
    no text and performs no submit action. The UI exposes only `Whole board` and
    `Select area`, plus an optional collapsed `Inspect package` disclosure.
11. A confirmed Send creates a `Sent` checkpoint, closes Draw and makes the next
    Draw a blank board; `Boards` can reopen the checkpoint. Failure or unknown
    outcome keeps the active board, exact PNG bytes and delivery identity for an
    explicit retry.

The bridge, not the PWA, creates the randomized mode-`0600` normalization file.
The native composer never receives that local path: the validated PNG bytes are
materialized as an in-memory browser `File`, so the temporary file is removed
after the visible attachment postcondition.

### Saved Drawings

`Keep in Saved Drawings` is distinct from sending. The bridge validates the strict request, canonical base64, PNG magic/decoding, declared dimensions and parseable scene JSON before writing a private record atomically and generating a bounded WebP thumbnail.

The Mac store is global across paired iPads and bounded to 48 records, 8 MiB per PNG and 128 MiB total PNG data. A record retains source session identity/title, an empty instruction for current Drawing sends (or a bounded legacy value during migration), background, canvas dimensions, editable scene JSON and the normalized PNG. Only an explicit confirmed delete removes it.

Opening a saved drawing creates an independent local working copy for the current exact session. Saving or auto-saving that working copy as the current session's local draft never mutates or deletes the Mac original; the user must choose `Keep in Saved Drawings` again to create another saved record.

## Licensing and assets

The pinned upstream implementation revision is
[`f56f097e0e211fffa1601b93883e4d9f9dccf122`](https://github.com/steveruizok/perfect-freehand/commit/f56f097e0e211fffa1601b93883e4d9f9dccf122),
MIT, copyright 2021 Stephen Ruiz Ltd. Its complete notice is retained in
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) and must ship with
packaged releases.

Nerva uses original controls, icons, and visual design. No tldraw assets or
OpenAI/Work Louder/Apple artwork is included.

## Consequences

- The editor remains narrowly tailored to annotation rather than inheriting a
  general whiteboard framework.
- The project owns more scene, selection, and export code, but it also controls
  persistence, accessibility, security limits, and licensing.
- Pressure quality depends on real hardware and browser behavior; automated
  PointerEvent tests do not replace Apple Pencil validation.
- Explicit Keep provides cross-iPad restoration without synchronizing live
  strokes, undo history changes or unsaved drafts.

## Validation gate

Automated tests cover scene migration/serialization, undo/redo, pointer capture
cancellation, pressure and fallback samples, pen-versus-finger routing,
coalesced-event deduplication, bounds/clamps, background compositing,
deterministic 2/6/12-view planning, negative coordinates, symmetric overlap,
seam priorities, map-first packaging, structured indexes and continuation codes,
atlas fallback, IndexedDB restoration, Saved Drawings validation/limits,
Keep/list/get/delete and opening an independent working copy. A real iPad/Apple
Pencil checklist must additionally verify fast strokes, palm rejection,
pinch/pan, Camera/Photo Library/Files import, background resume,
portrait/landscape layout and preview/send fidelity. Reconstructing a known
6- and 12-view Diagram from the actual Codex composer remains a separate
physical/model-understanding gate.
