# Troubleshooting

> **Current implementation:** this guide diagnoses the current unified Nerva Home and `Home → Session` PWA, Mac bridge, Product State, Saved Drawings and capability-gated transports. Priority and status filters are temporary views of the same Home cards, not separate pages or layouts. Drawing/Photo uses a bounded exact native-composer attachment primitive that never submits the message; Review remains app-server-backed. Live Site navigation has a bounded implementation but still requires physical Mac/iPad proof. The completion target remains in [`product/FEATURES_target.md`](product/FEATURES_target.md).

Start with:

```bash
npm run setup:check
npm run doctor
```

`setup:check` and default doctor both answer whether Nerva is Ready, Ready with limitations, or Blocked. Default doctor returns success for either usable Ready state. Maintainers can require every principal native capability with `npm run doctor -- --strict-native`; that stricter command remains nonzero for a limited topology.

Then open **Settings → System Diagnostics**. Record the exact layer state, last proof, bridge/Codex/protocol versions and schema status. `Copy summary` is designed to be shareable: it omits prompts, outputs, titles, local paths, credentials and complete thread identifiers. A green browser notification row does not make a red native-control or Site row usable.

Doctor should report versions, listener ownership, structural compatibility, and redacted error categories. It should not print thread titles, prompts, source code, drawings, credentials, pairing codes, full thread IDs, or private local paths beyond known installation/configuration locations.

Do not bypass a degraded state until the uncertain layer is understood. A degraded health badge does not by itself mean every command is unavailable: exact-target commands remain enabled only when the live snapshot advertises that specific command and the selected slot/thread identities match. Offline/cached snapshots remain display-only.

## System Diagnostics reports missing or invalid schemas

Run the normal idempotent setup again:

```bash
npm run setup:mac
```

It attempts to regenerate the installed-version schema cache before installing/restarting the bridge. If the installed Codex version cannot generate compatible schemas, setup continues with limited Codex controls and pairing remains available. For diagnosis without changing the service, use `npm run setup -- --generate-schemas`, then `npm run doctor`. Do not copy a cache from another Codex version or weaken its manifest/hash checks.

## A Nerva update is available

The service worker activates complete caches atomically but does not silently reload the open document. Use the update banner once you are outside Drawing, Review and Site Review. Reload is intentionally disabled on those workspaces to avoid discarding unsaved local state. Pairing credentials and drafts are stored separately and do not require a new QR after a normal update.

If the banner never clears, fully close and reopen the installed app only after preserving the current drawing/review. Re-pairing is not an update mechanism.

## Background alerts are unavailable or do not arrive

Open Nerva from its Home Screen icon. An ordinary Safari tab cannot request the iOS/iPadOS Web Push permission used here. In **Settings → Notifications**:

- `Enable from one explicit touch…` means tap **Enable** and accept the iPadOS prompt;
- `Blocked in iPadOS Settings` means re-enable notifications for Nerva in iPadOS Settings, then return and tap **Enable** again;
- `Permission granted. Finish the private Mac subscription.` means the browser permission exists but the paired bridge does not have this device's subscription. Keep the Mac connected and tap **Enable** again;
- `Active—even when Nerva is fully suspended.` means both the browser and the authenticated Mac record agree.

If the row is active but nothing arrives, first trigger a supported new transition: approval, blocking question, error or completion of a pinned task. Initial bridge observation, an unchanged state, a stale/offline snapshot, an unpinned completion and a task outside the authoritative native six intentionally send nothing. Aggregate bridge health may read `degraded` while an unrelated control layer is unavailable; alerts still use a native slot proof refreshed within five seconds and never gain mutation authority. Multiple pinned completions may become one Home Priority alert after an eight-second grouping window.

Check iPadOS notification and Focus settings, then inspect the bridge log for a structural `Web Push delivery failed` warning. The bridge needs outbound HTTPS to the vendor endpoint registered by the browser, normally `*.push.apple.com` on iPadOS. It automatically removes a subscription after Push service `404` or `410`; tapping **Enable** recreates it without a new QR. Do not copy endpoints, keys or VAPID files between devices.

A notification intentionally has generic copy and no approval buttons. Tapping it opens the exact Session or Home's priority focus; approval still happens inside the authenticated live app context.

## Home has no live sessions

**Likely cause:** Codex Desktop is not running with a loopback CDP endpoint, the main renderer was not found, the selected native-slot signal is unavailable, or a Codex update changed the Micro module structure.

Check:

```bash
npm run doctor
pgrep -lf '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
```

