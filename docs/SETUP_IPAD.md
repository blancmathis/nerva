# iPad setup

> **Current implementation:** the install-first fragment handoff, internal scanner and no-typing fallback are present today. Safari and an installed Home Screen PWA may still have separate storage/navigation behavior on iPadOS, so scanning the same still-valid QR a second time inside Nerva is the supported fallback. See [the pairing target](product/PAIRING_target.md).

Nerva is installed as a Safari PWA and reaches the Mac through private Tailscale HTTPS. The Mac bridge remains bound to loopback. Existing technical storage names keep `codex-pad` for upgrade compatibility.

## Before starting

Complete [Mac setup](SETUP_MAC.md) first. You need:

- an iPad with a current supported iPadOS/Safari version;
- Tailscale signed into the same intended tailnet as the Mac;
- the HTTPS MagicDNS URL from `tailscale serve`;
- a fresh five-minute one-time pairing QR from the bridge;
- Apple Pencil for pressure and palm-rejection checks, if supported by the iPad.

The owner has completed the real-iPad Tailscale pairing, Home Screen installation and credential-reuse path. Apple Pencil behavior, Camera/Photos/Files imports, timed clean-device setup and the full lifecycle matrix have not yet been recorded; treat the relevant sections below as required verification rather than passed hardware evidence.

## 1. Connect privately

1. Open Tailscale on the iPad and confirm the intended account/tailnet.
2. Run `npm run setup:mac` for the first install, or `npm run pair` for an already configured Mac.
3. Scan the terminal QR with the iPad camera. Confirm Safari shows the exact private HTTPS MagicDNS origin. Do not proceed through a certificate warning or substitute a raw LAN address.
4. Safari displays `Add Nerva to your Home Screen` without consuming the invitation. Use Share → Add to Home Screen, keep Open as Web App enabled, then launch Nerva.
5. If the installed app shows `Connect to <Mac name>`, tap `Connect`. If it opens `Scan the QR on your Mac`, scan the same QR once more inside the app. There is no code, URL, origin or device-name field.
6. Confirm the app reports `Mac connected` and opens the exact current Mac session. If the invitation expired, run `npm run pair` and scan the new QR.

Successful pairing returns one random 43-character revocable bearer credential once. Nerva stores it only in the `codex-pad-origin-auth` IndexedDB for this exact scheme/host/port origin, or keeps it in memory for the current page when private storage is unavailable. It is never placed in a cookie, URL, service-worker cache, or `localStorage`; do not copy it between browsers or origins. Exact-origin storage matters because browser cookies ignore ports and could otherwise reach approved review servers on sibling MagicDNS ports.

HTTP requests use `Authorization: Bearer`. Each WebSocket connection first obtains a 30-second, one-use, exact-Origin ticket from `POST /api/ws-ticket`, offers that ticket alongside the fixed `codex-pad.v1` protocol, and stores neither ticket. Reconnect always requests a fresh ticket. An upgraded installation may receive expiration headers that remove legacy host-wide Nerva cookies; those old credentials are revoked rather than migrated.

## 2. Reopen the installed PWA

The installed app opens without Safari chrome and reuses its bearer from exact-origin IndexedDB. A new QR is not required each day. Pair again only after explicit revocation, cleared site data, a changed private origin or unrecoverable credential loss.

The cached shell can open while offline, but live controls and sending remain disabled until the bridge is authenticated and a fresh snapshot is reconciled. Home layout and the last safe snapshot remain consultable; local drawing/review drafts remain on this iPad. Mac-backed settings and Saved Drawings refresh after reconnection.

## 3. Enable intelligent notifications

Notifications are optional. They work only from the installed Home Screen app, not an ordinary Safari tab.

1. Open Nerva from the Home Screen while the Mac bridge is connected.
2. Open **Settings → Notifications**.
3. Tap **Enable** once. This direct touch is required by iPadOS; pairing and Mac setup cannot grant notification permission for you.
4. Accept the iPadOS permission prompt. Confirm the row changes to `Active—even when Nerva is fully suspended.`
5. In iPadOS Settings, choose the desired Lock Screen/banner style and Focus behavior for Nerva. Nerva does not bypass Focus.

