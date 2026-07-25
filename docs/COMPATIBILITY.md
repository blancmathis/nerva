# Compatibility and versioning

Nerva currently spans two very different Codex contracts. Public UI and installed-PWA metadata use `Nerva`; existing technical package, storage, service and filesystem names retain `codex-pad` / `CodexPad` so upgrades remain compatible:

- The Codex app-server protocol is documented, but its installed schema and experimental managed-daemon integration can change.
- The native Codex Micro renderer surface is undocumented and version-hashed. It must be treated as a probed compatibility layer, not as a stable API.

This document records what was observed, not a guarantee for future Codex releases.

It is a compatibility record for the current implementation, not the future product contract. Use [`product/INDEX.md`](product/INDEX.md) for the confirmed target and [`product/CURRENT_STATE.md`](product/CURRENT_STATE.md) for the dated implementation gap.

## Current observed baseline

| Component | Observed version/state on 21 July 2026 | Proof level |
| --- | --- | --- |
| Mac | macOS `26.5.1`, Apple Silicon `arm64` | Observed locally |
| Codex Desktop application | `/Applications/ChatGPT.app`, bundle ID `com.openai.codex`, version `26.715.61943`, build `5628` | Observed locally on 21 July 2026 |
| Desktop-bundled Codex | `0.145.0-alpha.27` | Observed locally on 21 July 2026 |
| OpenAI-managed standalone CLI | `0.144.6` | Observed; required by the durable daemon manager, not used as the Desktop schema authority |
| Native Micro renderer | Version-hashed modules with exactly six `AG00`–`AG05` slots and known native states | Static structural inspection only |
| Native live slot values | Exact loopback CDP reads returned six fresh records and one unique selected slot. The canonical current sidebar row now owns navigation identity even outside those six; a stale composer marker cannot override it. Without a sidebar identity, matching composer/slot or the unique slot fallback is accepted, while an ambiguous disagreement fails closed. Joystick layout v1's `{ type: "command", commandId }` identity is revalidated; activity detail and native reasoning remain unavailable. | Live read-only proof against `26.715.61943`; navigation and native mutation authority remain deliberately separate, and mutation still requires its own final revalidation |
| Native composer image attachment | The exact visible composer exposed one live React paste handler reachable from its unique `data-composer-navigation-target="add-context"` control. A generated PNG appeared as one removable attachment; no submit handler or app-server call was invoked, and the diagnostic attachment was removed afterward. | Live Mac proof against `26.715.61943`; physical iPad tap still pending |
| Managed control socket | `~/.codex/app-server-control/app-server-control.sock`, provisioned by the Desktop-bundled manager and served by the OpenAI-managed standalone binary | Live daemon/socket plus direct WebSocket initialize proven; bounded probes returned 7 models, 54 cwd-scoped skills and 21 sessions without private contents, then held model/skill/latest-turn reads stable for 12 consecutive active-task cycles |
| Desktop ownership attestation | Optional stronger co-presence proof; not required for a mutation already bound to one exact selected native thread | Exact-target operations use one-shot final-write authority; new/no-target task creation remains disabled without full ownership |
| App-server initialize/resume/image turn | Green against a disposable isolated thread using the bundled binary | Isolated protocol proof |
| Live same-Desktop app-server image routing | Desktop restart/shared daemon unavailable during the active task | Not proven for Review; Drawing/Photo no longer uses this route |
| Live Codex Browser Site surface | Unified sanitized inventory, fresh opaque-target resolution, bounded JPEG frames and typed tap/scroll/text/key/history controls; no iframe, arbitrary URL, JavaScript or public CDP | Unit and responsive Playwright fixture proof; real Mac tab plus physical iPad/Pencil flow pending |
| Legacy registered-site surface | Compatibility metadata only; not shown by the current Sites picker and grants no live-tab authority | Fixture-tested metadata projection |
| Fresh registered-site capture | No compatible outer macOS exact-egress plus Chrome child-sandbox arrangement is proven | Current production gate returns `process-sandbox-unavailable` before launch; manual imports remain available |
| Multi-frame/comparison surfaces | Local deck plus fail-closed private attestation loader and an explicit standalone probe | Probe not executed in this work; no live multi-image claim |
| Native Codex dictation | The owner observed an exact-task native dispatch reach `0:00` and immediately stop. This proved the old atomic press/release reached Codex Desktop and exposed the defect; the corrected paired press/release implementation is automated-test green, but sustained recording and transcription still require a physical retest. | Partial owner-observed proof; sustained capture not yet hardware-validated |
| Home/Session PWA | Current visible navigation with 0–12 pins, manual sections/cases, temporary priority/status filters across pinned and unpinned sessions, Unpinned Sessions, exact Session controls, explicit `Following Mac` / `Staying here`, immediate follow realignment, Mac navigation outside the native six and Mac-backed Product State/Saved Drawings | Local automated browser proof at iPad landscape, iPad portrait and phone sizes; physical touch/Pencil gesture matrix incomplete |
| Tailscale and pairing | Tailscale installed and authenticated on the owner's Mac and iPad; private origin, QR pairing, Home Screen installation and credential reuse worked manually | One owner-confirmed live path; no timed clean-device or cross-version matrix |
| Apple Pencil | The physical iPad path is connected, but Pencil pressure/tilt, palm rejection and 60/120 Hz behavior have not been recorded | Not hardware-validated |

