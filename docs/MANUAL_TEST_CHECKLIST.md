# Manual Mac, iPad and Apple Pencil checklist

Use this checklist to distinguish local automation from a live, physical-device result. It follows the current unified Home and `Home → Session` implementation plus the accepted completion bar in [`product/FEATURES_target.md`](product/FEATURES_target.md). A checked item needs dated evidence; the presence of a button is not proof that its native side effect worked.

## Evidence record

```text
Date/time:
Nerva commit:
Mac model / macOS:
Codex Desktop / bundled Codex:
Node / Tailscale:
iPad model / iPadOS / Safari:
Apple Pencil model:
iPhone model / iOS / Safari:
Tailnet/network path:
Tester:
Evidence location:
```

## Latest recorded automated run

```text
Date/time: 31 July 2026, Europe/Paris
Nerva commit: uncommitted hardening worktree based on 5023b3c
Mac / macOS: Apple Silicon arm64 / macOS 26.5.1 build 25F80
Codex Desktop / bundled Codex: 26.727.40816 build 6067 / codex-cli 0.146.0-alpha.9.2
Node / npm / Tailscale: 22.23.0 / 10.9.8 / 1.98.9
iPad / iPadOS / Pencil: not recorded in this run
iPhone / iOS: not recorded in this run
Evidence: local working-tree validation plus a clean local clone of the exact non-ignored source snapshot; no hosted CI or physical-device proof for these changes
```

Current local result: 1,030 unit tests plus 19/19 probe-safety tests, build, a maximum observed 402.15 kB largest JavaScript chunk, 343 E2E passes with 17 explicit profile exclusions and no retry, six real-bridge profiles, 10 consecutive WebKit iPhone Site QA runs, 10 consecutive isolated real-bridge runs, Axe coverage, 39 regenerated current public screenshots, the 463-file working-tree release audit, documentation check, Context Room doctor and zero dependency vulnerabilities. The exact non-ignored source snapshot was reproduced from a clean local clone with a 452-file release audit and a clean final tree. Physical iPad/iPhone/Pencil checks remain deliberately unchecked. The historical public baseline and hosted CI evidence remain recorded in [`product/CURRENT_STATE.md`](product/CURRENT_STATE.md).

Runtime result on 31 July 2026: default doctor and `setup:check` both report **Ready with limitations** and return success. Tailscale is running, with the Mac and previously paired iPad online. Nerva observes Desktop-bundled `0.146.0-alpha.9.2`, standalone `0.146.0`, and three unrelated stdio writers. The managed socket does not answer, no exact current schema attestation or Desktop ownership proof exists, and the native Micro adapter is degraded. With explicit user authorization, only the Nerva LaunchAgent was restarted; its PID changed while the observed Codex app-server PID set did not. Local bridge health returns HTTP 200, and the private HTTPS Serve route and same-origin WSS endpoint are reachable.

The restarted bridge serves a private immutable web snapshot whose `app-meta.json` matches its compiled identity. A temporary-device protocol simulation and a fresh headless WebKit iPad PWA through the real private Tailscale origin both passed pairing, authenticated snapshot/ticket/WebSocket delivery, online rendering, revocation and post-revocation denial. The Mac-to-iPad Tailscale path remained direct across repeated samples. No Codex process was restarted, no writer was stopped, and no setup mutation was performed. `npm run doctor -- --strict-native` remains nonzero. Physical pairing gestures, Pencil, microphone, camera, push, multi-image input and native controls were not verified in this run.

## A. Mac setup and pairing

