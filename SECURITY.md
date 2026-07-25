# Security

Nerva is a remote control for a coding agent that can read files, edit code, and run commands. Treat access to it as access to the signed-in Mac user and their Codex sessions. Existing technical identifiers remain `codex-pad` / `CodexPad`.

This document records the security boundary of the current `Home → Session` implementation. The remaining completion targets are defined in [`docs/product/FEATURES_target.md`](docs/product/FEATURES_target.md) and [`docs/product/PAIRING_target.md`](docs/product/PAIRING_target.md); they may not weaken the exact-session, authenticated-composer, loopback, media or fail-closed boundaries below.

## Supported versions

Nerva is currently pre-alpha and has no stable tagged release. Security reports against the latest `main` commit are accepted on a best-effort basis. Older commits and private forks are not maintained as separate supported versions.

## Supported deployment

The supported production shape is:

1. The bridge listens only on `127.0.0.1:8787`.
2. Tailscale Serve terminates private HTTPS/WSS for that loopback listener.
3. An iPad on the same tailnet pairs using a five-minute, single-use fragment invitation.

Resolve the installed macOS CLI, then use Serve:

```bash
CODEX_PAD_TAILSCALE_BIN="$(command -v tailscale 2>/dev/null || true)"
if [ ! -x "$CODEX_PAD_TAILSCALE_BIN" ]; then
  CODEX_PAD_TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" serve --bg --https=443 http://127.0.0.1:8787
```

Never use Tailscale Funnel for Nerva. Never bind CDP or the Codex app-server socket to a tailnet, LAN, or public interface. An explicitly unsafe LAN development mode, if enabled, is for an isolated trusted network only and is not a production deployment.

`npm run setup:mac` is the only setup command authorized to make persistent network/process changes. It may create or update only `~/Library/LaunchAgents/com.codex-pad.bridge.plist` and the exact HTTPS Serve route from port 443 to `127.0.0.1:8787`. It first requires authoritative Funnel-negative evidence and refuses an existing competing route. It never runs `tailscale serve reset`, edits another LaunchAgent, uses `sudo`, enables Funnel or changes the loopback bind. The legacy `npm run setup` and `npm run doctor` remain non-mutating outside Nerva-owned state beneath `~/Library/Application Support/CodexPad/`.

## Trust boundaries

- **Browser boundary:** the iPad can request only the finite typed operations represented in `packages/protocol`. It cannot make the bridge execute browser-supplied shell, filesystem paths, JavaScript, AppleScript, CDP expressions, or arbitrary upstream URLs. A skill suffix or user instruction remains text sent to one revalidated Codex task; it is never local execution authority.
- **Bridge boundary:** the bridge owns bearer authentication, exact Origin checks, runtime validation, idempotency, upload normalization, target revalidation, and rate/concurrency limits.
- **Desktop boundary:** CDP is loopback-only and implementation-owned. The managed app-server control socket is never served directly. Codex application files, databases, and rollout logs are not modified.
- **Thread boundary:** native Micro commands are bound to an exact thread UUID from the authoritative six-slot snapshot. Home may display up to twelve pinned sessions, but a session outside the native six receives only operations backed by its own exact Mac-issued thread/composer authority. A missing, changed, stale or ambiguous target always fails closed.
- **Media boundary:** imported photos, site frames, and drawings are untrusted sensitive inputs. They never grant URL, path, browser-tab, or thread authority.
- **Live-site boundary:** the current Sites picker lists only HTTP(S) Codex Browser pages whose renderer conversation is proven for the exact selected task. The user explicitly chooses one opaque page ID; the bridge re-resolves its task ownership before every bounded frame or typed control. The PWA never receives CDP, debugger URLs, DOM, cookies, auth state, arbitrary JavaScript/selectors or a generic upstream fetch primitive. Legacy registered-site metadata grants no live-page authority.

The Desktop renderer and app-server are compatibility dependencies, not trusted sources of arbitrary executable instructions. Responses and diagnostics are parsed as untrusted data and reduced to a minimal public snapshot.

## Pairing and credentials