The isolated spike created a normal non-ephemeral test thread so it could be resumed, sent a 1×1 PNG using `localImage`, observed a completed reply, and deleted the test thread. It explicitly reported `liveDesktopCopresenceProven: false`.

## Support labels

Use these labels in issues and releases:

- **Structurally recognized:** doctor found the expected process, main renderer, modules, and schema shape. This does not prove commands.
- **Fixture-tested:** synthetic/redacted fixtures pass parsing, discovery, mapping, and degraded-state tests.
- **Isolated integration-tested:** the installed bundled app-server passes a disposable-thread test outside the live Desktop writer path.
- **Live Desktop-verified:** the six live native slots and exact same managed endpoint are observed, and an action is confirmed in the open Desktop UI.
- **Hardware-validated:** live Desktop verification plus the complete Mac/Tailscale/iPad/Pencil checklist passed for recorded versions.
- **Degraded/unknown:** a structural check, ownership check, origin check, or freshness check failed; mutation is disabled.

Never shorten “isolated integration-tested” to “live verified.”

## Extension capability policy

The bridge and PWA negotiate extension capabilities independently. A capability is usable only when its required browser, bridge, and installed transport checks are all green:

| Capability | Minimum gate |
| --- | --- |
| Drawing/Photo PNG attachment | Exact selected native target, one unique live composer attachment control and paste handler, bounded PNG normalization, no submit primitive, and a visible attachment-count postcondition. Managed app-server availability is not required. |
| Single reviewed PNG | Exact selected native target, connected managed control socket, one-shot final-write authority, idle start or safe busy route, bounded PNG normalization. Full shared-writer attestation and multi-image evidence are not required for this distinct Review operation. |
| Multiple reviewed frames | Single-image gate plus a private attestation for the exact installed binary/version/recomputed schema hash and installed-version acceptance of the complete `localImage` array and total bundle limits. |
| Legacy registered-site context | Exact registered origin plus sanitized compatibility metadata only; no authority over the visible live Site picker. |
| Live Codex Browser Site | Explicit opaque-tab choice in a known Session, fresh target resolution for every operation, authenticated bounded frame/control routes and HTTP(S)-only navigation without credentials in that chosen tab. No client JavaScript, selector, debugger or CDP primitive is exposed; exact native authority is still required for final PNG attachment. |
| Site QA Recorder | Live Site gate plus atomic recorded-control receipts, strict bounded manifest, local IndexedDB draft, explicit Review, 1–12 approved frames and exact `sendReview` authority. The recording UUID is the command idempotency key. Audio stays local; DOM, network, auth state and automatic replay remain unavailable. |
| Native Codex dictation | Fresh authoritative native slot, exact selected thread, current `ACT10_ACT11` / `MIC` identity, and live revalidation before each phase. The accepted begin command ID becomes the opaque gesture ID; end must match the same held slot, thread, action and binding. Missing, changed, replayed or mismatched identity fails closed. This native HID path does not require app-server ownership. |
| Capture Inbox | Local-only neutral Photo, Scan, Sketch, File and Note records. The surface has no Voice action, microphone dependency, Session destination, transport, queue or reconnect replay. Compatible items are copied into an exact local Review only from that Session. |
| Native Session Dictation | Uses Codex Desktop and the Mac-selected microphone. It does not request the iPad microphone, read Capture Inbox content or expose a browser transcript. |
| Home Product State | Authenticated Mac-owned state, strict 0–12 pins and bounded sections/cases/preferences; writes require exact Origin, bearer, expected revision and an atomic private-file update. Conflict reloads instead of overwriting. |
| Unified Home focus | Manual placement is durable presentation metadata. Priority and `Approval`, `Error`, `Working`, `Waiting`, `Completed` filters are temporary projections of reliable status, reuse the same cards and never mutate pins, cases, order or Codex state. |
| Session catalog | Authenticated bounded `/api/sessions` listing is always part of Home/`Unpinned Sessions`; the superseded Spatial opt-in no longer exists. Its last successful validated result may authorize navigation-only `openSession` during a transient app-server reconnect, but never a mutation or an unknown target. Native Micro actions remain independently limited to exact verified native slots. |
| Native-six session enrichment | Authenticated max-six `/api/native-sessions` response built from authoritative slots and targeted reads, plus sanitized registry/project/site association. Visible connected polling is bounded, single-flight and monotonic by registry generation. |
| Saved Drawings | Authenticated private Mac store; strict scene/PNG validation, max 48 records, 8 MiB per PNG and 128 MiB total; explicit Keep and manual delete only. |
| Skills | Available skills come from `skills/list` for the exact thread cwd when readable, with a temporary global user/system fallback that never borrows another task cwd. Groups with at least two skills appear as provider folders; singleton skills remain directly visible. The English suffix is assembled at the very end of text-bearing Codex Pad payloads; Drawing is image-only and keeps selections armed. Codex Pad can attach the image but cannot intercept, rewrite or submit native Mac composer text. |
| Model + reasoning | Live `model/list` defines supported combinations; exact-target `thread/settings/update` applies them. The touch range commits Safari's final value even when `input` follows `pointerup`, and a definitive rejection restores the last observed preset. Presets synchronize globally and stale combinations are hidden instead of downgraded. Native reasoning/Fast remain separate exact bindings. |
| Runtime diagnostics | Authenticated privacy-safe checks report each transport/capability independently, with last proof and installed-schema state. Diagnostics never create authority and contain no prompt, response, title, cwd, local path, bearer or full thread ID. |
| PWA update | A complete new cache must install before activation. Reload remains user-controlled and is disabled while Drawing, Review or Site can contain unsaved work. Service-worker activation alone is not presented as proof that the visible document already runs the new build. |
| Notifications/badge | The installed PWA can register a per-device standards Web Push subscription after one explicit tap. The Mac bridge stores it privately, signs with a persistent VAPID identity, sends encrypted status-only alerts, and removes expired subscriptions after `404`/`410`. The supported event set is approval, blocking question, error, pinned important completion and grouped ready results; a tap opens only an exact Session or Home's priority focus, with no Lock Screen approval action. Real suspended delivery, Focus and badge behavior remain physical iPadOS proof. Haptics remain unavailable where Vibration is absent. |
| Context Room/Nerva Cards | Optional exact loopback read-only `/api/health` projection plus strict versioned data cards. No arbitrary HTML, JavaScript, URL, style, event handler or mutation bridge. |

