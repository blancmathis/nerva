---
context_room:
  kind: canonical
  scope: product
  status: current
  canonical_for: implemented Capture Inbox behavior
  last_verified: 2026-07-26
  sources: [apps/web/src/components/CaptureInboxPage.tsx, apps/web/src/lib/capture-inbox-store.ts, apps/web/src/lib/capture-review.ts, apps/web/e2e/codex-pad.spec.ts, apps/web/e2e/pwa-offline.spec.ts]
---

# Nerva — Capture Inbox

Capture Inbox is a reusable local library. It lets the user capture context before choosing a Session, then open the same library from the exact Session where that context is useful.

A capture is never assigned to a Session. Nerva stores no destination, routing state, or `prepared` marker in the Inbox.

## Current user flow

### Capture and manage from Home

1. Open `Capture Inbox` from Home.
2. Choose `Photo`, `Scan`, `Sketch`, `File`, or `Note`.
3. Nerva stores the capture in IndexedDB on this iPad, without a Session or Mac request.
4. Search, filter, or inspect captures. Every card has a direct touch delete control; `Select` also enables explicit multi-delete.
5. Every deletion requires confirmation. Cancel preserves the original; confirm removes it only from this iPad.

### Use from a Session

1. Open the exact Session first.
2. Under `Choose an input`, tap `Capture Inbox`.
3. The Inbox shows a temporary context with that Session's title. This context is never written into the captures.
4. Select one or more compatible notes or images and tap `Use in session`.
5. Nerva copies them into the local Review for the exact displayed `threadId` and opens that Review. Originals remain in the Inbox.
6. The same item can be reused later from another Session. Use never moves, consumes, or assigns it.

`Use in session` sends nothing to the Mac. Delivery remains the existing Review flow: explicit preview, exact capability, and separate confirmation. Reconnection triggers none of those steps.

Changing the Mac Session does not close a capture started from Home. When a Session opens the Inbox, however, the temporary use context remains bound to that exact Session until the user explicitly leaves.

## Capture types

| Type | Local capture | Current Session use |
| --- | --- | --- |
| `Photo` | Camera or photo library through the system picker | Yes, after Review validates and normalizes PNG/JPEG/WebP/HEIC/HEIF |
| `Scan` | Rear-camera document photo | Yes, as an image. Nerva does not claim iPadOS native document-scanner behavior. |
| `Sketch` | Touch/Pencil canvas, Pencil-only by default, passive palm, two-finger navigation | Yes, as a bounded PNG |
| `File` | Received file, with no execution or arbitrary preview | Only when it is a compatible image; other files remain local |
| `Note` | Local text up to 20,000 characters | Yes, in Review's general instruction. A note alone still needs an image or annotation before Review can prepare a valid send. |

Capture Inbox has no `Voice` action and never requests microphone permission. Session Dictation and the optional Site QA checkpoint voice note are separate capabilities with separate contracts.

Nerva never silently deletes or converts an unsupported file. A selection containing a non-image file explains the limit and leaves the original in the Inbox.

## Storage and migration

- separate IndexedDB database: `nerva-capture-inbox`;
- at most 200 captures;
- at most 32 MiB per capture;
- at most 256 MiB accounted Inbox data;
- bytes stored as `ArrayBuffer` to avoid unreliable WebKit `Blob` clones;
- no destination, assignment, preparation, or delivery field;
- direct or multi-select deletion, always confirmed.

Store v2 migrates older local data without dropping bytes: it removes historical destination/preparation fields and turns a historical `voice` item into a generic audio file. Its title becomes `Audio file…`; it remains stored, but the microphone is not restored to the UI.

Capture Inbox is not part of Mac Product State and does not return on a replacement iPad. This is intentional. Layout, preferences, and Saved Drawings follow their own synchronization rules.

## No-send guarantees

The Capture Inbox store has no `queued`, `pendingSend`, command, retry, or replay state. Capturing, viewing, selecting, and deleting never call `/api/command`, Sketch transport, or `sendReview`.

`Use in session` writes only to the displayed thread's local Review. WebSocket or bridge reconnection never reads the Inbox and never starts a delivery effect. Only a later explicit Review gesture may prepare and confirm a send.

## Evidence and limits

Local tests cover storage, v1-to-v2 migration, absence of destination state, unsupported transport files, exact-Review note/image copying, reuse in two Sessions, reload, offline/reconnect, absence of Mac commands, and an emulated Pencil canvas. Flows pass under Chromium and WebKit for iPad landscape, iPad portrait, and phone profiles.

Physical Camera/Photos/Files behavior, iPadOS storage pressure, real Apple Pencil input, background suspension, and persistence after iPadOS eviction remain unproved.