- A QR code contains the private HTTPS origin and a 256-bit one-time invitation in `/pair#pair=…`, never a permanent credential. URL fragments are not sent in the HTTP request; the PWA submits the invitation only in the bounded pairing POST body.
- Pairing invitations expire after five minutes, are single-use, and are rate-limited. Generated QR URLs carry the secret only in the fragment.
- Successful pairing creates a random per-device bearer. The server stores only its hash in a protected record; the PWA stores the bearer in a dedicated IndexedDB scoped to the exact scheme/host/port origin, or keeps it in memory when that storage is unavailable. It never uses a cookie, URL, service-worker cache, or `localStorage` fallback. Responses clear former version-1 credential cookies during migration.
- Authenticated HTTP requests use `Authorization: Bearer …`. State changes additionally require the exact allowed `Origin`; the bearer is not ambient browser authority.
- Before each WebSocket connection, the authenticated PWA requests `POST /api/ws-ticket`. The returned ticket is bound to that Origin, expires after 30 seconds, works once, travels only as a `Sec-WebSocket-Protocol` value alongside `codex-pad.v1`, and is never persisted or put in the URL.
- Revocation invalidates the server-side credential record, removes unused tickets, and closes that device's active sockets. A `401` discards the bearer used by that request only if it is still the locally current value; a stale response cannot erase a newly paired credential.
- Credential state is written atomically beneath `~/Library/Application Support/CodexPad/` with restrictive permissions.

IndexedDB is origin-isolated browser storage, not a hardware-backed secret store: script running in the PWA origin can read it. The restrictive CSP, no-remote-runtime policy, dependency review, and XSS prevention remain credential protections. Do not put bearers or tickets in screenshots, URLs, issue reports, shell history, or logs. If a credential may have leaked, revoke the device and pair again.

## Web Push boundary

- Notification permission is requested only from the installed Home Screen PWA after the user taps `Enable`. Pairing does not silently grant or request it.
- The public VAPID key may cross the authenticated API. The VAPID private key and per-device browser endpoint/`p256dh`/`auth` subscription material stay in atomically replaced mode-`0600` files under `~/Library/Application Support/CodexPad/security/`.
- `PUT /api/push/subscription` requires the exact Origin, a valid paired-device bearer and mutation-rate admission. It accepts only HTTPS endpoints on known Apple, Google or Mozilla Push service hosts, with exact Web Push key sizes; it cannot be used as a general bridge-side URL fetch or SSRF primitive.
- The Push message is encrypted with `aes128gcm`. Its bounded plaintext contains only fixed generic status copy, a badge count and either one canonical task UUID or Home's priority focus. It never contains a title, prompt, output, command/approval summary, cwd, local path, credential or arbitrary URL.
- The service worker revalidates the event kind and destination. A notification tap can only focus/open Nerva at that safe destination. The notification defines no action buttons, so accepting or rejecting an approval from the Lock Screen is impossible.
- The bridge sends only from a new reliable transition. It silently seeds the first post-start authoritative snapshot and ignores stale/reconnecting/offline state. An aggregate `degraded` state is eligible only while its independent native slot proof is at most five seconds old; unavailable mutation authority never becomes notification command authority. A pinned task is the current explicit importance signal for completion notifications.
- Revocation removes the paired device subscription. Terminal `404`/`410` Push-service responses remove expired records. Removing local permission alone may not immediately inform a suspended Mac, so Settings `Turn off` removes the bridge record before unsubscribing the browser.

The browser Push service is a delivery intermediary, not a command channel. Possession of an endpoint cannot authenticate to Nerva, select a task, or approve a decision.

## Command and routing safety

Every typed agent/control operation submitted through `POST /api/command` has a caller-generated `commandId`. That ID is global across revoked and newly paired device credentials, so changing credentials cannot execute it again; creator device ID is audit metadata, not an authority namespace. The bridge coalesces an in-flight duplicate and returns the stored result of a completed duplicate instead of executing it again. Pair exchange, site capture, and paired-device administration are separate bounded endpoints and do not use this command ledger.