- [ ] From a clean supported clone, with Tailscale already signed in, run OpenAI's official Codex installer as the install/update path, then `npm run setup:check` and `npm run setup:mac`; no native Nerva pairing app or second terminal is required.
- [ ] `npm run setup:check -- --json` is read-only and returns Ready, Ready with limited Codex controls, or Blocked with exact observed versions and safe remediation.
- [ ] `setup:mac` generates separate fingerprinted schema caches for the currently installed Desktop and daemon binaries before installing the bridge; Settings → System Diagnostics reports the exact compatible capabilities rather than silently relying on an older version.
- [ ] In Ready state, the command uses the Desktop-bundled Codex daemon manager and changes only its managed daemon state plus Nerva-owned private state, `com.codex-pad.bridge`, the GUI local-daemon opt-in and the exact private Serve route.
- [ ] In Ready with limited Codex controls, setup installs the bridge and pairing but does not bootstrap the daemon, remove or stop a writer, set the Desktop environment flag, create an attestation or restart Desktop. App-server-backed controls visibly remain unavailable and no command reaches an unattested writer.
- [ ] The bridge remains on `127.0.0.1:8787`; CDP and app-server sockets are not exposed to LAN/tailnet interfaces.
- [ ] A fresh physical-iPad setup completes in under 120 seconds after the Tailscale preflight.
- [ ] Safari shows the install-first instructions without consuming the invitation; **Share → Add to Home Screen** produces a standalone Nerva icon.
- [ ] Opening the installed app pairs with one **Connect** tap and no typed code or device name.
- [ ] If iPadOS drops the invitation during installation, the internal Camera/Photo scanner accepts the same still-valid QR without typing.
- [ ] The QR invitation is five minutes maximum, one-use, exact-origin and rejected after redemption or expiration.
- [ ] Later Home Screen launches reuse the persistent credential and do not require a daily QR.
- [ ] `npm run pair` supports an already-installed but unpaired app.
- [ ] Revoking a device in Settings immediately closes its active connection and rejects the old bearer.
- [ ] A second replacement iPad can pair before the first is revoked; the old device is revoked only after the replacement succeeds.

Owner-confirmed evidence already recorded on 20 July 2026: Tailscale was connected on the Mac and iPad, QR pairing succeeded, the PWA was added to the Home Screen, and reopening reused the credential after one successful installed-app connection. The clean-clone timer, expired QR and replacement-device flows are still unchecked until separately recorded.

## B. Home and global Product State

- [ ] Home displays only pinned sessions and no fake empty slots at 0, 1, 2 and 12 pins.
- [ ] Pinning a thirteenth session opens an explicit replacement choice and atomically unpins only the selected card.
- [ ] `Unpinned Sessions` contains every and only non-pinned session, supports search and exposes recent/project organization.
- [ ] Unpinning returns a session to the drawer without archiving, deleting, stopping or otherwise mutating it.
- [ ] `Open current Mac session` is one tap from Home and does not pin automatically.
- [ ] In iPad landscape the Home heading, `Codex usage`, `Open current Mac session` and Settings fit in one 52 CSS pixel band. In portrait the heading becomes a compact label and the three controls remain in the same band beside the floating brand; on phone the action band moves below the brand/title line without stacking the two action cards. Both cards keep equal height, remaining usage stays readable and Refresh retains a 44 CSS pixel target.
- [ ] Rich cards show only reliable name, project/repo, worktree, branch, colored status, freshness/elapsed and at most two truthful activity lines; unknown information is omitted.
- [ ] Compact density remains legible and all primary touch targets are at least 44 CSS pixels.
- [ ] A short tap opens the exact session; there is no `Arrange` / `Done arranging` mode, and the compact `New section` action remains available in the Home control bar.
- [ ] One stationary long press does not open the session; continuing that same contact into a drag moves the card before another card, into a case, between cases or back to `Directly on Home`.
- [ ] Releasing any drag leaves Home visible and never opens the moved card or the card now under the finger; every drop preserves pin membership and only changes presentation order.
- [ ] Home allows loose pinned cards plus the visible durable hierarchy `section → case → session`.
- [ ] Sections and cases can be created, renamed, colored, reordered and moved with touch and accessible button/menu alternatives.
- [ ] A case shows its cards directly and never behaves like a folder that must be opened first.
- [ ] Removing a case or section returns its sessions directly to Home and keeps them pinned.
- [ ] The compact priority button has no `Attention view` banner and shows pinned attention first, then other pinned sessions, then non-pinned attention.
- [ ] `Approval`, `Error`, `Working`, `Waiting` and `Completed` are independent 44 CSS pixel filters. Each includes matching pinned and unpinned sessions once; Idle unpinned sessions remain only in `Unpinned Sessions`.
- [ ] Tapping the active priority/status button again restores the exact sections, cases, loose cards and order; the temporary focus creates no Product State write.
- [ ] Layout, pinned membership, theme, density, motion, notification/haptic preferences and model/reasoning presets survive app restart and appear on a newly paired iPad.
- [ ] Pin or unpin a session and immediately background/reload the installed PWA; the changed membership survives without waiting on screen.
- [ ] A fresh Product State starts with zero pins even when native Micro slots are occupied; sessions appear on Home only after an explicit pin action.
- [ ] After at least one complete catalog load, suspend the app-server, return a partial catalog, or restart the bridge. Known pinned cards remain in their exact loose/case position with `Status unavailable`; an unknown ID renders no fake card and remains pinned until explicit `Unpin`.
- [ ] Fail a Product State write, reload immediately, and confirm the locally changed pins/presets are restored and retried. A stale revision refreshes the Mac revision without rolling the local intent back.
- [ ] A brief two-client overlap cannot corrupt Product State; no collaborative multi-iPad UX is expected.

