---
context_room:
  kind: canonical
  scope: product
  status: current
  canonical_for: observed state of the local implementation
  last_verified: 2026-09-07
  sources: [apps/web/src/App.tsx, apps/web/src/components, apps/web/src/styles, apps/bridge/src, packages/protocol, apps/web/e2e, playwright.config.ts]
---

# Nerva — current repository state

> Audit supplement, 14 September 2026: see [Production readiness](PRODUCTION_READINESS.md) for current installation blockers, UI/UX corrections and the candidate validation gates. Historical observations below are not a current production certificate.

> Observed on 7 September 2026. The accepted product target remains in [`FEATURES_target.md`](./FEATURES_target.md). This page separates implemented code, automated evidence, live-runtime evidence, and physical Mac/iPad evidence.

The public product name is **Nerva**. Visible UI, PWA metadata, and pairing copy use that name. Existing technical identifiers (`codex-pad`, `CodexPad`, IndexedDB names, LaunchAgent labels, directories, and commands) remain unchanged to preserve paired devices and stored state.

## Honest summary

The current build has one Home surface: `Home ↔ Capture Inbox` and `Home → Session → contextual surfaces`. Activity opens from the Conversations panel on Home and shows the complete cross-project catalog. It lifts two actionable states into Priority: In progress for live work, and Ready for review for completed-unread, approval, response, or error states. The exact reason remains in each row's activity text, while project names stay neutral text instead of consuming a color. Every remaining session then appears once in chronological Today, Yesterday, weekday, or dated groups. Manual sections, cases, and pinned cards remain the only durable organization. The former Automatic by Status and separate Mission Control page were replaced by one priority control and five temporary status filters on Home. They reuse the same validated cards and never modify the saved layout.

Capture Inbox is a Mac-independent local library. Each Session can open that library in the temporary context of its exact `threadId`; captures are never assigned to sessions. The historical Cockpit, Spatial, Command Deck, and Library surfaces and their legacy stylesheet are no longer part of the build.

Private Tailscale pairing has worked manually on the maintainer's Mac and iPad, including Home Screen installation and reopening with the persistent device credential. That observation is not a timed clean-install proof, an iPad-replacement proof, or a multi-version iPadOS matrix.

On 7 September 2026, doctor reports **Ready with limitations**. Codex Desktop `26.901.51231` build `8109` bundles `codex-cli 0.153.4`. Its exact fingerprinted protocol cache was regenerated and verified (416 schema files). During production preparation, the official managed daemon was bootstrapped and its separate fingerprinted cache of 416 schemas was generated. Its private socket now responds and the diagnostic exposes sessions, models, skills and usage. Desktop CDP and reciprocal Desktop ownership remain unavailable, so exact-task native controls and app-server mutations remain disabled. A responsive daemon does not establish Desktop mutation authority.

Tailscale is online. The configured private HTTPS route passed the live WSS upgrade check and closed the unauthenticated connection with code `4401`; Funnel remains disabled. The installed loopback bridge reports native Codex stale/offline; successful health responses establish reachability only at the time of the probe. Its pairing screen was also opened in the local browser. Those observations establish Mac-side reachability, not a paired physical phone/tablet or working native controls.

During the authorized production preparation, the missing managed daemon was bootstrapped, its schema cache was generated, and the GUI local-daemon opt-in was set for the next Desktop launch. Tailscale was brought back online after it stopped; its existing private Serve route was preserved. Independent stdio writers were not stopped, Desktop was not relaunched, and no task, paired-device credential or ownership attestation was changed. Reconnecting native controls still requires a coordinated Desktop relaunch and a fresh ownership/compatibility check. Physical acceptance remains open.

