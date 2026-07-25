# Collaborative diagrams

Nerva Draw can receive a structured diagram from the Codex task that is currently open, let the user edit it on the iPad, and preserve ordinary Pencil annotations above it. The Mac and iPad exchange the diagram structure; the existing Draw delivery still attaches one flattened PNG to the exact Codex composer without submitting the message.

## User flow

1. Ask Codex in a task to create a diagram and publish it to Nerva.
2. Open the same task in Nerva, then tap **Draw**.
3. The latest unseen diagram for that exact task opens automatically.
4. In **Diagram** mode, move or resize a block directly on the canvas. The compact bottom dock keeps only **Block**, **Edit**, synchronization state and **Draw** visible.
5. Tap a block or **Edit** to open its focused inspector. Rename it immediately; use **Style** for shape and color, **Links** for connections, and **More** for the diagram title, automatic arrangement or deletion. On iPad, the canvas reserves a narrow edge column for the inspector instead of placing controls over the drawing. On phone, the inspector temporarily replaces the canvas; closing it restores the full drawing view.
6. Tap **Draw** or the Pencil action in the inspector to return to the ordinary Pencil canvas. Diagram structure and freehand ink remain separate while editing.
7. **Sync revision** appears only while the structure has local changes. Tap it when Codex should read those changes without receiving a composer attachment. **Keep** and **Send** also synchronize a dirty diagram revision before continuing.
8. **Send** renders the latest structure and Pencil ink into one PNG and attaches it to the exact visible Mac composer. It never submits the composer and never injects instruction text.

After a confirmed Send, the local working page is cleared and that diagram revision is marked seen. Reopening Draw starts blank. It reopens automatically only after Codex publishes a newer revision. **Clear** removes the local working page and marks the current revision seen; it does not delete the Mac copy.

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

- Canvas: fixed logical size of 1440 × 900. Nerva scales it to the available iPad canvas.
- Nodes: at most 64. IDs are stable ASCII identifiers; labels are 1–240 characters.
- Node shapes: `rectangle` or `ellipse`.
- Node tones: `neutral`, `blue`, `green`, `amber`, `red`, or `violet`.
- Edges: at most 128. Each edge references two existing, different node IDs.
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
- Failed or unknown PNG attachment keeps the complete working draft and the same delivery identity for retry.
- Saved Drawings remain flattened, independent snapshots. They do not mutate the collaborative structured document.

## Security and privacy boundaries

Collaborative diagrams do not add arbitrary HTML, SVG, JavaScript, selectors, filesystem paths or prompt execution to the PWA. The browser receives only validated data primitives. Publishing from the CLI requires a regular JSON file, rejects symlinks and enforces the exact-task destination. The iPad cannot read diagrams from another task.

The structural sync and the composer attachment are deliberately separate:

- **Sync revision** updates the private diagram document.
- **Send** attaches one rendered PNG to the exact visible native composer.
- Neither action submits a Codex message.

## Verification boundary

Unit, component and Playwright tests prove validation, exact-task isolation, optimistic revisions, local draft restoration, structural touch editing, Pencil composition, revision sync, image-only Send and non-reopening after a confirmed Send. Browser screenshots cover iPad landscape, iPad portrait and phone layouts.

Physical Apple Pencil pressure, tilt, palm rejection, display cadence and long iPadOS suspension still require the manual device checklist. Browser pointer simulation is not reported as hardware proof.