## C. Home priority and status focus

- [ ] Priority and status focus stay inside Home and reuse exactly the same session-card design as the manual layout; there is no separate Mission Control page or automatic status board.
- [ ] Matching pinned and unpinned Codex sessions appear once. Internal subagents do not appear as extra cards.
- [ ] Title, project label, reliable status, activity time and `On Mac` match the existing session catalog. No prompt, turn output, reasoning trace or local path appears.
- [ ] Touch any focused card: the exact same session opens on both iPad and Mac through the existing Session route.
- [ ] While a focus is active, change tasks twice on the Mac with Follow Mac enabled. Home remains visible; entering a Session or toggling the focus off restores normal Follow Mac behavior.
- [ ] Stop or reconnect the managed app-server while a focus is open. Last-good behavior remains honest, no agent is invented and unproven mutation controls remain absent.
- [ ] No focused card exposes Stop, Steer, Interrupt, reassign, reparent, prompt, shell or arbitrary command controls.
- [ ] Controls and cards remain readable and touchable in System/Light/Dark on iPad landscape, iPad portrait and phone without horizontal page overflow; status controls may scroll horizontally inside their own row on phone.

## D. Session navigation and controls

- [ ] Every Session clearly shows its exact title/context and whether it is pinned.
- [ ] Enter a pinned Session from both the manual layout and a status focus; confirm there is no rail, pagination or previous/next UI. Horizontal, diagonal and curved drags anywhere on the Session page must never move the surface, open another session or return Home. Vertical page scrolling remains native. Tap the floating product mark once to return Home, then choose the next exact session explicitly.
- [ ] Start vertically anywhere on the Session page and confirm the page scrolls without navigating. Horizontal or diagonal drags have no app-level navigation effect.
- [ ] Confirm Model + Reasoning remains directly adjustable and that editable fields, Draw, Review and Pencil strokes never arm the Session/Home gesture.
- [ ] `Pin to Home`/`Unpin from Home` changes Home membership only.
- [ ] `Following Mac` mirrors later Mac session changes; `Staying here` prevents them from replacing the iPad view.
- [ ] After the Mac changes task while `Staying here` is active, one tap to restore `Following Mac` immediately aligns the iPad to the already-current Mac task without requiring a second Mac navigation.
- [ ] A Mac task outside the native six still becomes the iPad Session in `Following Mac`, shows `Display only`, and never inherits native controls from the previously selected slot.
- [ ] If Follow Mac changes task while Draw is open, the old thread-scoped draft is saved, Draw closes, and the new Session page is shown with its input controls.
- [ ] `Return to previous iPad view` restores the saved session/page state after a Mac-follow transition.
- [ ] An iPad-originated open does not create a false “Mac changed sessions” return banner.
- [ ] After one successful `/api/sessions` response, force the managed app-server into reconnect backoff and open a non-native session from that catalog: the Mac deep link still opens without another catalog request, while an arbitrary thread UUID is rejected.
- [ ] After a definitive iPad `openSession` rejection, change the Mac task twice, including back to the failed target: with `Following Mac` active, the iPad follows both changes and no stale iPad-origin marker suppresses the second one.
- [ ] Native Micro actions are enabled only for an exact fresh verified native-slot binding; a pinned/catalog session outside the six never inherits them.
- [ ] The first `Dictation` tap sends only the native press for the exact selected task, the Mac counter advances beyond `0:00`, and the iPad control becomes `Stop Dictation`.
- [ ] `Stop Dictation` sends only the matching native release and Codex Desktop finishes transcription through the microphone selected on the Mac.
- [ ] `Send prompt` stays compact but at least 44 px tall, and invokes only the exact current `ACT12` / `CODEX` / `composer.submit` binding for the selected task. Codex Desktop alone chooses Queue or Steer from its Settings; the iPad shows neither invented state.
- [ ] While Dictation is active, one `Send prompt` tap releases the exact held microphone gesture, waits for its successful acknowledgement and refreshed native sequence, then invokes the exact `composer.submit` binding. A failed or unknown Dictation release never triggers the submit action automatically.
- [ ] Session `Dictation` never requests iPad microphone permission, stores browser audio, runs speech recognition or displays a transcript. It remains the separate native Mac microphone gesture.
- [ ] Approval shows `View command`, `Approve`, `Reject`, `Add instruction`; complete command and cwd are visible before the decision.
- [ ] Approve/Reject uses the exact still-actionable request/thread/turn/item/kind tuple and a stale tuple fails closed.
- [ ] Error shows truthful error detail, `Open on Mac` and `Add instruction` without inventing a retry.
- [ ] Completed interface work emphasizes Site/Review only when their exact capabilities exist.
- [ ] `Steer`, `Cancel` and `Interrupt` never appear as iPad controls.
- [ ] Skills is loaded from `skills/list` using the exact selected thread cwd when readable; while that read is temporarily unavailable, the global user/system catalog appears instead of a false empty list and no other task cwd is borrowed.
- [ ] Skills are organized automatically by provider/scope. A provider with at least two skills is a collapsible folder; a singleton skill is directly visible without a folder. Counts and selected counts are correct, exact skill IDs remain unchanged, and no local path or plugin version reaches the browser response.
- [ ] A text-bearing Nerva-originated send appends `Use the following skills for this task: skill-a, skill-b.` after all other instruction text.
- [ ] A Drawing send contains only its PNG, does not append a skill suffix, and leaves selected skills armed for the next text-bearing action.
- [ ] `Send prompt` appends the validated Skills suffix exactly once through the exact visible composer paste handler before the separately attested native submit. A confirmed submit consumes those skills; a definitive failure or unknown result keeps them armed. Composer text never reaches the bridge/PWA.
- [ ] Model + Reasoning shows only combinations returned by the installed live `model/list` catalog and applies the exact selected combination through `thread/settings/update` after one touch drag/release, including Safari's final-input-after-`pointerup` ordering.
- [ ] A definitive Model + Reasoning rejection returns the slider to the last observed live combination; an unknown-delivery result remains explicit and is not silently retried.
- [ ] If the first capability response is degraded, the foreground two-second capability poll automatically refreshes Drawing, Skills and Model + Reasoning without requiring a native snapshot change, reload or re-pairing.
- [ ] On a task with a large history, at least 12 consecutive foreground refreshes keep Drawing, Skills and Model + Reasoning stable; bridge logs show no managed-socket disconnect, and exact active-turn resolution uses only the latest turn without items.
- [ ] Settings offers only models returned by live `model/list` and only the selected model's supported reasoning levels; no free-form model identifier can be entered.
- [ ] Settings controls which valid presets appear in the Session slider. Once any preset is configured, disabled, invalid or temporarily unavailable presets are hidden and no unselected catalog model is substituted. The full bounded catalog appears only when zero presets exist.
- [ ] Simulate a newer Mac preset revision while the current iPad still holds an older Product State, then change only Home layout. The conflict refresh/retry preserves the newer presets. Repeat in the opposite direction: a Settings-only change preserves the newer Home layout.
- [ ] Native reasoning and Fast remain separate exact-binding controls and fail closed when their current Micro identity is unavailable.
- [ ] Session has no redundant `Home` button. Tapping the floating product mark is the only one-touch Home route and never opens another session.