Every command also carries the expected `bridgeInstanceId` and snapshot sequence. After any WebSocket reconnect, a TCP `open` event and even a newer authenticated HTTP snapshot remain display-only: only a valid snapshot emitted by that exact active socket, matching or advancing the current `(bridgeInstanceId, sequence)` tuple, attests it for mutations. Replaced-socket frames are ignored, and the bridge rechecks the expected tuple before execution.

For reload recovery, the PWA's generic pending list stores command UUIDs only. Drawing delivery additionally stores a bounded immutable routing binding and SHA-256 identities for the instruction and scene. Review delivery stores one IndexedDB marker per target-thread draft containing only its command UUID, draft-update timestamp, and creation timestamp. None of these stores contains a mutation body, PNG/base64, raw scene JSON, instruction text, credential, media, or automatic replay instruction. A successful review send or draft deletion clears its marker; clearing the origin's site data clears it as well. Recovery checks status with authenticated `GET`; an explicit retry must re-render the still-matching IndexedDB draft and reuse the original ID.

The ledger retains completed/failed exact-once outcomes for a full seven days and never pressure-evicts them before expiry. Its production/default schema-bounded capacity is 16,384 records. In-flight and unresolved/delivery-unknown records never expire or get evicted; saturation rejects new authority with an explicit error rather than dropping existing records.

Authentication failures are bounded by an opaque presented-credential/source key and a bridge-wide invalid-guess ceiling; raw bearers are never retained in limiter state. The global ceiling limits further invalid guesses but never pre-blocks verification of an unrelated valid bearer. Authenticated mutations have independent per-device and global burst limits. Command and WebSocket-ticket authentication, Origin checks, mutation limits, and command admission run before request-body parsing; ticket issuance accepts no body beyond a one-byte parser ceiling.

A new command must acquire the single bridge-wide command admission slot before it can enter native or app-server execution, so two distinct IDs cannot race the same snapshot authority. The PWA also sends its UUID in `X-Codex-Pad-Command-Id`. Only when that authenticated header names an already in-flight ledger record may the request use a separate bounded body/coalescing slot. After the body is parsed, the bridge validates that both IDs match and atomically rechecks the command fingerprint and durable record. If the reservation disappeared, the request must acquire the main command slot or receives `429`; it cannot open a second execution path.

Any future containment-proven site capture, and every image-bearing command, also has per-device and global concurrency ceilings before Chrome or Sharp work begins. Every admission lease is released in `finally`. A rejected admission returns typed `429 RATE_LIMITED` with `Retry-After` before any command reservation or expensive operation. Authenticated `GET /api/snapshot` and `GET /api/commands/:commandId` consume neither mutation quota nor invalid-auth quota, so recovery, normal snapshot polling, and delivery reconciliation remain available during backoff.

Before selection, control, approval, model/effort update, skill action, or sketch delivery, the bridge checks the expected slot and thread UUID against the latest non-stale native snapshot. Exact-target app-server writes receive a one-shot authority only after that guard is rerun at the final write boundary. Operations without a pre-existing exact target still require verified shared Desktop ownership. There is no fallback to the selected Desktop window, a recent thread, a host session, or a thread with a similar title.

For Drawing/Photo composer attachments:

- The web client forces `instruction: ""`; assembly produces one normalized PNG and no text. Armed skills are not injected into or consumed by a Drawing send.
- The bridge revalidates the exact selected native task and unique live composer attachment control immediately before invoking the fixed paste primitive.
- The primitive waits for the visible attachment-count postcondition and never calls `turn/start`, `turn/steer`, a submit handler or a keyboard shortcut.
- A confirmed attachment removes the working draft. A rejected or unknown result preserves the draft and the same idempotency identity; delivery never starts later on its own.
- A thread is never silently forked.

Review delivery is a separate app-server operation. It remains subject to managed-transport authority, idle/busy routing and the optional installed-version multi-image attestation. An unrelated standalone or raw-listener app-server is never attached as a second writer against a live Desktop thread.

Approval and rejection use `respondToApproval` with the current snapshot sequence and exact pending `requestId`/thread/turn/item/kind tuple. The bridge revalidates the selected native target, one-shot transport authority, and the still-actionable request immediately before `accept` or `decline`; any changed or resolved object fails closed. Generic `APPR`/`REJ` HID mappings, keystrokes, labels, or text matching are not approval mechanisms.