If CDP is absent, follow the explicit relaunch procedure in [Mac setup](SETUP_MAC.md). Save work, wait for turns, quit the app fully, and launch with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=0`. Never expose a debugging port on `0.0.0.0`, a LAN IP, or a Tailscale IP.

If module discovery fails after a Codex update, capture a redacted doctor report and compare the installed version with [Compatibility](COMPATIBILITY.md). Do not hardcode a new asset hash or weaken structural checks as a quick fix.

## Session cards appear but controls are disabled

The UI may be showing the last valid snapshot while the WebSocket is reconnecting, the snapshot is cached/offline, or the selected session is not the one exact native slot currently selected on the Mac. Re-establish an authenticated live socket snapshot and verify the exact thread identity. A fresh `degraded` snapshot can still advertise safe exact-target commands; the web mutation gate must not translate that state into a false `Reconnect to the Mac` message. For native Micro actions, the session must still occupy the expected native slot and its current keycap/action identity must match. A displayed title is never enough to authorize a mutation.

## Opening a session reports managed app-server reconnect backoff

Current builds keep the last successful validated session catalog in bridge memory. Opening a session already present in that catalog, or in the current authoritative native snapshot, is a navigation-only deep link and must not synchronously re-list the managed app-server. A temporary reconnect backoff therefore does not block that known target; unknown identifiers still fail closed through one live catalog check.

If `Command not accepted, managed app-server reconnect is backing off after a failed attempt` still appears for a session visibly loaded from the current bridge, update and restart the bridge before re-pairing. Re-pairing does not repair the app-server transport. A definitive failed iPad open also clears its local origin marker, so subsequent Mac task changes must continue to update the iPad while Follow Mac is enabled.

## A Home status filter is empty or stale

The priority and status buttons reuse the same authenticated `/api/sessions` catalog as manual Home and `Unpinned Sessions`; there is no separate Mission Control endpoint or subagent projection. An idle unpinned session intentionally appears only in `Unpinned Sessions`, while an unpinned approval, error, working, waiting or completed session can appear in the matching filter.

After the managed app-server reconnects, return Nerva to the foreground to trigger the normal bounded catalog refresh. During a transient failure, last-good rules may keep previously validated sessions as display-only `degraded` cards. Nerva never creates placeholder agents for unknown IDs and does not display internal subagents as separate cards.

If a visible filtered card does not open, diagnose it exactly like a manual Home card: the bridge performs the same navigation-only `codex://threads/<uuid>` deep-link and no task is submitted, stopped or steered. While a filter is active, Mac task changes do not replace that Home focus; normal Follow Mac behavior resumes after entering a Session or returning to the unfiltered manual layout.

## Managed app-server control socket is missing

On the 26 July 2026 reference machine, the socket is present and the different Desktop `0.146.0-alpha.3.1` / daemon `0.145.0` versions pass Nerva's schema and live read-only compatibility probe. Doctor reports **Ready with limitations** because Desktop ownership on that exact socket is not attested. Three independent stdio writers are listed for diagnosis but do not block an unrelated socket. Hand-written attestations and killing unknown writers are not accepted workarounds.

Expected path:

```text
~/.codex/app-server-control/app-server-control.sock
```

