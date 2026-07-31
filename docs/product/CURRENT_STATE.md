---
context_room:
  kind: canonical
  scope: product
  status: current
  canonical_for: observed state of the local implementation
  last_verified: 2026-07-31
  sources: [apps/web/src/App.tsx, apps/web/src/components, apps/web/src/styles, apps/bridge/src, packages/protocol, apps/web/e2e, playwright.config.ts]
---

# Nerva — current repository state

> Observed on 31 July 2026. The accepted product target remains in [`FEATURES_target.md`](./FEATURES_target.md). This page separates implemented code, automated evidence, live-runtime evidence, and physical Mac/iPad evidence.

The public product name is **Nerva**. Visible UI, PWA metadata, and pairing copy use that name. Existing technical identifiers (`codex-pad`, `CodexPad`, IndexedDB names, LaunchAgent labels, directories, and commands) remain unchanged to preserve paired devices and stored state.

## Honest summary

The current build has one Home surface: `Home ↔ Capture Inbox` and `Home → Session → contextual surfaces`. Manual sections, cases, and pinned cards are the only durable organization. The former Automatic by Status and separate Mission Control page were replaced by one priority control and five temporary status filters on Home. They reuse the same validated cards and never modify the saved layout.

Capture Inbox is a Mac-independent local library. Each Session can open that library in the temporary context of its exact `threadId`; captures are never assigned to sessions. The historical Cockpit, Spatial, Command Deck, and Library surfaces and their legacy stylesheet are no longer part of the build.

Private Tailscale pairing has worked manually on the maintainer's Mac and iPad, including Home Screen installation and reopening with the persistent device credential. That observation is not a timed clean-install proof, an iPad-replacement proof, or a multi-version iPadOS matrix.

On 31 July 2026, default doctor reports **Ready with limitations** and returns success. Codex Desktop `26.727.40816` build `6067` bundles `codex-cli 0.146.0-alpha.9.2`. The managed app-server socket did not answer, no exact schema cache matches that installed CLI, and Desktop ownership on the exact socket is not attested. Nerva therefore exposes no app-server capability and keeps every corresponding mutation unavailable rather than reusing a stale compatibility result.

Three independent stdio app-server writers remain diagnostic warnings and were not stopped. Desktop CDP is reachable on loopback, but the native Micro adapter remains degraded and fail-closed. Tailscale is running; the Mac and previously paired iPad are online, the private HTTPS Serve route answers, and its unauthenticated WSS probe reaches the exact `/ws` endpoint and is rejected with the expected private-auth close. With explicit user authorization, only `com.codex-pad.bridge` was restarted after a coordinated production build. Its PID changed while the observed Codex app-server PID set remained unchanged. The new LaunchAgent generation answers on `127.0.0.1:8787`, serves its immutable process-scoped PWA snapshot, and has not repeated the identical `MANAGED_PROXY_EXITED` diagnostic during the observed post-restart window.

A temporary-device simulation against the restarted bridge completed one-use exact-origin pairing, authenticated snapshot read, build-bound WebSocket ticket issuance, authenticated WSS snapshot delivery, revocation, and post-revocation `401`; the pre-existing active device records were unchanged. A fresh headless WebKit iPad PWA then paired through the real private Tailscale origin, reached the online Session surface, received an authenticated ticket and revoked cleanly. The Mac-to-iPad Tailscale path remained direct and established across repeated samples. These live-origin checks prove the restarted bridge generation and WebKit protocol path, not the physical iPad UI, Pencil, microphone, camera, push delivery, or Codex native controls. No Codex process was restarted, no writer was killed, and no setup mutation was performed. `npm run doctor -- --strict-native` remains nonzero.