## Capture Inbox

- [ ] Open `Capture Inbox` from Home with the Mac online, then repeat with Tailscale/bridge unavailable. Photo, Scan, Sketch, File and Note remain available in both cases; no Voice or microphone action appears.
- [ ] Save one non-sensitive item of each type. Reload the installed PWA and confirm all five remain on this iPad with the correct preview and `Available in every Session` state. No card shows a Session, destination or prepared marker.
- [ ] In `Sketch`, keep `Pencil only`, rest the palm, draw with Pencil and move/zoom with exactly two fingers. Confirm one finger/palm does not draw or cancel the Pencil stroke. Repeat once with `Finger + Pencil`.
- [ ] From Home, tap the visible trash control on one capture. Cancel once and confirm it remains; confirm once and verify only that local original disappears. Then use `Select` on several items and confirm the explicit `Delete` button performs the same protected operation in batch. No Session picker, Assign, Route or Prepare action exists.
- [ ] Open one exact Session, tap `Capture Inbox` in `Choose an input`, and confirm the compact context bar shows this Session. Select compatible images/notes and tap `Use in session`. The exact Session Review opens locally with every chosen item, but the Mac receives nothing until Review's separate confirmation.
- [ ] In that same exact Session, select one to four file-only captures and tap `Attach to composer`. Confirm one native paste adds every uniquely named file to that exact Mac composer, preserves the original Inbox items, adds no text, and does not Queue, Steer, or submit. Verify the button remains unavailable when the Mac target is not exact, one file exceeds 8 MiB, or the batch exceeds 16 MiB.
- [ ] Force a rejected, partial, and unknown file-attachment result. Confirm the selection and originals remain available, Nerva names the uncertainty, reconnect performs no retry, and no missing remainder is added automatically.
- [ ] Close Review and confirm Nerva returns to the same Session. Open a second Session, select one of the same Inbox items, and use it again. Both Reviews keep their own copies and the Inbox original remains unchanged with no destination marker.
- [ ] Disconnect the Mac, capture items, leave/reopen the PWA, then reconnect. Confirm nothing is sent, queued or replayed and every capture remains neutral in the Inbox.
- [ ] Select a mixture of files and notes/images. Confirm neither destination is guessed, the UI asks for separate selections, and every original remains unchanged.
- [ ] Upgrade once from a build that contains a legacy Inbox voice record. Confirm it appears as a generic audio file with preserved playback bytes, no destination, and no way to start a new Voice recording.
- [ ] Delete selected captures and confirm the local originals disappear only after confirmation. Any image already copied into an existing Review remains in that Review.
- [ ] Fill the Inbox toward the 32 MiB per-item, 200-item or 256 MiB aggregate limits and confirm a bounded, actionable local error appears before a partial write.
- [ ] Clear Nerva's website data only as an intentional privacy reset and confirm Capture Inbox is removed with the other iPad-only records. Confirm a replacement iPad does not claim to restore this local-only Inbox.