Check with the Desktop-bundled binary:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server daemon version
ls -l "$HOME/.codex/app-server-control/app-server-control.sock"
```

Run OpenAI's official installer for normal updates, then run `npm run setup:check`. A version mismatch is informational when the fingerprinted schema/live probe passes. `setup:mac` skips bootstrap for an already running compatible daemon and never kills a writer. A missing or incompatible socket disables only the affected app-server capabilities; Drawing/Photo and native controls retain their separate gates. The socket speaks WebSocket over Unix domain sockets: raw JSONL, a raw `app-server --listen` replacement, or treating `app-server proxy` as a JSONL endpoint will fail.

Do not use `~/.codex/ipc/ipc.sock` as an app-server control socket. It is a different Desktop IPC transport.

## Codex usage is unavailable or marked last known

The Home card reads account limits through the same private managed app-server as Skills and Model + Reasoning. It displays the percentage remaining for each confirmed window. `Usage unavailable` means no confirmed reading exists in the current bridge process. `Last known usage` means a previous reading succeeded but the latest refresh failed; its percentages are not live until the label disappears.

Run `npm run doctor` and resolve the managed control-socket or competing-writer problem it reports. Re-pairing the iPad does not repair account usage. The PWA retries on foreground resume, every minute while visible and online, and when **Refresh Codex usage** is tapped. Never interpret an unavailable card as `100% remaining`.

## Desktop ownership attestation is missing or stale

A private socket answering is not mutation authority. Run `npm run doctor`. If doctor has positive current co-presence evidence, including the signed/notarized OpenAI Desktop app and an exact reciprocal Desktop peer on the current listener generation, it prints the explicit `npm run setup -- --attest-desktop-ownership` next action. If it does not, resolve the socket owner, Desktop process/peer or replaced generation; unrelated stdio writers alone are not the deciding factor. Never hand-write the attestation.

The attestation becomes stale after any bound socket, listener generation, peer, process or binary identity changes. Runtime rejects a third socket peer. A previously valid record can renew automatically after an update only when the OpenAI bundle ID, Team ID, Developer ID, notarized assessment and allowed paths are unchanged, the protocol probe passes, and two immediate topology observations match. Missing, unsafe or invalid records require explicit setup and are never auto-created.

## Another app-server process is running

List candidate writers:

```bash
pgrep -lf 'codex.*app-server'
```

Determine which application or service owns each process before making a change. Do not kill an unfamiliar process or attach a test server to a live thread. An independent stdio writer is diagnostic only; a third peer on Nerva's exact managed socket is the authority-blocking condition.

## A private state-file lock timed out

Nerva automatically reclaims a crash-stale `<state-file>.lock` only when the lock is a private regular file with valid ownership metadata, both its recorded and filesystem ages are at least 30 seconds, and its recorded PID is dead or now has a different process-start identity. Reclaim ownership uses a private `0700` `.lock.reclaim-<targetToken>/` directory with a mode-`0600` `owner.json`. A valid claim whose owner crashed and whose metadata is at least 30 seconds old is quarantined automatically as `.stale-<claimToken>` before recovery; that tombstone is non-authoritative and may remain without blocking later locks.

A live owner, a young lock/claim, unavailable ownership proof, malformed metadata, insecure permissions, or a symlink remains fail-closed. Malformed or insecure metadata is never deleted automatically. First stop every Nerva bridge, use the exact path and PID named by the error, and verify with `pgrep -lf`/`ps` that no owner remains. Start the bridge again and allow valid stale lock/claim recovery to run; do not manually remove a valid stale claim that can recover itself.

As a last resort only for a malformed or insecure object that cannot be recovered automatically, preserve a backup and move aside the **exact** `.lock` file or `.lock.reclaim-<targetToken>/` directory named by the error. Do not use a wildcard, remove the Application Support directory, or delete `.stale-*` tombstones. If ownership is still ambiguous, leave every object in place and report the redacted structural error.

## Desktop and bridge disagree after an update

1. Record the Desktop, daemon and `userAgent` values from `npm run doctor -- --json`.
2. Run `npm run setup:check`; the updated fingerprints automatically invalidate an older compatibility cache.
3. Run `npm run setup:mac` to refresh both private schema caches and the bridge without restarting Desktop.
4. Run `npm run doctor`; inspect only the capabilities now marked unavailable.
5. Use `npm run doctor -- --strict-native` for the full maintainer gate.
6. Restart Desktop only when a separate documented CDP/daemon step truly requires it, after saving active work.
7. Run the opt-in isolated integration test only if creating a disposable thread is acceptable.

Avoid automatic restart loops. A single failed recovery should become a clear degraded state with bounded backoff.

## `thread/resume` or Review send is rejected

Common safe failures include:

- target UUID is no longer present in the expected slot;
- snapshot is stale;
- managed transport is detached;
- thread is active and image steering is not proven;
- the managed socket generation or final exact-target authority changed;
- installed app-server schemas differ from the bridge's narrow projection;
- the idempotency record already contains a different payload for that `commandId`.

Refresh the snapshot, confirm the destination suffix, and retry only with the same `commandId` for the same payload. Never change the target while reusing an ID.

## Agent is busy during Review send

Busy is not an error to work around. Nerva may steer only when it knows the exact active turn ID and the installed protocol has passed the image-input steering probe. Otherwise production returns immediate typed `AGENT_BUSY`, keeps the draft, and releases the request/media admission path.

There is no hidden wait, delayed delivery, or offline replay. Wait for the active turn to complete, review the exact destination again, and initiate a new explicit send. A busy result must never open a parallel session, fork silently, or auto-post when the agent becomes idle.

## Skills, Model + Reasoning, or Fast is unavailable

- Skills prefers the exact selected thread cwd. If app-server cannot read that selected task yet, Nerva shows the global user/system skill catalog and never inherits another task's cwd-scoped catalog.
- Model + Reasoning requires a non-empty live `model/list` catalog and one exact selected native target. Settings presets that are absent from the current catalog are intentionally hidden.
- Fast is not an app-server setting. It requires the exact current native `ACT06` / `FAST` binding and immediate live revalidation.

Refresh the exact session after app-server or Desktop restarts. Do not create placeholder skills/models or guess a native slot from the title.

If every control is unavailable only on one older task while opening that task still works, inspect the native identities rather than its title. Current builds safely reconcile the known Desktop migration tuple where the selected Micro slot and current sidebar share the same strict `local:client-new-thread:<uuid>` key while the visible composer exposes the canonical task UUID. Native dispatch verifies the same tuple again; composer attachment performs an immediate exact snapshot refresh followed by a renderer-side sidebar/composer check. Any other mismatch remains blocked; renaming the task, matching by title or weakening the exact-target gate is not a repair.

Current builds refresh derived capabilities after every accepted sequenced native snapshot and every two seconds while the paired PWA is foregrounded and online. Drawing/Photo attachment follows the native composer capability; Skills and Model + Reasoning follow the managed app-server. If any first appears unavailable while its layer is reconnecting, leave the exact Session visible briefly: it should populate without a native session change as soon as the required live capability returns. Re-pairing is neither required nor a repair for this state.

If one Model + Reasoning drag appears to do nothing but the same drag works on the second attempt, first update and reopen the installed PWA. Current builds commit the final range value both at pointer completion and through a short Safari fallback because iPadOS may deliver its last `input` after `pointerup`. A definitive bridge rejection restores the last observed preset and shows the command error; it is not reported as success.

If Model + Reasoning or Skills alternates between available and unavailable every one or two seconds on a long task, inspect the bridge build before changing any preset. Current code reads only thread metadata, then at most one turn without its items; it must not request the complete rollout history during capability refresh. The older full-history read could exceed the private WebSocket frame bound and force a reconnect loop. Update and restart the bridge, then confirm several consecutive capability refreshes stay populated; re-pairing does not fix this transport loop.

Settings never accepts a manually typed model identifier. Its model menu comes directly from the current live `model/list` response, and its Reasoning menu is limited to the efforts advertised for the selected model. If the menu is empty, diagnose the managed app-server connection rather than guessing an identifier.

Configured presets are a strict allowlist. If only Sol presets were selected, Luna or another catalog model must never appear merely because one Sol preset is temporarily unavailable. Seeing the full catalog is expected only when Settings contains zero presets. If saved presets disappear after a reconnect, inspect Product State writes: current clients keep separate persistent dirty scopes for Home layout and preferences. After a stale-revision refresh, a layout-only save must retain the refreshed Mac presets, while a preferences-only save must retain the refreshed Mac layout.

On the first run of the corrected client, a locally retained non-empty preset list is offered once when the Mac list is empty. If the old client already replaced that local list too, there is no truthful source from which to reconstruct the chosen presets; select them again after the live catalog becomes available.

## Sketch upload is rejected

The bridge accepts a bounded PNG payload, verifies its signature, checks decoded dimensions and pixel count, and normalizes it before attaching it to the exact native composer. Re-export from the studio if you see:

- unsupported or mismatched file type;
- body too large;
- decoded dimensions or pixel count too large;
- malformed PNG;
- empty/meaningless bounds;
- normalization timeout.

The browser never supplies a local path. A Drawing send contains only validated PNG images, a bounded tiling manifest and no instruction text. The composer receives one in-memory Nerva atlas or one attested ordered batch; no `turn/start`, submit action or temporary local path is sent to Codex Desktop. Do not disable image checks or add a hidden text fallback to accept a problematic file.

## Resting a palm interrupts Pencil drawing

Confirm `Pencil only` is enabled. In the current input policy, only Apple Pencil can create marks; one finger or a palm is passive, and pan/zoom begins only after two deliberate touch pointers are present. Lifting either finger ends navigation. A WebKit `pointercancel` preserves the Pencil samples already visible instead of deleting the stroke.

If one touch still moves the canvas or a cancelled Pencil stroke disappears, the installed PWA is serving an older Drawing chunk. Fully close Nerva from the iPad app switcher and reopen it so the service worker activates the latest bundle; re-pairing is not required. Physical palm rejection still depends partly on iPadOS hardware classification, so record the iPad/iPadOS/Pencil versions if the updated build continues to cancel strokes repeatedly.

## Send timed out

Keep the draft. Reconcile and retry the exact payload with the same `commandId`; the durable ledger coalesces an in-flight command or returns the stored result across bridge restarts. A post-write timeout is reported as retryable `DELIVERY_UNKNOWN` and the same ID remains pending without executing again. Generate a new ID only for an intentional new send after confirming the earlier effect independently.

After a PWA reload, the generic pending list contains only bounded command UUIDs. A drawing may additionally retain its immutable slot/thread binding, expected snapshot sequence, and SHA-256 instruction/scene identities—never the instruction, scene JSON, PNG/base64, or a replay payload. Recovery performs `GET` reconciliation first. An explicit retry may re-render the still-matching IndexedDB draft with the same ID; a missing or mismatched binding remains blocked instead of minting another ID or auto-posting.

If acknowledgement status is unknown, refresh command state before doing anything else. Do not assume a timeout means the attachment was absent: it may already be visible in the Mac composer, but no message was submitted by this path.

## The durable command ledger is full or remains unresolved

The production/default ledger holds at most 16,384 records. Completed and failed exact-once outcomes remain protected for seven full days and expire only afterward; they are never pressure-evicted early. In-flight and unresolved records never expire. Saturation therefore rejects new commands explicitly instead of weakening prior authority.

Uncertain `DELIVERY_UNKNOWN` records are intentionally never auto-pruned: the bridge cannot know whether Codex accepted a write before the acknowledgement was lost. Stop the bridge before administrative recovery. The CLI acquires the same exclusive data-root lifetime lease as the server and refuses with `BRIDGE_ALREADY_RUNNING` while a live bridge owns it; it never edits the ledger concurrently. Then list only the unresolved metadata:

```bash
npm run codex-pad -- command-ledger list-unresolved
```

The list exposes creator-device audit ID, command ID, and timestamps only, not prompts, media, or the original payload. The creator ID is required as an exact administrative selector but does not namespace runtime command authority: a command ID remains global after revocation or re-pairing. Independently inspect the exact Codex task and other available evidence before changing anything.

Only when you explicitly accept that the prior command may already have executed, forget one exact unresolved record with:

```bash
npm run codex-pad -- command-ledger forget \
  --device 11111111-1111-4111-8111-111111111111 \
  --command 22222222-2222-4222-8222-222222222222 \
  --acknowledge-delivery-unknown