Pinned membership, manual sections/cases, automatic status groups, Saved Drawing source labels and Review ordering are presentation/context surfaces. They do not change native slot ownership, agent status or command authority. Automatic groups reflect a reliable status but never set it. A live page/thread association requires an explicit bridge-issued binding to a verified page identity and exact UUID; title, focus or URL resemblance never suffices.

## Upload controls

Local import is bounded before invoking a browser decoder. For non-animated PNG, JPEG, static WebP, and structurally supported HEIC/HEIF the PWA validates magic/header structure with at most 256 KiB of retained header/table inspection data and at most 4,096 structures. A JPEG may be stream-scanned across its complete compressed file, still capped at 15 MiB, using at most a 64 KiB working chunk to find late markers; no bitmap decode begins during that scan.

The parser scans PNG chunk headers through `IEND`, rejects APNG and animated WebP, and rejects malformed/truncated input, unsupported or ambiguous HEIC/HEIF item constructions, any dimension above 16,384 pixels, and pixel areas above 16 megapixels for drawing or 32 megapixels for review before `createImageBitmap`, `Image`, canvas, or DataURL work.

Accepted HEIC/HEIF must use a primary HEVC image or grid whose exact item extents and configuration are inspectable. Both coded and conformance-cropped display dimensions are bounded, in-band parameter sets are rejected, grids contain at most 256 tiles, and aggregate coded tile pixels cannot exceed the caller's area limit. Decoded dimensions must match the inspected primary output; server-side Sharp validation remains a separate final boundary.

Review send preflights the complete retained set before conversion, caps aggregate inspected decode surface at 64 megapixels, then normalizes frames sequentially. Each resulting PNG is at most 8 MiB and the atomic image bundle is at most 24 MiB; a failure keeps the deck local instead of sending a partial prefix. Drawing export re-renders from the vector scene toward 92% of the 8 MiB ceiling to leave normalization margin. The bridge then canonicalizes from the original and, if needed, resizes iteratively without going below a 1,024-pixel long edge; it writes an exact PNG at or below 8 MiB or returns the explicit crop/resize error.

A local review draft holds at most 12 frames and 20 image records. Outbound review is a narrower atomic contract: at most 12 ordered images, 8 MiB each and 24 MiB total, with the complete instruction/metadata manifest capped at 8,000 characters. Draft capacity never implies send capability.

The typed `sendSketch` and `sendReview` variants carry bounded PNG data through authenticated `POST /api/command`; there is no path-based or arbitrary upload endpoint. The bridge:

- enforces body and decoded-byte limits;
- verifies PNG magic bytes instead of trusting the MIME header;
- rejects excessive dimensions and pixel counts before full processing;
- decodes and re-encodes the image to strip malformed or unexpected content;
- uses a randomized filename in an application-owned directory;
- creates the file with mode `0600`;
- never accepts a browser-supplied path;
- deletes the temporary image after protocol acknowledgement, error, or timeout;
- does not log image bytes or the instruction text.

The vector draft remains in the iPad's IndexedDB until the user clears it or a confirmed send policy removes it.

Local draft storage preserves the original non-HEIC PNG/JPEG/WebP blob and may therefore retain embedded EXIF/XMP, including location, until the frame/draft is deleted, local garbage collection removes it, or the origin's site data is cleared. HEIC/HEIF is converted to PNG before persistence when supported. Outbound PNG normalization strips source metadata before bridge delivery; that does not retroactively sanitize the local original.

Multi-frame review applies those per-frame and aggregate limits to the complete outbound bundle. The bridge never fetches an arbitrary browser-supplied URL. One-image Review does not depend on a multi-image attestation. Without accepted evidence, the server rejects an input shape containing 2–12 images instead of partially sending it, flattening it, or silently retaining only one image.

## Private multi-image capability evidence

The bounded multi-image probe is explicit and standalone. `setup`, `doctor`, `start`, and `serve` never create a probe thread. The operator must acknowledge the disposable thread, supply the exact setup-reported Codex version and schema SHA-256, and add `--write-attestation`. Before touching existing evidence, the probe validates the Node runtime and required options and resolves the requested Codex binary to an executable canonical path. Only then may it invalidate the prior record, before any app-server process or disposable thread starts. It writes a new record only after the complete probe and thread deletion succeed.