Capability absence is a normal degraded state. The client cannot enable a server capability by constructing a payload that the bridge did not advertise.

## Codex Desktop compatibility policy

The adapter detects the Desktop and bundled Codex versions at runtime. It may use known-version fixtures to choose a probe sequence, but it must not rely solely on version numbers. Every runtime target is structurally validated.

Dynamic discovery should prefer semantic structure over:

- hardcoded Vite asset hashes;
- minified export names;
- fixed React fiber positions;
- window titles;
- unvalidated global names.

A known version with an unexpected shape degrades. An unknown version with a fully validated known shape can be marked structurally recognized, but must still pass live/manual validation before being called supported.

Exactly six slots are required. Missing, extra, duplicate, malformed, or thread-ambiguous slots disable native mutations. Unknown statuses map to `degraded` while preserving the original redacted status category for diagnostics.

## App-server compatibility policy

Use `/Applications/ChatGPT.app/Contents/Resources/codex` as the protocol authority for that Desktop installation. A global CLI may differ.

`setup:mac` runs the bundled binary's experimental JSON Schema generator into an application-owned, versioned cache and records a hash manifest before installing the bridge. Doctor and the Capability Center report whether that cache is current, missing, invalid or unknown. Generated OpenAI source is not committed. Nerva's checked-in protocol package exposes only its narrow application contract and runtime translators.