## E. Draw, Photo and Saved Drawings

- [ ] Draw opens the touch-first editor and keeps `touch-action: none` scoped to the canvas.
- [ ] Photo opens an explicit source sheet whose `Camera`, `Photo Library` and `Files` controls are direct user gestures accepted by iPadOS.
- [ ] Each source opens the same editor with the chosen image and enforces type, byte, dimension and pixel-area limits before decode.
- [ ] Pen, highlighter, eraser, arrow, rectangle, ellipse, text, colors, widths, Undo/Redo, confirmed Clear and pan/zoom work in portrait and landscape.
- [ ] Pan far past the old 1440 × 900 page in every direction, including negative coordinates. No page edge appears, distant elements remain recoverable with `Fit board`, and the contextual minimap recenters then disappears after inactivity.
- [ ] Restore a marked draft, confirm `Clear`, then import a Camera/Photo Library/Files image. The imported image is the only remaining scene element and no cleared mark reappears.
- [ ] Apple Pencil pressure and tilt are reflected when available; pressureless input falls back safely.
- [ ] In `Pencil only`, one finger or a resting palm neither draws nor moves the canvas; two deliberate fingers pan/pinch, and lifting either finger stops navigation.
- [ ] Palm contacts received during an active Pencil stroke never become a delayed gesture after the Pencil lifts.
- [ ] Fast strokes remain continuous at the supported display cadence and pointer cancellation does not leave a stuck gesture.
- [ ] Losing Pencil pointer capture commits the visible stroke and enables `Send`; it does not leave only an uncommitted preview.
- [ ] A WebKit `pointercancel` during a visible Pencil stroke preserves the samples already shown as a partial stroke instead of deleting them.
- [ ] Board scene, camera and undoable state survive background suspension at 1, 10 and 60 minutes without a stale autosave restoring cleared content.
- [ ] Live strokes are not synchronized to the Mac.
- [ ] The exact destination remains visible; the studio offers direct `Send` with no instruction textarea or `Review before send` step.
- [ ] `Whole board` and `Select area` are the only Send choices. Move and resize the area frame with touch and verify exported content matches its world bounds.
- [ ] Verify one-image exports up to 4096² and synthetic 2/6/12-image plans. Every image remains below 8 MiB, the lot below 24 MiB and cumulative decoded pixels below 64 MP.
- [ ] For every multi-view plan, verify `01-map` is first; region cores cover the complete selected bounds without gaps; render bounds overlap symmetrically by 12%; each detail header names its board/export, ordinal, region, scale, neighbors and highlighted mini-map; both sides of every neighboring pair show the same `R-…` registration code and motif; and filenames remain understandable after deliberately reordering the attachments.
- [ ] Export a known structured Diagram across 6 and 12 views. Verify the map or separate structure index lists every block and inter-region edge, matching continuation codes appear on both sides of each known seam, and freehand Pencil marks receive no invented semantic labels.
- [ ] Manually submit the 6-view package and then the 12-view package to Codex. Ask it to reconstruct the block membership, edge directions, regions and Pencil annotations, then compare the reconstruction with the source board. Record the exact Codex Desktop and model versions; automation is not a substitute for this semantic-understanding test.
- [ ] Without exact-version batch attestation, a large board attaches exactly one bounded atlas PNG. With explicit batch attestation, one paste adds every uniquely named ordered tile and no message is submitted.
- [ ] Simulate complete, absent, partial and unknown batch postconditions. Complete confirms; absent allows only manual retry after reconciliation; partial requires Mac resolution and is never auto-completed.
- [ ] After confirmed attachment, reopening Draw starts on a blank `New page`; `Boards` reopens the checkpointed sent board without making it active by default.
- [ ] If attachment fails or its outcome is unknown, reopening Draw restores the exact working board and exact retained image bytes, then retries with the same delivery identity.
- [ ] Drawing attachment remains available while the managed app-server is reconnecting, provided the exact live native composer remains verified.
- [ ] Unknown attachment outcome keeps the draft and never auto-attaches again after reconnection or agent completion.
- [ ] `Keep in Saved Drawings` stores a Mac-backed record without sending it to Codex.
- [ ] Saved Drawings lists a thumbnail, source session and date; source-session filtering works.
- [ ] Opening a saved drawing in the current session creates an independent working copy and does not mutate the saved original.
- [ ] Re-Keep creates a new record; only explicit confirmed Delete removes a saved original.
- [ ] Limits fail clearly at 48 drawings, 8 MiB per PNG or 128 MiB total; no old record is silently evicted.
- [ ] A newly paired replacement iPad can fetch Saved Drawings, while non-Keep local drafts remain only on the source iPad.
- [ ] From one Codex task, publish [`examples/collaborative-diagram.json`](../examples/collaborative-diagram.json); Draw in that exact Session opens the latest unseen diagram automatically, while another Session cannot list or open it.
- [ ] In `Diagram` mode, move and resize blocks across negative and distant world positions with deliberately imperfect touch drags, rename and recolor them, add and delete connections, and verify Undo/Redo and extensible `Auto layout` with a dense 256-block document.
- [ ] Tap `Draw on top`, annotate across multiple diagram blocks with Apple Pencil, rest the palm on the display and use exactly two fingers to pan/zoom. Structural blocks and freehand ink remain aligned.
- [ ] Tap `Sync revision`, then run `diagram get` on the Mac. The returned structure has one incremented revision, `lastEditedBy: "ipad"` and the exact touch edits, without a PNG or composer mutation.
- [ ] Publish a newer Codex revision while the iPad has unsynchronized structural changes. Nerva announces the update but does not overwrite local work. Resolve by syncing/reloading explicitly.
- [ ] With a dirty collaborative diagram and Pencil annotation, tap `Keep`; the structure syncs first and Saved Drawings receives one flattened independent snapshot.
- [ ] With a dirty collaborative diagram and Pencil annotation, tap `Send`; the structure syncs first, then the Mac composer receives the compatible atlas or exact attested ordered batch and is not submitted.
- [ ] After confirmed Send, reopen Draw and confirm a blank page. Reopen the sent board through `Boards`; then publish a newer Codex revision and confirm the newer revision is offered explicitly without deleting Pencil ink.
- [ ] Disconnect the Mac after editing a diagram. The local draft survives, `Sync revision` fails visibly, and Keep/Send never claim that the structure was synchronized.

