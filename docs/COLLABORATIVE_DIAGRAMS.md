# Collaborative diagrams

Nerva Draw can receive a structured diagram from the Codex task that is currently open, let the user edit it on the iPad, and preserve ordinary Pencil annotations above it. The Mac and iPad exchange the diagram structure; Draw exports the requested board/area as one compatible atlas or an attested ordered image batch to the exact Codex composer without submitting the message.

## User flow

1. Ask Codex in a task to create a diagram and publish it to Nerva.
2. Open the same task in Nerva, then tap **Draw**.
3. The latest unseen diagram for that exact task opens automatically.
4. The graph opens directly in the same infinite board as Pencil ink, photos, text and shapes; there is no diagram frame or fixed graph page. **Select** can move or resize a block or any ordinary board element. Drag an empty area to select several items, then drag anywhere inside the selection frame to move the group.
5. A compact graph capsule floats over the board without reducing the canvas. **Block** adds a node at the current camera position, **Edit** opens the selected block, and the final control shows synchronization state. Tap the graph identity to choose another graph for the exact task.
6. In the focused inspector, rename the block immediately; use **Style** for shape and color, **Links** for connections, and **More** for the graph title, automatic arrangement or deletion. On iPad, the canvas reserves a narrow edge column only while the inspector is open. On phone, the inspector temporarily replaces the canvas; closing it restores the full board.
7. Choose **Pen** in the tool rail, or use the Pencil action in the inspector, to annotate normally. Graph structure and freehand ink remain separate while editing even though they share one spatial surface.
8. **Sync revision** appears only while the structure has local changes. Tap it when Codex should read those changes without receiving a composer attachment. **Keep** and **Send** also synchronize a dirty graph revision before continuing.
9. **Send** synchronizes a dirty graph revision before rendering. A compact
   summary announces the resulting package, for example
   `1 map + 7 linked details · Good`; **Inspect package** optionally reveals the
   regions without adding a required step. Nerva then attaches either one
   compatibility atlas or one attested ordered PNG batch to the exact visible
   Mac composer. It never submits the composer and never injects instruction
   text.

After a confirmed Send, the working board receives a `Sent` checkpoint and that diagram revision is marked seen. Reopening Draw starts blank, while **Boards** can reopen the checkpointed board. The diagram reopens automatically only after Codex publishes a newer revision. **Clear** removes the current local working page and marks the current revision seen; it does not delete the Mac copy.

## Agent flow

The command runs from the source checkout. In a Codex task, `CODEX_THREAD_ID` supplies the exact destination automatically:

```bash
npm run codex-pad -- diagram publish \
  --file examples/collaborative-diagram.json \
  --json
```

Outside a Codex task, pass the exact task UUID explicitly:

```bash
npm run codex-pad -- diagram publish \
  --file examples/collaborative-diagram.json \
  --thread <task-uuid> \
  --json
```

List only the diagrams for the current or specified task:

```bash
npm run codex-pad -- diagram list --json
npm run codex-pad -- diagram list --thread <task-uuid> --json
```

Read one exact document after the iPad has synchronized it:

```bash
npm run codex-pad -- diagram get <diagram-id> --json
```

To continue the collaboration, edit the returned document, retain its `diagramId`, set `expectedRevision` to the returned `revision`, and publish the file again. The publish command rejects a stale revision instead of overwriting newer iPad work.

```json
{
  "diagramId": "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
  "expectedRevision": 3,
  "title": "Revised collaboration loop",
  "sourceLabel": "Codex",
  "nodes": [],
  "edges": []
}
```

The full initial shape is available in [`examples/collaborative-diagram.json`](../examples/collaborative-diagram.json).

## Document contract

- World: version 2 positions are bounded to ±1,000,000 units and may be negative. Version 1 documents retain their exact positions and historical center `(720, 450)` when migrated.
- Nodes: at most 256. IDs are stable ASCII identifiers; labels are 1–240 characters.
- Node shapes: `rectangle` or `ellipse`.
- Node tones: `neutral`, `blue`, `green`, `amber`, `red`, or `violet`.
- Edges: at most 512. Each edge references two existing, different node IDs.
- Edge styles: `solid` or `dashed`.
- Documents: at most 48 Mac-backed records, each bounded to 512 KiB.
- Routing: every document belongs to one exact task UUID. Listing and iPad loading are always filtered by that task.
- Revisions: optimistic and monotonic. A write must name the revision it replaces.

The bridge validates dimensions, bounds, IDs, references, duplicates, self-edges, byte size, task identity and revision before writing. Records are stored in the existing private Nerva runtime directory using atomic files and a cross-process lock.

## Offline, conflicts and recovery

- A loaded diagram and its Pencil draft remain editable in the iPad's local Draw draft while the Mac is unavailable.
- Structural sync requires the authenticated Mac bridge. If it cannot be confirmed, the local revision stays dirty and Send/Keep do not pretend it was synchronized.
- If Codex publishes a newer revision while the iPad has unsynchronized changes, Nerva shows the update but never replaces the local work automatically.
- If the iPad has no local changes, the newer Codex revision can replace the current structured layer safely.
- Failed or unknown attachment keeps the complete working board, exact exported bytes and the same delivery identity for retry.
- Saved Drawings remain flattened, independent snapshots. They do not mutate the collaborative structured document.

## Security and privacy boundaries

Collaborative diagrams do not add arbitrary HTML, SVG, JavaScript, selectors, filesystem paths or prompt execution to the PWA. The browser receives only validated data primitives. Publishing from the CLI requires a regular JSON file, rejects symlinks and enforces the exact-task destination. The iPad cannot read diagrams from another task.

The structural sync and the composer attachment are deliberately separate:

- **Sync revision** updates the private diagram document.
- **Send** attaches one rendered atlas or one attested ordered image batch to the exact visible native composer.
- Neither action submits a Codex message.

## Visual coherence package

Large collaborative boards are exported as an explicit visual coordinate
system rather than unrelated screenshots:

- `01-map` is always first and shows the whole board, the named rectangular
  regions and their 12% overlap.
- Every detail has an external header with its board/export identity, ordinal,
  region, scale, neighbors and a highlighted mini-map. The saved Diagram and
  Pencil scene are never changed by these export-only pixels.
- Neighboring details repeat the same deterministic registration code and
  visual marker in their external gutters, for example `R-A1-B1`.
- Stable filenames and region labels keep each attachment understandable if a
  composer displays the files in a different order.
- A compact structure index lists the nodes in each region and every known
  cross-region edge. When it does not fit legibly on the map, Nerva inserts a
  dedicated `structure-index` image before the details.
- Cross-region Diagram edges receive matching `E01`, `E02`, … continuation
  codes. Pencil marks retain only visual overlap and map position because Nerva
  must not infer meaning from freehand ink.
- Compatibility mode composes the package into one 4096 × 4096 atlas, reserves
  about 40% for the map and reports `Overview detail` when full detail cannot be
  preserved honestly.

## Verification boundary

Unit, component and Playwright tests prove validation, exact-task isolation, optimistic revisions, local draft restoration, direct graph movement and resizing, lasso selection and movement of freehand ink, photo movement, Pencil composition, revision sync, image-only Send and non-reopening after a confirmed Send. Browser screenshots cover iPad landscape, iPad portrait and phone layouts.

Physical Apple Pencil pressure, tilt, palm rejection, display cadence and long iPadOS suspension still require the manual device checklist. Browser pointer simulation is not reported as hardware proof.