The only probe record path is the operating-system account home's `~/Library/Application Support/CodexPad/security/image-input-capability.json`; `HOME` and arbitrary capability-path environment values cannot redirect it. Automatic invalidation first opens the bounded record with `O_NOFOLLOW` and refuses to remove a symlink, non-regular file, mode other than `0600`, link count other than one, wrong owner, oversized or malformed JSON, a non-strict record shape, a changed file identity, or an unsafe parent directory. That refusal occurs before app-server launch. The operator must inspect and remediate such a path manually rather than asking the probe to delete unknown filesystem content.

The strict record shape includes `codexBinaryPath`, Codex version, schema hash, app-server user agent, verification time, fixed probe identity, bounded start/steer limits, and deletion confirmation. Writes refuse existing targets, create only fixed owner-mode-`0700` application directories beneath a verified non-symlink account path, publish a mode-`0600` regular file without replacing another entry, and recheck parent and file identity. Normal reads use the same bounded, no-follow, private-file checks.

Startup also treats the schema cache as untrusted mutable evidence. It strictly parses the versioned manifest, recursively re-hashes every non-manifest file in deterministic setup/doctor order, requires the exact ordered file list and digest, and matches both the manifest and private record to the located Desktop binary path and version. Missing or invalid evidence projects no capability. Public health data receives only the bounded capability result; invalid-state warnings are local and contain no discovered filesystem path.

This evidence raises only the accepted Review start bound from one image to 12. It does not establish Desktop writer ownership, exact-target authority, a safe active-turn route, or `turn/steer`, and it cannot bypass those checks. A successful isolated probe must never be described as live same-Desktop delivery.

Registered-site capture is a separate experimental capability. The current production compatibility gate returns `process-sandbox-unavailable` before launching Chrome, so no capture browser, proxy traffic, DNS, TCP, UDP, or WebSocket path starts. On the audited Mac, attempting to combine the outer exact-egress macOS policy with Chrome's own required child sandbox made child initialization fail. Disabling Chrome's sandbox is not an accepted workaround. The proxy, renderer guards, registry allowlist, and result validation are defense layers, but none alone is sufficient evidence of safe browser containment. A future build must add and pass a compatible runtime containment probe before enabling this path.

## Native dictation boundary

- Nerva never requests iPad microphone permission and never calls `getUserMedia`, `MediaRecorder`, or browser `SpeechRecognition`.
- Production responses set `Permissions-Policy: microphone=()`. The PWA has no audio recorder, audio store, voice segment, transcription adapter, editable transcript, or transcript-to-review routing path.
- The Dictate control is only the current native Micro `ACT10_ACT11` / `MIC` action for the exact selected native task, accepting the observed `dictation.toggle` identity or the known current nullable identity. The bridge requires a fresh authoritative snapshot and a successful live revalidation immediately before dispatch.
- A missing, stale, changed, or unverified Dictate binding disables the control or fails before the first native event. Nerva does not fall back to app-server text, another task, iPad audio capture, or a guessed Desktop control.
- Codex Desktop owns recording and transcription and uses the microphone selected on the Mac. Nerva does not receive, persist, inspect, log, cache, or resend that audio or resulting text.

## Web hardening

The production response policy should include:

- a restrictive Content Security Policy with no required remote assets;
- same-origin HTTP and WebSocket endpoints;
- non-ambient bearer authentication plus exact Origin validation on all mutations;
- `X-Content-Type-Options: nosniff`;
- clickjacking protection;
- disabled WebSocket compression where unnecessary;
- strict runtime schemas and bounded message sizes;
- pairing, authentication, and command rate limits plus bounded expensive-work concurrency.

The service worker caches only the application shell. It must not cache API responses, thread titles, sketches, bearers or WebSocket tickets. Separately, the PWA deliberately keeps the latest normalized bridge snapshot and non-Keep Draw/Review drafts in content IndexedDB for stale/offline orientation. The bounded snapshot may include task titles, thread UUIDs, slot state and approval summaries, but not transcripts or raw API response bodies. Clearing site data for the exact PWA origin removes those iPad-local records. The permanent bearer belongs only in the dedicated origin-scoped auth IndexedDB (or current-page memory fallback).