## F. Review and media delivery

- [ ] Review accepts only bounded inspected images and preserves the explicit selected order.
- [ ] Annotation, side-by-side, overlay, blink and local diff do not modify source frames or silently select a payload.
- [ ] A retained image is omitted only after explicit deselection/removal; a conversion failure sends no partial prefix.
- [ ] One-image send remains independent from the optional exact-version multi-image attestation.
- [ ] A successful current send creates one exact app-server turn, performs the lateral confirmation animation, and keeps the editable local draft for later reuse.
- [ ] Retry of an unchanged unknown delivery reuses the same idempotency ID and cannot execute twice.
- [ ] Drawing/Photo labels its action exactly `Send` and presents it as composer attachment, never as a submitted or queued Codex message.
- [ ] Only the visible native attachment postcondition animates the studio away; failure or unknown outcome keeps the editable iPad draft and same retry identity.

## G. Sites, Site Review and Site QA Recorder

- [ ] Every Session shows `Sites`. The page has one `Open pages` list containing only the current task's proven HTTP(S) pages in Codex Browser—local and external—with no linked/unlinked categories and no `Open Review without a site` fallback. Open distinct sites in two tasks and confirm neither task can list, capture or control the other's page.
- [ ] The address bar remains disabled until one proven page is selected. Enter a domain, complete HTTP(S) URL and local loopback URL; confirm each navigates only that selected page. Reject non-HTTP(S), embedded credentials and an unproven/closed tab.
- [ ] Star an open page and a typed URL. Reload, reconnect and open a second paired iPad; confirm favorites are restored globally but never select a Session or tab by themselves. Remove a favorite and confirm the Product State write persists.
- [ ] Query, fragment, credentials, raw tab ID and debugger URLs are absent from the QA manifest and injected prompt. Choosing a row never exposes raw CDP and never guesses another row from title, URL, focus, project resemblance or timing.
- [ ] The chosen live page supports tap, a deliberately imperfect human scroll path, controlled text insertion, typed HTTP(S) navigation, Back, Forward and Refresh. Navigating or closing the Mac tab refreshes or invalidates that exact opaque tab ID rather than selecting a replacement.
- [ ] Open several light and dark Mac pages on the physical iPad. After `Opening the Mac page…`, each page remains visibly rendered rather than becoming a black canvas; repeated 2.5 s refreshes and orientation changes do not regress it.
- [ ] The first Pencil contact freezes the visible frame and starts ink without opening another studio. With `Pencil only`, a finger browses; with `Touch + Pencil`, a finger can initiate annotation.
- [ ] The annotation dock contains only ink colors, width, Undo, Clear, Browse and Send. Filmstrip, Blank frame, Photo / Files, Camera, comparison and instruction fields are absent.
- [ ] `Send` attaches one annotated PNG to the exact native Mac composer without submitting it, injecting text or creating an app-server Review turn.
- [ ] The bridge rejects an unknown/stale tab and any non-allowlisted control. The PWA can request only a bounded HTTP(S) navigation in the selected page; it cannot request JavaScript, selectors, filesystem/clipboard access, debugger/CDP or desktop capture.
- [ ] `Record flow` shows duration and confirmed-step count. Tap, irregular scroll, Type, keys, Back/Forward/Reload and typed navigation create ordered receipts; an unconfirmed action creates no step. Pause stops collection without blocking browsing; Resume continues the same local draft; Stop opens Review.
- [ ] Lose the exact tab/thread proof mid-action. The recording pauses, explains the failure, stays local and never attaches the action to another tab. Reconnect and reload never send or replay it.
- [ ] In a password, OTP, payment, token, email and phone field, confirm the site receives the entered value but the receipt, IndexedDB draft, logs, errors and final prompt contain only the appropriate placeholder. Query and fragment are removed from recorded URLs.
- [ ] `Mark issue` freezes the latest confirmed frame. Pencil writes while a palm cannot; Touch + Pencil remains explicit. Expected, Actual and explanation persist. `Redact` is flattened into the approved PNG. A voice note requests the microphone only after the explicit tap, stops at three minutes and remains local; only edited text is sent.
- [ ] Review shows start, annotated issue and final evidence, low-confidence steps and the privacy summary. Removing a step reindexes without changing order. Select each Diagnose/Fix/Test intent.
- [ ] `Send to agent` sends one atomic 1–12 frame report to the exact UUID with the recording UUID as the idempotency key. Retry the identical draft after an unknown outcome and confirm no second task. Selected Skills remain the absolute final prompt text.
- [ ] Inspect the received prompt: it asks the agent to inspect the repository and propose a maintainable Playwright test, but contains no DOM, network, cookie, storage state, debugger URL, audio or invented assertion/secret/locator.
- [ ] On real iPad hardware, test Pencil, finger-mode annotation, palm contact, irregular scrolling, orientation changes, background/resume and the visible Mac-tab postcondition.