At minimum, a new bundled version must pass:

1. initialize/initialized handshake;
2. thread read/resume behavior;
3. a disposable idle `turn/start` with text;
4. text plus PNG `localImage`;
5. completion/error parsing;
6. deletion/cleanup of the disposable thread;
7. active-turn routing tests against a fake server.

Image input to `turn/steer` is a separate capability. It is disabled until an installed-version probe proves it with an exact active turn ID. Successful `turn/start` image input does not imply successful image steering.

The optional bounded multi-image probe is a standalone, explicit operation. It is never run during setup, doctor, start, or serve. Its only record target is the operating-system account home's `~/Library/Application Support/CodexPad/security/image-input-capability.json`; environment variables cannot redirect it. Node/options and the canonical executable are validated before a prior record can be invalidated.

Existing evidence is deleted only after bounded no-follow checks prove a strict owner-matching mode-`0600` regular file with one link beneath non-symlink parents; any unsafe or unknown entry stops before app-server launch. On complete success the probe writes an owner-only record containing `codexBinaryPath`, the exact Codex version and schema SHA-256 supplied by the operator, the observed app-server user agent, and proof that one image and 12 ordered images completed through `turn/start` before the disposable thread was deleted.

Normal startup accepts that record only after scanning the installed-version schema cache, strictly parsing its manifest, recomputing the deterministic SHA-256 over all non-manifest files, and matching the exact manifest file list, hash, Codex version, and binary path. It then rechecks the private record against the same identity. Missing, malformed, insecure, tampered, version-mismatched, path-mismatched, or hash-mismatched evidence yields no multi-image capability; absence is normal and one-image Review remains independently available.

This isolated `turn/start` attestation is not shared-writer authority. It never proves Desktop co-presence, the exact live target, same-Desktop delivery, or image steering. The managed ownership attestation and exact-target checks remain mandatory independent gates, and the live bounded multi-image path remains unproven until the opt-in probe and manual same-Desktop checks are actually recorded.

The managed daemon and Desktop local-daemon opt-in are experimental. Setup invokes the Desktop-bundled daemon manager and sets the GUI environment value, but socket existence, Desktop adoption, and full single-writer topology must still be verified at runtime. A private full-ownership attestation binds the socket device/inode, current kernel listener generation, daemon process-start identity, Desktop process-start identity/version, and exact reciprocal Desktop peer. Exact-target operations instead consume a narrower one-shot token whose selected slot/thread proof is synchronously checked at the final write.

A replaced pathname or changed managed connection revokes outstanding authority and forces reconnection. Missing full ownership leaves list/read plus exact-selected-target operations available but disables task creation and other no-target writes. A third peer or stale full-ownership proof disables that stronger mode. Both mechanisms are best-effort fail-closed topology proof, not OS isolation from a hostile same-UID process. The ordinary Desktop IPC socket is not interchangeable with the app-server control socket.

## Browser and iPad policy

Automated Playwright projects cover representative iPad landscape, iPad portrait and phone viewports, but emulation does not prove:

- Apple Pencil pressure or tilt;
- real `pointerType: "pen"` behavior;
- palm rejection;
- iPadOS process suspension;
- Add to Home Screen storage lifetime;
- Tailscale switching between Wi-Fi and remote networks.

A browser/device combination becomes hardware-validated only after [the manual checklist](MANUAL_TEST_CHECKLIST.md) is recorded. The owner's pairing and installed-PWA reuse are useful live evidence, but they do not prove Pencil or every lifecycle case. Missing Pointer Event pressure or `getCoalescedEvents()` must fall back safely without losing basic drawing.