The repository is public pre-alpha at [`blancmathis/nerva`](https://github.com/blancmathis/nerva), with no tag, GitHub Release, npm publication, or deployment. Baseline commit `0a95911` passed GitHub Actions [run 30204589636](https://github.com/blancmathis/nerva/actions/runs/30204589636): 927 unit tests, 11 safety tests, build, 293 E2E tests with 13 explicit profile exclusions, a 387.70 kB largest JavaScript chunk, a 438 files release audit, Context Room doctor, and dependency audits. Setup and documentation commit `a2bd82a` then passed GitHub Actions [run 30211288284](https://github.com/blancmathis/nerva/actions/runs/30211288284) with the updated checks described below.

## Implemented surfaces

| Surface | Implemented now | Open proof or limit |
| --- | --- | --- |
| Pairing | 256-bit fragment secret; five-minute, one-use invitation; install-first Safari screen; no-code `Connect`; internal scanner fallback; exact-origin revocable credential; one-use WebSocket tickets; no separate native Mac app | Automatic Safari-to-PWA fragment handoff depends on iPadOS. The supported fallback is scanning the same valid QR inside Nerva. A clean under-two-minute run and replacement-iPad run are not yet recorded. |
| Mac setup | Read-only human/JSON preflight; `Ready`, `Ready with limited Codex controls`, and `Blocked`; two-binary schema/live compatibility probe; private Nerva state; exact Tailscale Serve route; bridge LaunchAgent; health-before-QR; pairing independent from native readiness | The current managed daemon is unavailable, no exact current schema attestation exists, and exact-socket Desktop ownership and Micro controls remain unverified. Default doctor is limited and exits zero; full native integration is not claimed. |
| Home | 0–12 user pins with no fake slots; last-good preservation during partial catalogs; Unpinned Sessions; Open current Mac session; compact Codex usage from real `account/rateLimits/read`; manual layout without Arrange; persistent `New section`; priority ordering and direct Approval/Error/Working/Waiting/Completed filters across pinned and unpinned sessions | Filters never modify pins, sections, cases, or order and never expose subagents, prompts, or output. Physical drag ergonomics still need finger/Pencil validation. |
| Capture Inbox | Local Photo, Scan, Sketch, File, and Note library; bounded IndexedDB; search/filter; direct and multi-delete with confirmation; opened from an exact Session; notes/images copy into that session's local Review; 1–4 file-only items may attach to the exact Mac composer in one bounded native paste without submitting it | No Voice, destination, queue, reconnect send, automatic Mac sync, or mixed Review/file batch. Originals remain local after use or failure. Physical Camera/Pencil/background/storage-pressure and real generic-file attachment behavior are unproved. See [`CAPTURE_INBOX.md`](./CAPTURE_INBOX.md). |
| Session | Pin/Unpin; `Following Mac` and `Staying here`; immediate realignment; exact Open on Mac; return to saved iPad location; native Dictation; compact Send prompt that stops active dictation before submit; controlled absolute-final Skills suffix before that native submit; Capture Inbox entry; Fast; cwd-exact grouped Skills; live Model + Reasoning allowlisted presets; Approval/Error/Completed panels; Draw, Photo, Saved Drawings, and always-visible Sites | There is no implicit session swipe. The native renderer may locally inspect the visible editor only to avoid duplicating the validated Skills suffix and confirm its paste; composer text never reaches the bridge/PWA and arbitrary text is never rewritten. Current model/effort is shown only when observed. An unknown dictation-stop result blocks automatic submit. All native actions fail closed when their exact binding is unavailable. |
| Draw/Photo | Bounded virtual world at ±1,000,000 units; independent camera; world grid; spatial index; differential history; contextual minimap; Fit board; Pencil-only and two-finger pan/pinch; unified Select for direct or lasso movement and uniform resizing of ink, shapes, text, photos and graph blocks; Camera/Photos/Files; definitive Clear; Whole board or Select area export; map-first coherence package with deterministic regions, 12% overlap, neighbors, alignment marks, structured graph index, and compatibility atlas; Sent checkpoints and Boards archive | `composerAttachmentMaxImages` is currently `1`, so the atlas fallback remains authoritative until exact-version multi-image attachment is attested. Pencil pressure, tilt, palm rejection, 60/120 Hz, dense twelve-tile export, and real Codex reconstruction remain physical gates. |
| Collaborative graphs | Multiple revisioned documents per exact task; graph geometry lives directly in the shared infinite board with no fixed diagram frame; new blocks appear at the current camera position; 256 nodes, 512 edges, 512 KiB; Codex/iPad provenance; expected-revision writes; structured and Pencil layers remain separate; v1 migration preserves `(720, 450)` center; exact-session listing; graph edits synchronize before image export | Graph documents are working interfaces, not proof that arbitrary agent semantics were understood. See [`../COLLABORATIVE_DIAGRAMS.md`](../COLLABORATIVE_DIAGRAMS.md). |
| Saved Drawings | Explicit Keep; private Mac store; thumbnail; source session; filter; global recovery; independent working copy; manual deletion | Real replacement-iPad restore has not been completed. |
| Image Review | Imports, filmstrip, annotations, compare, local diff, ordering, bounded manifest, exact atomic app-server send | Review creates an app-server turn; it is not a native composer attachment and does not claim delivery tracking. |
| Sites | Native exact-session list of Codex Browser HTTP(S) pages; duplicate URLs preserved; no linked/unlinked split; typed URL and global favorites open a new native page even from an empty task; target revalidation before each frame/action; bounded tap, scroll, text, keys, back/forward/reload; minimal Pencil/touch annotation; image-only Send to exact composer | The installed Codex Browser snapshot service and owner-route mapping have been observed live. Full page opening/control, cross-origin behavior, physical Pencil and attachment still need Mac/iPad proof. The PWA receives no raw debugger, CDP, JavaScript, selector or credential. |
| Site QA Recorder | Record flow; bridge-confirmed atomic receipts; resumable local draft; 10-minute/100-step/24-frame/64-MiB/20-draft limits; pause/resume/stop; bounded semantic targets and confidence; scrubbed URLs; password/OTP/payment/token/email/phone placeholders; issue checkpoint; expected/actual; reviewed text or bounded local voice note; flattened redactions; mandatory Review; Diagnose/Fix/Test; exact-session idempotent send | Audio stays local; only reviewed text is transmitted. There is no automatic replay, trace.zip, DOM/network/auth capture, or iPad test generation/execution. Guided Replay and a Mac recording store are not implemented. Physical proof remains open. |
| Reliability | Settings-only System Diagnostics; layer-specific proof; bridge/Codex/protocol versions; safe copyable summary; PWA update deferral during active studios; structured transitions for Home attention/badge/allowed notifications; per-device Web Push and private VAPID sender | Browser automation is not hardware proof. Missing capabilities remain unavailable. Push event coverage currently comes from the six native Micro slots, not every extended-catalog task. |
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
- Draw reserves most of the screen for the canvas. Select moves and resizes ordinary board content and graph blocks through the same interaction. Graph controls remain a compact floating capsule; the contextual inspector occupies extra space only after explicit editing.
- Settings is split on iPad and stacked on phone. Pairing has one primary action when an invitation is known.
- Coarse-pointer targets are at least 44 CSS pixels. Safe areas, visible focus, reduced motion, reduced transparency, and System-default theming are supported.

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

## Dated automated validation — 31 July 2026

The complete hardening implementation was published on `main` as commit `bb45368`. GitHub Actions [run 30661070563](https://github.com/blancmathis/nerva/actions/runs/30661070563) passed both the required `Node.js 22` job and the read-only macOS setup job for that exact product commit. Local validation before publication produced:

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

This working-tree result now has matching clean local clone proof, but not GitHub Actions proof because the changes are intentionally uncommitted. It is also not physical Mac/iPad/Pencil proof.

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