The all-session catalog is an authenticated, data-minimized part of current Home and `Unpinned Sessions`; the superseded Spatial opt-in does not exist. The browser receives bounded summaries, not a transcript corpus. Product State stores exact pinned IDs, layout and preferences in a private Mac file; it uses a strict schema, atomic replacement and expected revisions so an overlapping client cannot blindly overwrite newer state.

Saved Drawings are a separate private Mac store. The bridge accepts only strict bounded records, validates and decodes canonical PNG bytes, verifies declared dimensions, generates its own thumbnail and writes records/indexes atomically beneath `~/Library/Application Support/CodexPad/`. It permits at most 48 records, 8 MiB per PNG and 128 MiB total PNG data. The list endpoint omits full PNG and scene data; fetching one detail and deleting it require an exact validated ID, and deletion is always explicit.

`GET /api/native-sessions` remains separate from the catalog. It returns at most six exact native sessions plus sanitized registry/project/site association required by current controls. The bridge single-flights targeted reads, retains no cwd or turns, and never grants a catalog-only session native authority. Lifecycle polling occurs only while connected, online and visible; transient failure preserves last-good orientation, older registry generations are ignored, and disconnect/authentication loss disables dependent controls.

## Data handling and logging

Nerva has no telemetry and requires no cloud database, analytics provider, CDN, or authentication service. By default, logs contain structural health information such as versions, state sequence numbers, error categories, and redacted ID suffixes. They must not contain:

- prompts or agent responses;
- source code or file contents;
- full thread UUIDs;
- drawing bytes, imported images, site frames, or raw recordings;
- pairing codes, bearer credentials, WebSocket tickets, legacy cookies, or Tailscale authentication material.

`npm run audit:release` inspects the Git-tracked and unignored release-input files visible in the checkout. It checks required attribution inputs, the lockfile-derived production-license inventory and installed legal metadata, reviewed license expressions, known protected-asset filenames and hashes, selected credential and personal/temporary-path patterns, hard-coded version-hashed Codex modules, and remote PWA runtime resources. It does not inspect runtime storage, network traffic, an independently assembled archive, or every possible secret format. A clean audit is a necessary release gate, not proof that a build or deployment contains no sensitive data.

## Known security and compatibility limits

- The native Micro adapter relies on undocumented, version-hashed renderer internals exposed through CDP. If discovery or structure checks fail, native state and controls are disabled.
- The setup-configured durable app-server control socket and Desktop local-daemon integration are experimental. Exact-target writes consume a one-shot selected-target token synchronously at the final JSONL write; full co-presence additionally uses the ownership-generation proof. These are best-effort topology proofs, not an OS sandbox against a hostile or uncooperative same-UID process.
- The owner has completed live private Tailscale pairing and persistent PWA credential reuse. A clean replacement-device matrix and broader iPadOS/Tailscale version matrix are still unproven.
- iPadOS can suspend WebSockets. The PWA must reconnect and fetch a full snapshot before enabling mutations after resume.
- Physical iPad and Apple Pencil behavior requires the manual hardware checklist.
- Fresh registered-site capture is disabled before browser launch in the current production build because compatible process containment has not been proven. Live site/browser association and native Dictate dispatch also remain capability-gated until their exact runtime bindings are proven.

Do not weaken these fail-closed states to make a demo appear connected.

## Reporting a vulnerability

Do not open a public issue containing a credential, private thread title, prompt, screenshot, local path, or exploit details. Use [GitHub Private Vulnerability Reporting](https://github.com/blancmathis/nerva/security/advisories/new). Include:

- the affected Nerva commit;
- macOS, Codex Desktop, bundled Codex, Safari, and iPadOS versions;
- a minimal reproduction using synthetic data;
- the security impact and whether a credential should be revoked.

If GitHub does not show the private report form, open a content-free public issue asking the maintainers to enable a private channel; do not publish the details.
