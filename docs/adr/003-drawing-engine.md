# ADR 003: Own the drawing scene and use perfect-freehand for stroke outlines

- Status: Accepted and implemented for local drafts, bounded export and Mac Saved Drawings
- Date: 2026-07-20
- Scope: Apple Pencil input, editable drafts, and PNG export

> **Current boundary:** live editing remains local to the iPad. `Keep in Saved Drawings` is implemented and transfers one validated scene plus PNG to the Mac-owned global store; ordinary in-progress strokes are never synchronized. See [`docs/product/CURRENT_STATE.md`](../product/CURRENT_STATE.md).

## Context

Codex Pad needs a focused annotation editor that survives PWA suspension and can
export a bounded PNG for the exact native Codex composer. Current tldraw packages
are excluded because their production licensing does not fit this project.

[`perfect-freehand`](https://github.com/steveruizok/perfect-freehand) is small,
MIT-licensed, and focused on converting point samples into visually pleasing
stroke outlines. It is not a complete scene graph, editor, renderer, or export
pipeline.

## Decision

Pin `perfect-freehand` to published version `1.2.3` and use its `getStroke`
function for pen and highlighter outline generation. Codex Pad owns every other
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
   surrounding page chrome without making the rest of Codex Pad non-selectable.

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

Export by rendering the authoritative scene into a fresh canvas:

1. include the selected background and imported image;
2. compute meaningful content bounds in scene coordinates;
3. add configurable padding and clamp maximum pixel dimensions/area;
4. choose a Retina-friendly scale within that clamp;
5. render all elements in order using deterministic fonts and blend modes;
6. encode a normalized PNG directly from the current scene when `Send` is tapped;
7. attach exactly one PNG `File` to the exact visible native composer with no
   text input and no submit action, disable duplicate taps, and animate away
   only after the attachment is visibly confirmed;
8. keep the vector draft after send for later editing and idempotent recovery.

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

Codex Pad uses original controls, icons, and visual design. No tldraw assets or
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
coalesced-event deduplication, bounds/clamps, background compositing, PNG export,
IndexedDB restoration, Saved Drawings validation/limits, Keep/list/get/delete and
opening an independent working copy. A real iPad/Apple Pencil checklist must
additionally verify fast strokes, palm rejection, pinch/pan, Camera/Photo
Library/Files import, background resume, portrait/landscape layout and
preview/send fidelity.