## H. Offline, recovery, accessibility and finish

- [ ] Install and pair Nerva on a physical iPhone. In portrait and landscape, exercise Home, one Session, Capture Inbox, finger Drawing, Saved Drawings, Review, Sites, Site QA and Settings. Confirm safe areas, keyboard avoidance, native scrolling, dialogs, sheets, 44 CSS pixel targets and the absence of page-level horizontal overflow.
- [ ] On that iPhone, background and resume each unfinished local studio once, rotate during an active draft, then repeat one offline/reconnect cycle. The same exact task and local content return, no action is duplicated, and no pending local capture is submitted automatically.
- [ ] With the Mac unavailable, Home and cached Session state remain consultable, remote controls say `Mac unavailable`, local drafts persist and nothing auto-submits later.
- [ ] Reconnect reconciles bridge instance/sequence and pending idempotent outcomes before enabling mutations.
- [ ] A replaced or stale WebSocket cannot re-enable controls.
- [ ] Rotation and iPadOS resume preserve exact Session, Home mode, sheet/editor state and scroll/zoom where specified.
- [ ] Every visible app label and injected prompt suffix is English.
- [ ] All essential actions are reachable by finger and Pencil, never hover-only; focus, dialog containment and accessible names work with a keyboard/screen reader.
- [ ] System/Light/Dark and Rich/Compact remain legible at iPad landscape, iPad portrait and phone sizes.
- [ ] Reduce Motion removes nonessential travel while preserving state transitions.
- [ ] Settings → System Diagnostics reports each layer independently, includes current versions/schema state and copies a diagnostic summary containing no prompt, output, title, cwd, token, local path or complete thread ID.
- [ ] From the installed Home Screen app, tap Settings → Notifications → `Enable`. Confirm the direct iPadOS permission prompt appears only after that touch, the row becomes `Active—even when Nerva is fully suspended.`, and no new pairing QR is required.
- [ ] Trigger one exact `Needs approval`, `Error` and `Waiting for your answer` transition from the Mac. Confirm each generic notification contains no task title, prompt, output, command, cwd or approval summary; tapping opens the exact Session, while the Lock Screen offers no Approve/Reject action.
- [ ] Complete one unpinned task and confirm it produces no completion alert. Complete one pinned task and confirm its alert opens that exact Session. Complete two pinned tasks within the grouping window and confirm one `Results ready to review` alert opens Home Priority rather than two noisy notifications.
- [ ] Fully suspend the PWA and repeat the notification matrix. Record iPadOS version, Nerva notification settings, active Focus mode, delivery delay, duplicate count, badge count and tap destination. This is the required proof for real Web Push wake-up; browser automation alone is insufficient.
- [ ] Tap `Turn off`, trigger another event and confirm no Push arrives. Re-enable without re-pairing. Revoke the paired iPad and confirm its subscription can no longer receive alerts.
- [ ] On iPadOS, Haptics is disabled with an explanation when `navigator.vibrate` is absent. No visual animation is counted as physical haptic proof.
- [ ] Activate a new build while a Drawing/Review/Site workspace or an unfinished Capture Inbox note/sketch/destructive confirmation is open. The update banner appears but reload stays disabled; after leaving or saving the workspace, explicit reload shows the new build without a new pairing QR.
- [ ] If Context Room is configured, the card shows only sanitized read-only health for the exact loopback room. Stop the room and confirm last-good data becomes unavailable; invalid or arbitrary Nerva Card HTML/JavaScript renders nothing.