Browser microphone compatibility is deliberately narrow. A build may keep `Permissions-Policy: microphone=(self)` only for the explicit checkpoint voice note inside Site QA Recorder. Capture Inbox, startup, Home and Session Dictation must not request it. The PWA contains no browser speech recognition or generic transcript-routing path. Native Dictate remains independent: it requires live proof that the current observed Desktop binding dispatches once to the exact selected task and that Codex Desktop records/transcribes with the Mac-selected microphone. Browser emulation or a visible button alone proves neither physical Site QA voice capture nor native Dictation.

## Tailscale policy

Production compatibility requires a Tailscale version that supports Serve for a loopback HTTP backend and private HTTPS/WSS at a stable MagicDNS name. The installed client's `serve --help` output is authoritative because CLI syntax can evolve. On macOS, use the Standalone CLI integration or the App Store app's bundled executable as documented in [Mac setup](SETUP_MAC.md).

Codex Pad documents this baseline command:

```bash
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" serve --bg --https=443 http://127.0.0.1:8787
```

The snippet assumes `CODEX_PAD_TAILSCALE_BIN` was resolved with the Mac setup steps.

Funnel is unsupported. Direct tailnet/LAN bridge binding is unsupported for production. Doctor queries the installed CLI's read-only `tailscale funnel status --json` surface; unavailable, failed, unparseable, ambiguous, or exact-route-enabled results are red rather than treated as evidence of privacy.

Doctor treats Serve configuration text as declaration evidence only. `tailscale-serve` becomes green only after the loopback bridge health signature and listener are verified, the exact configured HTTPS MagicDNS origin matches the tailnet/Serve port, the Funnel query unambiguously proves that exact host/port is not public, and a bounded WSS upgrade reaches `/ws`. That unauthenticated diagnostic connection uses a reserved subprotocol and must close with `4401` before any application data. The separate `tailscale-wss` result proves the installed proxy's upgrade path, not private-only ingress, iPad ACL access, or an authenticated live session.

## Upgrade procedure

After a Codex Desktop, macOS, Node, Safari, iPadOS, or Tailscale update:

1. Save active work; do not restart automatically.
2. Record old and new versions.
3. Run `npm run doctor` before enabling mutations.
4. Run type checks, unit/fake-server tests, build, and release audit.
5. For Codex updates, rerun `npm run setup:mac` or the manual `npm run setup -- --generate-schemas`, then run the isolated integration test. Any old multi-image attestation fails the exact version/hash check; rerun the standalone probe only with explicit disposable-thread consent.
6. Relaunch Desktop once with loopback CDP if needed; verify listener scope.
7. Compare a redacted native snapshot structure against a known fixture.
8. Test all six selections and one synthetic command per command family.
9. Prove exact-thread image delivery in Desktop, including busy behavior and duplicate absence.
10. Re-run affected Tailscale/iPad items from the manual checklist.

If any structural or ownership check changes, ship a compatibility fix with mutations disabled by default for that version until the proof is complete.

## Codex Pad release versioning

Before `1.0.0`, minor releases may add or change compatibility probes and the local typed API, while patch releases should preserve the API and fix behavior. Every release should publish:

- Codex Pad version and commit;
- fixture-tested Desktop versions;
- isolated app-server versions;
- live-verified and hardware-validated matrices, if any;
- known degraded versions;
- security-relevant setup changes;
- migration steps for stored credentials or drafts.

After `1.0.0`, incompatible browser/bridge protocol or persisted-data changes require a major version. A Codex Desktop update that merely requires a new adapter probe does not automatically require a Codex Pad major version, but the compatibility report must make the newly supported range explicit.

## Adding a compatibility fixture

Fixtures must be synthetic or aggressively redacted. Include only structural keys and values necessary to test discovery and mapping. Never include:

- titles or prompts;
- transcripts or source code;
- full thread UUIDs tied to a real user;
- local project paths;
- tokens, cookies, environment values, or QR codes;
- extracted JavaScript bundles, proprietary artwork, or generated OpenAI protocol code.

Record the fixture's observed Desktop/bundled Codex versions and the smallest structural difference it exercises. Update the relevant ADR and `docs/research.md` when the compatibility decision changes.