```

Replace both synthetic UUIDs with the exact IDs from the list. Forgetting performs one locked exact read-modify-write and removes only that record; a later retry can execute again and create a duplicate if the original write succeeded. Never script a bulk purge, edit `commands.json`, or delete uncertain records merely to free capacity.

## Pairing code expired or was rejected

Pairing codes are intentionally short-lived and single-use. Generate a new code on the Mac and scan it once. Repeated failures can trigger a rate limit; wait for the reported window rather than rapidly generating codes.

Verify that Safari is using the exact HTTPS MagicDNS origin stored in the pairing record. A raw IP, HTTP URL, different hostname, embedded browser, or stale QR fails the Origin binding. A successful exchange must return one well-formed bearer for the exact-origin auth IndexedDB; it must not set a credential cookie.

## Paired device loops on reconnect

The bearer may have been revoked, private IndexedDB may be unavailable, or the WebSocket ticket may be expired, reused, or bound to another Origin. A `401` for the currently used bearer should clear that exact value from memory and IndexedDB, then show pairing; a late `401` from an older request must not clear a newer pairing. If needed, clear this origin's website data, revoke the device on the Mac, and pair again rather than copying a credential between contexts. Revocation should close existing sockets and invalidate unused tickets; if an old socket remains able to mutate, stop the bridge and report a security issue.

When an already paired PWA returns from the background, authenticated snapshot refresh attempts to recover the managed Mac transport before returning the latest state. A stale card may remain visible for orientation, but Send, Skills and model mutations stay unavailable until the bridge confirms the live capability again. Do not re-pair merely to repair an idle app-server connection.

## Tailscale command is missing

The owner's current Mac/iPad path has Tailscale installed and paired. If the shell still cannot resolve the CLI—or on another installation—verify the official client and authentication before configuring Serve:

```bash
CODEX_PAD_TAILSCALE_BIN="$(command -v tailscale 2>/dev/null || true)"
if [ ! -x "$CODEX_PAD_TAILSCALE_BIN" ]; then
  CODEX_PAD_TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" version
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" status --json
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" serve --help
```

The Standalone app can install the shell launcher from **Settings → CLI integration**. The App Store build uses the bundled path above. If neither resolved path is executable, repair the supported installation; do not download an unrelated binary merely to silence the check.

Configure the background Serve route first and copy its exact MagicDNS origin:

```bash
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" serve --bg --https=443 http://127.0.0.1:8787
```

Rotate pairing for that exact origin, then start the foreground bridge in a second terminal as described in [Mac setup](SETUP_MAC.md). Do not use Funnel. Do not change the bridge to listen on a tailnet or LAN address.

## HTTPS works but live updates do not

iPadOS may suspend WebSockets, and an intermediate configuration can block upgrades. The PWA should fall back to a full snapshot and polling, then reconnect on `visibilitychange`, `pageshow`, and `online`.

Run `npm run doctor` and inspect `tailscale-serve`, `tailscale-funnel`, and `tailscale-wss` separately. Doctor must obtain authoritative read-only `tailscale funnel status --json` evidence that Funnel is disabled for the exact bridge route. If that command is unavailable, fails, is ambiguous/unparseable, or reports the route enabled through Funnel, `tailscale-funnel` and the production-ingress result are red; do not infer privacy from a working HTTPS or WSS route.

`tailscale-wss` remains a factual handshake check: it becomes green only after a real same-origin protocol switch reaches `/ws` and the bridge closes the credential-free probe with `4401` before sending data. `tailscale-serve` cannot become green unless its exact loopback declaration, the WSS probe, and the `tailscale-funnel` negative gate all pass. An HTTP status, timeout, network failure, origin mismatch, unhealthy local bridge, or missing exact MagicDNS origin remains warning/degraded; fix that prerequisite instead of treating parsed Serve output as private-ingress proof.

For the authenticated PWA path, confirm `POST /api/ws-ticket` succeeds with the device bearer, then the socket presents both `codex-pad.v1` and the returned ticket protocol. A ticket expires after 30 seconds, is consumed once, is bound to the exact Origin, and must never be retried or persisted; reconnect obtains a new one.

Confirm:

- the browser origin exactly matches the allowed MagicDNS origin;
- Tailscale Serve points to the loopback bridge on port `8787`;
- snapshot HTTP requests succeed while the socket is down;
- `bridgeInstanceId` stays stable while the same bridge process runs and changes after a bridge restart;
- sequence numbers advance after a native state change within one bridge instance;
- the UI does not remain `Connected` on an old `(bridgeInstanceId, sequence)` tuple.

## Draft did not restore

Draft keys are scoped to the exact target thread. Confirm you reopened Draw for the same destination suffix. Check Safari site storage and private-browsing restrictions. Removing the PWA or clearing Safari website data can remove IndexedDB drafts.

Do not use service-worker cache as a draft store; it is only for the application shell.

## Pencil pressure is flat or strokes have gaps

Confirm the event reports `pointerType: "pen"` and that Pencil-only mode is enabled when testing palm rejection. Pressure may be unavailable in synthetic browser tests or with non-Pencil input; the drawing engine should use a stable fallback width. Missing `getCoalescedEvents()` must degrade to the primary pointer event without dropping the stroke.

If the mark is visible but **Send** stays grey, confirm the scene commits when iPadOS emits `lostpointercapture`. Current builds finish the active interaction on that event; an older build could leave only a transient preview while the persisted scene remained empty. Force-close and reopen the installed PWA after updating so its production service worker loads the current bundle. If **Send** instead says to reconnect, the scene exists but the live Mac image-delivery capability is unavailable. Current builds re-read that capability after each sequenced snapshot and enable the existing canvas automatically when the bridge recovers; do not redraw or re-pair.

Test fast and slow strokes on physical hardware and record iPad, Pencil, iPadOS, and Safari versions in the manual checklist.

## A Site is missing or unavailable

`Sites` always opens one unified list containing only the current Session's proven HTTP(S) pages from Codex Browser on the Mac. It does not read Safari, Chrome or another browser profile, does not merge the legacy registered-site catalog, and never falls back to pages from another task. If a page is missing, tap **Refresh**. Identical URLs are valid separate pages; only an ambiguous webview-to-target proof remains unavailable.

If the task has no page, type an HTTP(S) address and tap **Open**. Nerva asks Codex to create a new Browser page for that exact task; it does not replace the current page or create an unmanaged CDP target. If Codex requires a site permission, approve it on the Mac and leave Sites open while the inventory refreshes.

After a Codex update, `This Codex build changed its Browser integration` means the private adapter no longer matches the observed structure. Nerva intentionally disables discovery and opening instead of guessing. Update Nerva or inspect **Settings → System Diagnostics**; re-pairing cannot repair an adapter mismatch.

Discovery requires one verified loopback Codex renderer and debugger sockets that resolve back to that same listener. When an exact Desktop process identity is available, the listener generation is re-attested around the inventory read. The PWA receives only an opaque tab ID, sanitized title and URL without credentials, query, fragment or debugger address.

Choosing a row is explicit user intent for the Session currently open on the iPad; there is no persistent linked/unlinked state. If the selected tab closes, the Desktop browser restarts or its target identity changes, the next frame/control fails instead of controlling a lookalike page. Reopen **Sites** and choose the current row again.

The live Site surface sends only typed tap, scroll, text, Enter/Backspace/Escape/Tab, Back, Forward and Reload operations. It never embeds the site in the PWA, fetches a pasted URL, exposes CDP/JavaScript or grants arbitrary browser control. A red app-server mutation gate can still disable final composer attachment even when browsing frames remain available.

If the loading label disappears but the page area becomes black, update and restart the bridge before re-pairing. Current builds downscale the Mac webview's physical Retina JPEG to the exact CSS-pixel viewport, display it as a native image and keep only a transparent 1× ink canvas above it. Safari no longer has to repaint the base page into a second full-size Retina canvas. Re-pairing does not change this rendering path; reopen the selected page from **Sites** after the bridge returns.

If Pencil does not start annotation, confirm the frame has loaded and use **Annotate** once. In `Pencil only`, a finger remains a browsing input; enable **Touch + Pencil** when no Pencil is available. The Site studio intentionally has no Filmstrip, Blank frame, Photo / Files or Camera. Those belong to the separate Drawing/Photo and Review-images workflows.

If **Send** is disabled, the page has either no committed stroke or the exact native composer-attachment capability is unavailable for the selected task. Reconnect/reselect that task, preserve the annotation, and retry only after the live capability returns. `Send` attaches one PNG and never submits the composer.

## Multi-frame send is disabled

A one-image Review does not require the private multi-image attestation. If one image is disabled, inspect the ordinary exact native target, managed control-socket connection, one-shot final-write authority, idle/start route, snapshot freshness, and image validation gates first.

A deck containing 2–12 images requires the standalone bounded multi-`localImage` attestation. Without it, Nerva keeps the complete deck local and disables confirmation/send; it must not drop frames, flatten the deck, split it into hidden commands, or partially send it. A deliberately separate one-image Review is a new reviewed command, not a retry of the retained multi-image deck.

If startup prints `multi-image attestation is invalid or stale`, regenerate the installed-version cache:

```bash
npm run setup -- --generate-schemas
```

Compare the printed installed Codex version and SHA-256 with the exact values used for the record. A Desktop update, changed binary path, changed schema bytes or file list, malformed/extra manifest field, insecure/symlinked record, or record identity mismatch fails closed. Do not hand-edit the manifest or `image-input-capability.json` and do not reuse a prior hash.

Only if creating/deleting a disposable app-server thread is acceptable, follow the exact opt-in command in [Mac setup](SETUP_MAC.md#optional-bounded-multi-image-attestation). Normal startup never reruns the probe. A successful probe still does not establish Desktop writer ownership, exact live delivery, or image steering. If the record validates but the connected app-server user agent differs, multi-image remains disabled.

Check the 32-megapixel per-frame import limit, 64-megapixel aggregate decode budget, 8 MiB normalized per-frame ceiling, 24 MiB atomic image-bundle ceiling, retained image order, and destination preview. Every retained image is included; delete an item to omit it. Preparation is sequential but atomic: a later conversion failure must preserve the deck and send no earlier frame.

## Native Dictate is unavailable or targets the wrong task

Session Dictation does not use the iPad microphone. It must not request browser permission, invoke `MediaRecorder`, create an audio draft or route a transcript. Production responses allow same-origin microphone access only for the separate explicit Site QA checkpoint voice note through `Permissions-Policy: microphone=(self)`. Capture Inbox has no Voice action.

Dictation is a native Codex Desktop hold control. Confirm the intended task is one of the authoritative six and explicitly selected, then rerun `npm run doctor`. Tap **Dictation** once to send the native press, then tap **Stop Dictation** to send its matching release. The control remains disabled when native discovery, snapshot freshness, exact task identity, or the observed Dictation keycap/action binding is unavailable. A changed binding must fail before the first native event; never substitute app-server text, another task, or a guessed keyboard shortcut.

If Codex Desktop reaches `0:00` and immediately stops after one tap, the PWA is still running the obsolete atomic press/release build. Force-close and reopen the installed app after the bridge/web update; the current UI must remain on **Stop Dictation** until the second tap. If the bridge restarts while dictation is held, stop it from the Mac. The new bridge intentionally forgets the prior gesture rather than replaying or guessing a release against a possibly changed task.

When the native action is proven but Codex Desktop receives no speech, select and test the intended microphone in macOS/Codex Desktop on the Mac. Recording and transcription happen there. If tapping Session Dictation or opening Capture Inbox asks for iPad microphone permission, stores browser audio, shows voice segments/transcripts or adds dictated text to a review payload, stop using that build and report a security regression. Only an explicit Site QA checkpoint voice-note action may request browser microphone permission.

## Capture Inbox local storage or Session use fails

Open Capture Inbox from Home and confirm Photo, Scan, Sketch, File and Note are available without the Mac. If Voice appears or microphone permission is requested, the PWA is stale; force-close/reopen it after updating the bridge. Capture Inbox never falls back to Session Dictation.

Photo, Scan, Sketch and File records are limited to 32 MiB each. The Inbox holds at most 200 items and 256 MiB of counted media. Remove old local originals manually if a limit is reached. Do not clear all site data unless removing the pairing credential, local Draw/Review drafts and the complete Capture Inbox is intended.

To use a capture, open the exact Session first, tap `Capture Inbox`, select compatible notes/images and tap `Use in session`. The local Review should open for that Session while every original remains in the Inbox. There is no routing or assignment state to repair. Reconnect never sends anything; Review still requires its own preview and confirmation. Non-image files currently have no verified Codex attachment transport and stay local.

## Moving a Home card changed native state

This is a correctness bug. Pinned membership and manual sections/cases are presentation metadata only; priority/status filters are read-only projections. Moving a card must not select, archive, fork, reprioritize, enqueue or change the status of a Codex thread. Disable layout mutations and report a minimal synthetic reproduction.

## `Unpinned Sessions` is empty or stale

Current Home always uses the authenticated bounded `/api/sessions` catalog; there is no `Include all Codex sessions` opt-in. Verify bridge authentication, the installed app-server list/read capability and current network state. A previous local snapshot may remain visible for orientation while remote actions are disabled.

`/api/native-sessions` is separate and contains at most the exact native six plus sanitized project/site enrichment. It cannot replace the full catalog and a catalog-only session never inherits native controls. Neither endpoint may fall back to Codex databases, rollout logs, titles or recent-window guesses.

## A pinned layout disappeared or another iPad changed it

Authenticated Home state comes from Mac-owned Product State. A write includes `expectedRevision`; a stale revision refreshes the Mac revision while a persistent local marker preserves and retries the unsynchronized iPad intent. Verify `GET /api/product-state`, the bridge log category and the private `product-state.json` permissions. Do not hand-edit, delete or relax the private-file checks.

When the Mac is unavailable, the app may use its last local Home layout for orientation. That fallback is not cross-iPad authority. Reconnect before expecting a new device to receive the latest layout.

If Product State contains an ID that exists in neither the Mac's private last-successful session catalog nor the current native sessions, current builds render no fake `Pinned session` card. They also do not delete that pin from a catalog omission because `/api/sessions` has no deletion tombstone. A known session omitted by a partial refresh remains visible with degraded status; only explicit `Unpin` removes membership. The cache cannot assert a current status, restore a site association or grant native-target mutation authority.

## `Keep in Saved Drawings` fails

Saved Drawings requires an authenticated online bridge. The request must contain a parseable bounded scene and a canonical PNG whose decoded dimensions match the declared canvas. Current limits are 8 MiB per PNG, 48 drawings and 128 MiB total PNG data. A full store fails explicitly; it never evicts an older drawing silently.

If list/get/delete fails, verify authentication, exact Origin and the private `saved-drawings` directory permissions. Do not delete the index or individual records manually. Use the confirmed Delete control so index and record stay consistent.

## Safe diagnostic bundle

When reporting a compatibility problem, include only:

- Nerva commit;
- macOS architecture/version;
- Codex Desktop and bundled Codex versions;
- Node, Safari, and iPadOS versions;
- doctor health categories and structural error codes;
- which validation command failed.

Remove thread IDs, titles, screenshots with private content, prompts, source code, paths outside known app locations, legacy cookies, pairing codes, bearers, WebSocket tickets, and drawing files.