## I. Local release gate

- [ ] `npm run check`
- [ ] `npm run docs:check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run check:bundle`
- [ ] `npx playwright install chromium webkit`
- [ ] `npm run test:e2e` in Chromium and WebKit iPad landscape, iPad portrait and iPhone projects; Chromium may run in parallel, while each complete WebKit profile runs sequentially without retry
- [ ] `npm run test:e2e:bridge` across all six production-bridge profiles
- [ ] `npm run screenshots`
- [ ] `npm run screenshots:check`
- [ ] `npm run audit:release`
- [ ] `npm run context-room:doctor`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `npm run doctor`
- [ ] Optional `npm run test:integration`, with disposable thread confirmed deleted
- [ ] Release inputs contain no credentials, personal paths, private thread content, extracted proprietary assets or generated OpenAI protocol source

## Verdict

Choose one and explain the limiting evidence:

- [ ] **Target product hardware-validated** — current checks and every target-only composer/Site requirement passed for the recorded matrix.
- [ ] **Current implementation hardware-validated** — all implemented current checks passed; target-only capabilities remain explicitly unavailable.
- [ ] **Local automated only** — code/browser gates passed but the live Desktop/Tailscale/iPad/Pencil matrix is incomplete.
- [ ] **Blocked** — an exact installation or security invariant failed.

```text
Verdict notes (31 July 2026):
Local automated only. Default doctor and setup are Ready with limitations rather
than blocked by installation prerequisites, and strict-native
remains nonzero because the managed socket, exact schema attestation, Desktop
ownership and Micro are unavailable. The restarted bridge now serves the exact
immutable PWA build and passed live-origin protocol and WebKit PWA simulations.
The physical Mac/iPad/iPhone/Pencil matrix is incomplete. Do not create v0.1.0.
```