Nerva sends only a blocking question, approval, error, pinned important completion, or grouped ready results. The visible copy is generic and never includes task content. Tapping opens the exact Session or Home's priority focus. There is deliberately no approval button in the notification.

Use **Turn off** in the same row to remove the Mac-side subscription before unsubscribing the iPad. If permission is blocked, re-enable Nerva in iPadOS Settings, return to the installed app and tap **Enable** again. No QR or pairing reset is needed.

## 4. Verify Home and Session

Check both portrait and landscape:

- Home shows only the 0–12 pinned sessions, with no fake empty slots;
- every card has a textual status, not color alone;
- manual sections, cases and loose pinned cards are the only durable Home layout;
- the compact priority button shows pinned attention first, then other pinned sessions, then unpinned attention;
- `Approval`, `Error`, `Working`, `Waiting` and `Completed` are direct temporary filters across pinned and unpinned sessions;
- toggling a filter off restores every manual section, case and placement unchanged;
- `Unpinned Sessions` lists non-pinned sessions and pinning a thirteenth asks which existing one to unpin;
- title expansion does not cover controls;
- connection state changes among `Mac connected`, `Connecting`, `Reconnecting`, `Pairing`, and `Offline`; a stale snapshot has a separate warning;
- Session exposes Pin/Unpin independently from the explicit navigation state `Following Mac` / `Staying here`;
- every interactive control has a touch target of at least 44 points under coarse-pointer input;
- VoiceOver labels identify session, title, state and actions;
- reduced-motion mode removes nonessential pulsing and movement.

If native Micro discovery is degraded, stale titles may remain visible for orientation, but native controls and Send must be disabled.

## 5. Verify Apple Pencil input

Open **Draw** from a selected agent. Before drawing, confirm the header repeats the destination title and thread-ID suffix.

Test:

- a slow pressure-varying pen stroke;
- a quick stroke with no gaps from coalesced Pointer Events;
- highlighter, eraser, arrow, rectangle, ellipse, and text;
- color and size changes;
- undo, redo, and confirmed clear;
- Camera, Photo Library and Files through the explicit source sheet;
- after restoring a marked draft, confirm `Clear`, import a photo, and verify only the new photo remains; deleted marks must never return;
- one real `.HEIC` or `.HEIF` photo imported from Photos or Files;
- white, transparent, and dark backgrounds;
- Pencil-only drawing with one touch/palm passive and exactly two fingers used for pan or pinch-zoom.

The drawing studio should suppress text selection, touch callouts and page overscroll so Pencil plus palm contact never highlights the site. `touch-action: none` remains scoped to the canvas itself; toolbar controls must still scroll, focus and activate normally.

## 6. Verify multimodal workspace capabilities

These surfaces are capability-gated. A visible control is not proof that its live transport has been validated.