The repository is public pre-alpha at [`blancmathis/nerva`](https://github.com/blancmathis/nerva), with no tag, GitHub Release, npm publication, or deployment. Baseline commit `0a95911` passed GitHub Actions [run 30204589636](https://github.com/blancmathis/nerva/actions/runs/30204589636): 927 unit tests, 11 safety tests, build, 293 E2E tests with 13 explicit profile exclusions, a 387.70 kB largest JavaScript chunk, a 438 files release audit, Context Room doctor, and dependency audits. Setup and documentation commit `a2bd82a` then passed GitHub Actions [run 30211288284](https://github.com/blancmathis/nerva/actions/runs/30211288284) with the updated checks described below.

## Implemented surfaces

| Surface | Implemented now | Open proof or limit |
| --- | --- | --- |
| Pairing | 256-bit fragment secret; five-minute, one-use invitation; install-first Safari screen; no-code `Connect`; internal scanner fallback; exact-origin revocable credential; one-use WebSocket tickets; no separate native Mac app | Automatic Safari-to-PWA fragment handoff depends on iPadOS. The supported fallback is scanning the same valid QR inside Nerva. A clean under-two-minute run and replacement-iPad run are not yet recorded. |
| Mac setup | Read-only human/JSON preflight; `Ready`, `Ready with limited Codex controls`, and `Blocked`; two-binary schema/live compatibility probe; private Nerva state; exact Tailscale Serve route; bridge LaunchAgent; health-before-QR; pairing independent from native readiness | Both exact schema caches are current and the managed control socket responds. Desktop CDP, exact-socket Desktop ownership and native controls remain unverified. Default doctor is limited; the private HTTPS/WSS route is reachable from the Mac. Full native integration is not claimed. |
| Home | 0–12 user pins with no fake slots; last-good preservation during partial catalogs; Unpinned Sessions; Open current Mac session; compact Codex usage from real `account/rateLimits/read`; manual layout without Arrange; persistent `New section`; priority ordering and direct Approval/Error/Working/Waiting/Completed filters across pinned and unpinned sessions | Filters never modify pins, sections, cases, or order and never expose subagents, prompts, or output. Physical drag ergonomics still need finger/Pencil validation. |
| Activity | Conversations → Activity panel on Home; left sidebar in landscape and touch sheet in portrait/phone; Priority contains only In progress with an animated working ring and Ready for review with a fixed marker; approval, response, and error keep their exact reason in row metadata; the rest of the complete catalog follows in chronological day groups without duplication; exact Session selected only when a row is opened; exact thread opening | Activity uses only bounded session summaries and safe project labels. Project color is never inferred, historical rows are visually neutral, and reduced-motion devices receive a static working ring. It does not expose prompts, output, or subagents. Physical iPad sheet ergonomics remain to be confirmed. |
| Capture Inbox | Local Photo, Scan, Sketch, File, and Note library; bounded IndexedDB; search/filter; direct and multi-delete with confirmation; opened from an exact Session; notes/images copy into that session's local Review; 1–4 file-only items may attach to the exact Mac composer in one bounded native paste without submitting it | No Voice, destination, queue, reconnect send, automatic Mac sync, or mixed Review/file batch. Originals remain local after use or failure. Physical Camera/Pencil/background/storage-pressure and real generic-file attachment behavior are unproved. See [`CAPTURE_INBOX.md`](./CAPTURE_INBOX.md). |
| Session | Pin/Unpin; `Following Mac` and `Staying here`; immediate realignment; exact Open on Mac; return to saved iPad location; native Codex Voice start when the exact active task exposes `Start voice chat`; native Dictation; compact Send prompt that stops active dictation before submit; controlled absolute-final Skills suffix before that native submit; Capture Inbox entry; Fast; cwd-exact grouped Skills; live Model + Reasoning allowlisted presets; Approval/Error/Completed panels; Draw, Photo, Saved Drawings, and always-visible Sites | Voice uses the Mac microphone and speakers and never requests iPad microphone access. Nerva does not infer eligibility from task age: it fails closed unless the current Codex renderer exposes one enabled Voice control for the exact active task. There is no implicit session swipe. The native renderer may locally inspect the visible editor only to avoid duplicating the validated Skills suffix and confirm its paste; composer text never reaches the bridge/PWA and arbitrary text is never rewritten. Current model/effort is shown only when observed. An unknown dictation-stop result blocks automatic submit. All native actions fail closed when their exact binding is unavailable. |
| Draw/Photo | Bounded virtual world at ±1,000,000 units; independent camera; world grid; spatial index; differential history; contextual minimap; Fit board; Pencil-only and two-finger pan/pinch; unified Select for direct or lasso movement and uniform resizing of ink, shapes, text, photos and graph blocks; Camera/Photos/Files; definitive Clear; Whole board or Select area export; map-first coherence package with deterministic regions, 12% overlap, neighbors, alignment marks, structured graph index, and compatibility atlas; Sent checkpoints and Boards archive | `composerAttachmentMaxImages` is currently `1`, so the atlas fallback remains authoritative until exact-version multi-image attachment is attested. Pencil pressure, tilt, palm rejection, 60/120 Hz, dense twelve-tile export, and real Codex reconstruction remain physical gates. |
| Collaborative graphs | Multiple revisioned documents per exact task; graph geometry lives directly in the shared infinite board with no fixed diagram frame; new blocks appear at the current camera position; 256 nodes, 512 edges, 512 KiB; Codex/iPad provenance; expected-revision writes; structured and Pencil layers remain separate; v1 migration preserves `(720, 450)` center; exact-session listing; graph edits synchronize before image export | Graph documents are working interfaces, not proof that arbitrary agent semantics were understood. See [`../COLLABORATIVE_DIAGRAMS.md`](../COLLABORATIVE_DIAGRAMS.md). |
| Saved Drawings | Explicit Keep; private Mac store; thumbnail; source session; filter; global recovery; independent working copy; manual deletion | Real replacement-iPad restore has not been completed. |
| Image Review | Imports, filmstrip, annotations, compare, local diff, ordering, bounded manifest, exact atomic app-server send | Review creates an app-server turn; it is not a native composer attachment and does not claim delivery tracking. |
| Sites | Native exact-session list of Codex Browser HTTP(S) pages; duplicate URLs preserved; no linked/unlinked split; typed URL and global favorites open a new native page even from an empty task; target revalidation before each frame/action; bounded tap, scroll, text, keys, back/forward/reload; minimal Pencil/touch annotation; image-only Send to exact composer | The installed Codex Browser snapshot service and owner-route mapping have been observed live. Full page opening/control, cross-origin behavior, physical Pencil and attachment still need Mac/iPad proof. The PWA receives no raw debugger, CDP, JavaScript, selector or credential. |
| Site QA Recorder | Record flow; bridge-confirmed atomic receipts; resumable local draft; 10-minute/100-step/24-frame/64-MiB/20-draft limits; pause/resume/stop; bounded semantic targets and confidence; scrubbed URLs; password/OTP/payment/token/email/phone placeholders; issue checkpoint; expected/actual; reviewed text or bounded local voice note; flattened redactions; mandatory Review; Diagnose/Fix/Test; exact-session idempotent send | Audio stays local; only reviewed text is transmitted. There is no automatic replay, trace.zip, DOM/network/auth capture, or iPad test generation/execution. Guided Replay and a Mac recording store are not implemented. Physical proof remains open. |
| Reliability | Settings-only System Diagnostics; layer-specific proof; bridge/Codex/protocol versions; safe copyable summary; PWA update deferral during active studios; bounded initial snapshot wait; responsive private-link recovery with Mac/iPad Tailscale checks and in-place retry; static cached-shell connection fallback; structured transitions for Home attention/badge/allowed notifications; per-device Web Push and private VAPID sender | Browser automation is not hardware proof. Nerva can identify that the private route failed but cannot prove Tailscale is the exact cause until the Mac answers. Missing capabilities remain unavailable. Push event coverage currently comes from the six native Micro slots, not every extended-catalog task. |
| Settings | System/Light/Dark; density; motion; Web Push opt-in/preferences; model presets selected only from the live catalog; Saved Drawings; device list/revocation; read-only Context Room state; strict Nerva Cards | Push is limited to blocking questions, approvals, errors, important pinned completions, and grouped ready results. No lock-screen approval. Wake/Focus/badge behavior still needs physical iPad proof. |

## Presentation now implemented

The visual layer does not change protocol, exact-task routing, storage, synchronization, or send rules.

- Adaptive tokens define atmospheric background, opaque content, navigation/sheet glass, and material controls.
- Glass is limited to navigation, floating controls, drawers, and sheets; content cards and studios are opaque.
- Home uses spacious agent keys with blue Working, amber Approval, red Error, violet Waiting, green Completed, and silver Idle light.
- Home is three columns in iPad landscape, two in portrait, and one on phone; cards do not shrink as the count grows.
- The compact Home header keeps brand/title, Codex usage, Open current Mac session, and one Settings control in a coherent band. Diagnostics exist only at **Settings → System Diagnostics**.
- Capture Inbox has five material capture keys and a 3/2/1-column opaque grid. Its session context is temporary; no assignment picker exists.
- Session uses a compact console, four primary inputs, Send prompt, a progressive-disclosure Skills sheet, a continuous Model + Reasoning control, and separate Fast.
- Sites is a responsive full page with address/navigation, exact-session pages, favorites, live viewport, and Record flow. It never shows Drawing's filmstrip/import tools.
- Draw and Capture Inbox start with finger input on screens whose short edge is below 700 CSS pixels, including rotated phones; larger tablets default to Pencil-only. Existing drafts preserve the selected mode. Draw reserves most of the screen for the canvas. Select moves and resizes ordinary board content and graph blocks through the same interaction. Graph controls remain a compact floating capsule; the contextual inspector occupies extra space only after explicit editing.
- Settings is split on iPad and stacked on phone. Pairing has one primary action when an invitation is known.
- Home dock, priority/status filters, and usage refresh controls retain at least 44 CSS pixel touch targets, including compact phones. Safe areas, visible focus, reduced motion, reduced transparency, and System-default theming are supported.

## Persistence and replacement behavior

The bridge stores validated, atomic private Mac state for pins, sections, cases, placements, preferences, Model + Reasoning presets, and Site favorites. It also stores a bounded last-good session projection. A partial `thread/list` response never acts as a deletion: known omitted sessions remain degraded and non-authoritative until explicit `Unpin` or a real tombstone. No fake session is created for an unknown identity.

Product State writes use optimistic revisions and a persistent local outbox split between `homeLayout` and `preferences`. Failed, closed, or conflicting writes retain locally changed fields, merge untouched remote fields, and retry. A stale Home client cannot erase Settings presets and a stale Settings client cannot erase Home layout.

Saved Drawings are separately bounded to 48 items and 128 MiB, with an 8 MiB PNG limit. Collaborative graphs use another private store with 48 documents. Non-Keep Draw/Review drafts and Capture Inbox remain local to one iPad. Simultaneous two-iPad collaboration has no dedicated UX, but storage rejects blind corrupting writes.

## Pairing behavior

Generated QR codes use `/pair#pair=<nonce>`. The fragment is not sent in the HTTP request; Nerva submits it only in `POST /api/pair`. Invitations expire after five minutes, are single-use, exact-origin, and rate-limited. The permanent bearer never appears in the QR; only its hash is stored on the Mac.

`npm run setup:mac` installs and verifies the bridge before rotating the invitation. Safari presents Add to Home Screen without consuming it. The installed PWA uses the fragment when iPadOS transfers it or scans the same QR internally. One `Connect` tap creates the device credential; later openings reuse exact-origin IndexedDB and need no daily QR. `npm run pair` works after either a Ready or limited installation.

## Deliberately fail-closed

1. Composer text never crosses from the renderer into the bridge/PWA and arbitrary native composer text is never rewritten. When Skills are armed, the renderer may locally inspect the editor only to append the validated English Skills suffix once and confirm it before invoking the exact native submit binding. Draw/Photo remains image-only and never consumes Skills. Nerva does not infer Queue/Steer.
2. Image Review remains a separately gated app-server turn.
3. Model + Reasoning accepts only live-catalog combinations and the exact selected native task.
4. Site actions require an opaque, revalidated exact-task page identity; no title, similar URL, or foreground tab is authority.
5. Notifications come only from structured live transitions and contain no task content or lock-screen approval.
6. Haptics is unavailable when Safari exposes no vibration API; visual feedback is not presented as physical vibration.
7. Context Room is loopback/read-only and Nerva Cards use a closed schema with no arbitrary HTML, JavaScript, CSS, URLs, or handlers.
8. Home focus reuses validated Product Sessions and never exposes subagents, prompts, turns, or output.
9. Capture Inbox has no destination or send state and is never read by reconnect logic. Explicit file attachment is constructed only from the current file-only selection and is never stored or replayed.
10. Hardware behavior remains unproved until performed on hardware.

## Dated validation — 9 September 2026

The hardening candidate `78acef752daf6096aedb2d532219788fb73a896f` passed 1,110 unit tests (2 explicit integration skips), 19 probe-safety tests, types, coordinated build, bundle budget, all 6 production-bridge profiles, release/license audit and Context Room. Sharp is now 0.35.4 with libheif 1.23.2, and Vitest is 4.1.11; the dependency audit reports no known vulnerabilities. The foreground session catalog now uses the managed index as described in [Compatibility](../COMPATIBILITY.md).

The complete six-profile browser run had 412 passes, 24 profile exclusions and two WebKit startup timeouts. Both failure traces remained at `about:blank` with no network resources recorded; neither reached Nerva. Both exact failed scenarios subsequently passed three times each in fresh browser runs, without changing timeouts, retries or assertions. All 414 distinct scenarios have passing evidence across these runs; this is not a single clean full-matrix run, and the original startup cause remains unknown.

Reviewing the 43 generated reference captures then exposed a separate command-toast layout defect: its title and message ran together and its dismiss button collapsed on phones. A browser geometry regression reproduced the overlap before the correction. The toast now separates the text into two rows and uses the existing 48-pixel icon button. This final visual correction needs its focused six-profile validation and a matching installed build before inheriting the earlier runtime evidence.

The live Desktop process remains in use. Native CDP, shared ownership, actual task delivery, physical Pencil behavior, notifications and suspend/resume are still not accepted. The USB iPad preview works through QuickTime, but it does not forward taps. A loopback-only USB web inspector has no visible page while the iPad is at Home; remote app launching requires Developer Mode, which was left unchanged. Mac Safari was not used during this continuation.

## Dated validation — 7 September 2026

The audit preserved the existing working-tree changes and corrected these reproducible issues:

- Phone Home dock keys were 34 CSS pixels; they now retain a 44 CSS pixel target. Home filters and usage refresh also retain 44 CSS pixel targets.
- New Draw and Capture Inbox canvases use the screen's short edge to choose finger input on phones, including landscape. Saved drawings open with the appropriate initial mode and existing drafts preserve the user's choice.
- Home once again opens Capture Inbox directly, outside the three-key dock. The connection-recovery screen also opens the local Inbox when no Mac snapshot exists, without requiring a Session or transmitting a capture.
- The static boot fallback now applies its own border-box sizing, preventing horizontal overflow when the JavaScript/CSS bundle cannot load.
- Missing native Voice metadata now produces an unavailable Voice capability instead of aborting state refresh. The production-bridge fixture also supplies the current Voice contract.
- Activity grouping tests use their explicit clock, and boot-fallback assertions match the current recovery copy. Geometry checks wait for finite animations before measuring touch targets.
- Production preparation corrected the remaining Home/offline Inbox assertions and added offline note creation without Mac commands. Doctor now requires positive native CDP, fresh Micro slots, installed bridge and private HTTPS/WSS evidence before reporting Ready; a compatible owned daemon alone cannot pass the strict release gate.
- Fastify is `5.12.3`, fast-uri is `3.1.7` / `4.1.4`, and process-warning is `5.1.0`. The root development dependency makes Fastify types resolvable from hoisted plugin declarations; the bridge owns the runtime dependency. The generated license inventory contains 163 production dependency records.

The first installed candidate, `7eb28eda6c5d8af8448b59090a90a24a9b018a78`, passed TypeScript, 1,052 unit tests (2 explicit integration skips), 19/19 probe-safety tests, coordinated production build and the JavaScript bundle budget. Its largest chunk was 410.54 kB against the 500 kB raw budget. The dependency audit reported zero known vulnerabilities. The complete six-profile browser matrix passed 414 scenarios with 24 explicit profile exclusions on `2af31669a8b82ee23ad42a34e1ed867bb1dec3c7`; all browser inputs were byte-identical in the installed candidate. These results belong to that candidate and do not validate subsequent hardening changes. Additional focused checks covered 320×568, 360×640, 844×390, fresh drawing input, and retained input mode.

All six isolated production-bridge profiles passed after the Voice metadata correction, exercising pairing/authentication, WebSocket state, idempotency ledger, bridge restart, and device revocation. Screenshot validation generated 43 synthetic product captures; representative phone/tablet Home, Session, Activity, Capture Inbox, Draw and Sites views were visually inspected. The source-release audit passed with 466 input files and 163 license records. Documentation links and the Context Room graph also passed.

A separate concurrent diagnostic run produced four component-test wait timeouts and one WebKit accessibility timeout under load. The full unit suite and the affected accessibility flow then passed in isolation without changed timeouts, retries, or excluded assertions. The serial validation pipeline remains the reproducible entry point.

The read-only setup preflight has no base blockers and reports limited native controls. After authorized production preparation, both `0.153.4` schema caches are present and the shared control socket responds. Private HTTPS/WSS works from the Mac; Desktop CDP and Desktop ownership remain unavailable. No live native send, dictation, Voice call, approval, or image attachment was performed. The physical checklist below remains required.

## Production hardening follow-up — 7 September 2026

The follow-up audit reproduced and corrected these failures with focused regression tests:

- Image, image-batch and Voice native actions now reject contradictory sidebar/composer task identities. Temporary new-task keys need the exact canonical composer identity.
- Malformed, mismatched-command or mismatched-target acknowledgements preserve the original command ID for reconciliation; they cannot authorize an automatic resend.
- Device revocation is checked again after request-body admission and after the command ledger has waited on durable storage, before dispatch.
- A delayed drawing acknowledgement checkpoints its retained board instead of a newer active board. Late callbacks cannot close or lock another studio; the original delivery outcome is still persisted.
- Note and sketch capture dialogs lock edits and close actions during saving, retain content on failure and show the error inside the dialog. Capture-to-Review imports compare the expected draft atomically and report conflicts without replacing newer content. This is not a general multi-tab Review editor merge system.
- Legacy service removal validates its private owned plist before stopping it, checks the stop result and preserves a replaced file. An ownership-renewal probe or storage error returns an unverified diagnostic instead of aborting it.
- Doctor reports bounded HTTP timeout, connection, payload and listener failures separately. This improves diagnosis; it does not claim to solve the intermittent live bridge stall observed during this audit.

These focused red-to-green regressions supplement the earlier candidate evidence. A subsequent candidate still needs the coordinated build, complete validation log and matching installed bridge/web revision. The live Desktop process was preserved, so native ownership, CDP controls and physical acceptance remain pending. The GUI opt-in is session-scoped and ordinary Desktop reopening does not itself supply the CDP arguments; use the documented deliberate launch procedure after restarting the Mac.

## Historical automated validation — 8 August 2026

On 8 August, the working tree started from `67f939a` and contained one bounded dependency refresh: `brace-expansion` `5.0.9`, `fast-uri` `3.1.5` and `4.1.2`, and development-only `nanoid` `3.3.18`. The generated third-party inventory was refreshed from the lockfile. Local validation on that exact source state produced:

- 1,030 unit tests passed, with 2 explicit skips, plus 19/19 probe-safety tests;
- 343 E2E tests passed across Chromium and WebKit iPad landscape, iPad portrait, and phone profiles, with 17 explicit profile exclusions and no retry;
- all 6 isolated production-bridge profiles passed;
- TypeScript, coordinated production build, and bundle validation passed; the largest JavaScript chunk is 402.15 kB, below the 500 kB raw budget;
- screenshot generation and verification passed; 39 public screenshots were regenerated, and representative Home, Session, Capture Inbox, Draw, Sites, and Settings views were inspected across landscape, portrait, and phone layouts;
- release audit: 452 files and 163 production dependency records;
- documentation check: 37 Markdown files;
- Context Room doctor: 6 documents and 0 issues;
- production and complete dependency audits: zero vulnerabilities.

The current exact schema cache matches installed `codex-cli 0.147.0-alpha.6.5` with schema SHA-256 `66a12190b43b44dd937bb2f5ac032ba0c37c59d2b8b548435acd931ed1be4ea1`. Default doctor is `limited`: bridge health, loopback CDP, storage safety, Funnel state, and schema integrity are green; the managed daemon, Desktop ownership, native Micro adapter, Tailscale availability, private WSS route, and physical-device behavior are not. The dependency-corrected source is fully validated, but the already-running bridge loaded the previous production dependency graph and requires an explicitly authorized restart before the live process can claim those fixes. No hosted CI, deployment, or physical iPad/Pencil result is claimed for this working-tree refresh.

## Historical automated validation — 31 July 2026

At that checkpoint Codex Desktop bundled `codex-cli 0.146.0-alpha.9.2`. The complete hardening implementation was published on `main` as commit `bb45368`. GitHub Actions [run 30661070563](https://github.com/blancmathis/nerva/actions/runs/30661070563) passed both the required `Node.js 22` job and the read-only macOS setup job for that exact product commit. Local validation before publication produced:

- 1,030 unit tests passed, with 2 explicit skips;
- 19/19 probe-safety tests passed;
- 343 E2E tests passed across Chromium and WebKit iPad landscape, iPad portrait, and phone profiles, with 17 explicit profile exclusions and no retry;
- Chromium ran in parallel; each complete WebKit device profile ran sequentially after concurrent WebKit networking processes were proven to crash inside WebKit's IndexedDB shutdown path;
- the production bridge harness passed all 6 profiles for authentication, state, WebSocket, ledger, simulated restart, and revocation;
- the WebKit iPhone Site QA flow and the isolated production bridge path each passed 10 consecutive no-retry repetitions;
- TypeScript, build, and bundle validation passed; the largest JavaScript chunk is 402.15 kB, below the 500 kB raw budget;
- deterministic screenshot generation and screenshot verification passed; 39 current public screenshots were regenerated and representative Home, Session, Capture Inbox, Draw, Sites, Site QA, and Settings images were visually inspected;
- release audit: 463 files and 163 production dependencies;
- documentation check: 37 Markdown files;
- Context Room doctor: 6 documents and 0 issues;
- production and complete dependency audits: zero vulnerabilities;
- default doctor: `limited`, exit zero, with the live-runtime boundaries documented above.

The exact non-ignored source snapshot, including the immutable-web correction, was committed inside a temporary local validation repository and cloned into a clean checkout before publication. From that checkout, `npm ci`, Playwright Chromium/WebKit installation, the complete `npm run validate` gate, Context Room doctor, both dependency audits, `git diff --check`, and the final cleanliness check all passed. The clean checkout reproduced 1,030 unit passes plus 19/19 probe-safety passes, 343 E2E passes with the same 17 explicit profile exclusions, all 6 production-bridge profiles, the bundle budget, deterministic screenshot generation, a 452-file release audit with 163 production dependency records, 32 public Markdown files, and zero dependency vulnerabilities. GitHub then reproduced the documentation, type, unit, build, bundle, browser, production-bridge, screenshot, release, Context Room, dependency, and read-only macOS setup gates on `bb45368`. This remains automated and hosted-runner proof, not physical-device proof.

The full E2E run required two test-harness fixes without weakening product assertions: fixture builds use an isolated temporary distribution that cannot overwrite the production `apps/web/dist`, and complete WebKit profiles run sequentially to avoid the confirmed platform networking-process crash. There are no retries and no new capability simulation.

After the live LaunchAgent audit exposed an `ECONNREFUSED` crash, an exact stale-Unix-socket regression failed with the same unhandled stream error, then passed after the pre-reader stream error was handled. Bridge typecheck, the complete unit/safety suite, and a production build in an isolated source copy are green. At that checkpoint the LaunchAgent still used its previous artifact; it subsequently recovered through its existing launchd policy as recorded below.

The LaunchAgent later recovered through its existing launchd policy and passed local health. A follow-up live audit measured two identical `MANAGED_PROXY_EXITED` log lines per minute while the managed daemon remained unavailable. The transport now logs one identical connection diagnostic per failure streak and rearms only after a successful connection. After explicit authorization, only the Nerva bridge was restarted; the loaded generation now includes this correction and no repeated identical diagnostic was observed during the post-restart window.

After Tailscale returned online, an installed-bridge connection simulation proved one-use pairing, authenticated snapshot, ticketed WSS delivery and revocation without touching the existing active devices. A separate fresh WebKit-PWA simulation reproduced a `409` build mismatch caused by rebuilding mutable `apps/web/dist` beneath a running bridge. The bridge now copies the complete generated PWA into a private process-scoped snapshot, verifies `app-meta.json` against its exact compiled revision and API contract before listening, and never serves a later repository rebuild in that generation. One coordinated build command computes a single revision for Web and Bridge and rejects mismatched outputs. Fixture builds use temporary output and cannot poison production assets. The restarted LaunchAgent serves this corrected generation, and both raw protocol and live-origin WebKit PWA simulations pass.

That published hardening result had matching clean local clone proof. It was still not physical Mac/iPad/Pencil proof.

## Historical automated validation — 26 July 2026

Baseline public proof for commit `0a95911` and GitHub Actions run `30204589636`:

- 927 unit tests passed, with 2 explicit skips;
- 11/11 probe-safety tests passed;
- 293 E2E tests passed across Chromium and WebKit iPad landscape, iPad portrait, and phone profiles, with 13 explicit profile exclusions and no hidden retry;
- build, TypeScript, and release validation passed;
- largest JavaScript chunk: 387.70 kB, below the 500 kB raw budget;
- release audit: 438 files and 163 production dependencies;
- Context Room doctor passed;
- production audit reported zero vulnerabilities; the complete audit retained one transitive `low` development-only `esbuild` issue on Windows.

The E2E matrix covers pairing, Home 0/1/6/12 pins, priority/status focus, direct touch drag, Session, dictation, Send prompt, model allowlists, persistent state recovery, partial catalogs, Skills, infinite Draw, coherence packages for 1/2/6/12 images, Saved Drawings, Settings, offline behavior, Capture Inbox, Sites isolation/navigation/favorites/annotation, and Site QA Record → Issue → Review → exact send. Deterministic screenshots cover all public surfaces.

Compatibility and restoration-safety commit `dda917b` was validated from a fresh local clone after `npm ci` and Playwright browser installation: 941 unit tests passed with 2 explicit skips; 11/11 probe-safety tests passed; the full E2E matrix reported 293 passes and 13 explicit exclusions with no retry; build and the 387.70 kB bundle budget passed; screenshot generation passed; the release audit inspected 441 files and 163 production dependencies; Context Room reported zero health issues; and the production dependency audit reported zero vulnerabilities. GitHub Actions [run 30219005029](https://github.com/blancmathis/nerva/actions/runs/30219005029) independently passed the required `Node.js 22` job for the same commit. On the live reference Mac, default doctor reports Ready with limitations and exits zero; `--strict-native` exits nonzero because exact-socket Desktop ownership and the native Micro adapter remain unavailable. The protocol probe reports the mutation schemas compatible, while the effective doctor capability report and write sink both keep app-server mutations unavailable without ownership.

Automated browser proof does not establish physical Apple Pencil behavior, iPadOS suspension, Web Push wake, or a complete native Codex topology. No `v0.1.0` tag may be created while strict-native doctor or the hardware checklist is incomplete.

## Physical evidence still required

- time a clean QR-to-Connect run under two minutes and verify Home Screen reopening without another QR;
- repeat pairing while native controls are limited and confirm no command reaches an unverified writer;
- replace the iPad and verify global-state and Saved Drawings restoration;
- install and pair on a physical iPhone, then exercise every primary surface in portrait and landscape, including background/resume, rotation, offline/reconnect, safe areas and keyboard avoidance;
- prove Follow/Stay and bidirectional opening with the real Codex Desktop;
- test Capture Inbox with Camera, Photos, Files, backgrounding, Pencil, and reuse across sessions;
- prove native Mac-microphone Dictation and Send prompt Queue/Steer behavior;
- prove Draw/Photo attaches exactly the intended image(s) without submitting the composer;
- test Pencil pressure, tilt, palm rejection, 60/120 Hz, and two-finger navigation;
- prove exact-task Sites, cross-origin navigation, favorites, and Site QA delivery without secret leakage;
- test Mac sleep, Tailscale interruption, 1/10/60-minute suspension, and absence of duplicate actions;
- test Push while open, backgrounded, fully suspended, under Focus, with badge/deep links and no lock-screen approval.