- On a physical iPad, use **Camera** to take a non-sensitive rear-camera photo. Confirm returning from the system camera picker creates one distinct review frame. Open the picker again, cancel without taking a photo, and confirm the existing deck is unchanged.
- Import an actual `.HEIC` or `.HEIF` photo from Photos or Files. When Safari can decode it, confirm Nerva converts it to a bounded PNG before persistence and that the frame survives reload. If that Safari version cannot decode it, confirm the UI gives the explicit HEIC/HEIF support error; export the same photo as JPEG or PNG and verify that fallback imports successfully without losing the deck.
- Add two or more non-sensitive photos/site frames to a bounded review deck, annotate and reorder them, then delete one item to omit it. Confirm the outbound preview lists every retained image label in exact order with its MIME type and pre-normalization byte size. A multi-frame send must remain disabled unless the bridge reports a successful bounded multi-`localImage` runtime probe.
- Open **Sites**. Confirm one **Open sites** list contains only the HTTP(S) pages attached to this exact Codex task, including its local pages and external HTTPS pages, with no linked/unlinked split. Open another task with a different page and verify that page never appears in the first task's list. Choose a visually confirmed page. Tap and scroll it, use Back/Forward/Refresh, then touch it with Pencil and confirm the visible frame freezes directly into the minimal annotation controls. Repeat after enabling **Touch + Pencil**. The Site surface must not show Filmstrip, Blank frame, Photo / Files or Camera. `Send` must attach only the annotated PNG to the exact Mac composer and must not submit the prompt.
- Open before/after comparison, select both sides explicitly, and confirm the comparison control never modifies either source frame. After a synthetic unread-complete agent signal, confirm nothing is captured automatically. On the audited Mac, where registered-route capture reports `process-sandbox-unavailable`, explicitly import the After image. A future environment may offer registered-route After only after its capture capability is green, and must label it as a fresh Mac browser context. Save the iteration, start another from the chosen baseline, and confirm Diff produces a bounded local heatmap for equal-size images while reporting incompatible dimensions or missing local media explicitly.
- Select one authoritative native task and inspect the Dictation control. When the bridge cannot prove its current native binding, confirm the control stays disabled and no fallback appears. On a live-verified setup, tap **Dictation** once and confirm only that exact selected task enters Codex Desktop's native dictation state, the Mac counter advances beyond `0:00`, and the iPad control becomes **Stop Dictation**. Speak, then tap **Stop Dictation** to send the matching native release. Codex Desktop must use the microphone selected on the Mac and own the resulting transcription. Session Dictation must show no iPad microphone-permission prompt, audio playback, voice segment or transcript editor, and dictated text must not be inserted into the review deck. Capture Inbox must not expose Voice or request the microphone; the separate Site QA checkpoint note may request it only after its explicit tap.
- Create two Home sections and cases, then move sessions between them. Confirm the Codex session status, project and native slot do not change. Delete one case and confirm its sessions return directly to Home rather than being unpinned.
- Keep one drawing, open Saved Drawings, filter it by source session, reopen it as a working copy, then delete the saved original manually. Confirm editing the working copy never mutates the kept record.
- Open Skills and confirm the list corresponds to the exact session cwd rather than always showing zero. Arm multiple skills and confirm they remain armed after an image-only Drawing send.
- Move the Model + Reasoning slider once with touch through only combinations selected in Settings and still returned by the live installed catalog. Release the finger without a second tap and confirm the final displayed combination updates the exact selected task; this specifically covers Safari delivering its last range input after `pointerup`. Disable or invalidate all configured presets and confirm no unselected catalog model replaces them. Test Fast separately against its exact native binding.
- Prepare text by typing on the Mac or using iPad Dictation, then tap the compact **Send prompt** control. Confirm only the exact selected task's native composer is submitted and Codex Desktop follows its own Queue/Steer setting; the iPad must not invent a delivery state.
- Start while the managed app-server is still reconnecting, then leave the Session visible. Confirm Drawing `Send`, Skills and Model + Reasoning become available automatically within one foreground capability-poll interval even when the native session does not change; do not reload or re-pair.
- In Settings, add a Model + Reasoning preset by choosing from the live Codex model names and that model's supported efforts. Confirm there is no free-form model identifier field.
- With `Following Mac` visible, open Draw and then choose another task on the Mac. Confirm Nerva closes Draw and shows the new Session controls instead of opening a blank canvas for the new task. Repeat with a task outside the current six native slots: the iPad follows for navigation but native controls remain display-only. Return to the original task and confirm its local draft remains available.
- Switch to `Staying here`, change task on the Mac and confirm the iPad remains in place. Tap the navigation toggle once so it reads `Following Mac`; the iPad must immediately open the task already active on the Mac without requiring another Mac-side change.
- Reconnect on another iPad only when performing the replacement test. Confirm the global Home layout and settings return from the Mac, while non-Keep drafts do not.

The bridge reads Codex Desktop's own browser-webview conversation binding and reconciles client-local conversation IDs only when the active sidebar and canonical composer agree on the requested task. It never infers task ownership from a page title, displayed URL, project, recency or position. A duplicate or ambiguous private page mapping is omitted. Choosing one opaque row is the explicit per-use instruction for the currently visible Session, and before every frame or gesture the bridge must prove that the ID still belongs to that exact task. The iPad must never receive query strings, fragments, credentials, debugger URLs, raw CDP, arbitrary URL navigation or JavaScript execution.

## 7. Check draft recovery

With an unsent scene:

1. Return to the Home Screen for one minute, then reopen Nerva.
2. Confirm the destination and vector draft are restored.
3. Repeat after force-closing and reopening the PWA.
4. Switch to another agent, create a second draft, and verify each thread restores its own scene.

The service worker preserves only the app shell. Content IndexedDB preserves drafts and the latest normalized bridge snapshot for stale/offline orientation; that snapshot can contain task titles, thread UUIDs, slot state, and bounded approval summaries, but not transcripts or raw API response bodies. A separate origin-scoped auth database contains only the current bearer record. No mechanism should cache agent responses, full authentication API payloads, or WebSocket tickets. Clear site data for this exact PWA origin to remove all of those local records.

Imported non-HEIC PNG/JPEG/WebP draft blobs remain unchanged locally and may retain EXIF/XMP metadata such as location until the frame/draft is deleted, local garbage collection removes it, or site data is cleared. Outbound PNG normalization strips that metadata before delivery, but it does not sanitize the stored local original.

## 8. Send the drawing

The drawing header must keep the exact destination title and thread-ID suffix visible. There is no drawing instruction textarea or intermediate `Review before send` sheet: tap the primary **Send** button once. The outbound turn must contain the PNG as its only user input. Selected Skills remain armed for the next text-bearing action; add a separate instruction afterward with native Dictation if needed.

After the first meaningful Pencil or finger mark is committed, **Send** must become enabled. A normal `pointerup`, `pointercancel`, or iPadOS `lostpointercapture` must all finish the active interaction; the last case must not leave a visible preview stroke with an empty scene and a disabled button.

The UI should disable duplicate execution while the command is in flight. If the network response is lost, Retry must reuse the same `commandId` so the durable bridge ledger returns the prior result instead of creating another turn—even after a bridge restart or a 60-minute suspension. A retryable `DELIVERY_UNKNOWN` result stays pending and must not be converted into a new ID automatically.

An idle agent may accept the message immediately. A working agent is steered only when the exact active turn ID and image-steering capability are proven; otherwise the UI must return immediate `Agent busy`, keep the draft, and hold no request for later delivery. Wait for the agent to become idle, review the target again, and initiate a new explicit send. It must never silently retry, fork, or choose another thread.

Only a confirmed result triggers the short lateral send animation and closes the studio. The editable vector draft remains stored for later recovery or reuse until the user explicitly clears it.

## 9. Verify background recovery

iPadOS may suspend WebSockets. Test background intervals of 1, 10, and 60 minutes. After each resume, Nerva should:

1. show `Reconnecting` rather than an outdated `Connected` state;
2. create a new connection;
3. fetch a full snapshot;
4. reconcile the bridge-instance/sequence tuple and pending commands;
5. preserve drafts;
6. remain read-only even if HTTP refreshes the display, until that exact active WebSocket emits a valid snapshot matching or advancing the accepted tuple;
7. enable mutations only after socket attestation and fresh target validation.

Also toggle Wi-Fi and test from a different network over Tailscale. Complete the evidence table in [the manual checklist](MANUAL_TEST_CHECKLIST.md).

## 10. Revoke or replace the device

List and revoke the iPad from the built Mac CLI:

```bash
npm run codex-pad -- device list
CODEX_PAD_DEVICE_ID="paste-exact-device-uuid-from-list"
npm run codex-pad -- device revoke "$CODEX_PAD_DEVICE_ID"
```

Revocation should close its active socket and make subsequent HTTP mutations fail authentication. The cached shell and local drafts can remain on the device, but no live state or control should work.

To remove local data, clear the website's data in iPadOS Safari settings or remove the PWA and its site data, then revoke the device on the Mac as well.
