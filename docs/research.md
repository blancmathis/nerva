# Codex Pad research record

Research snapshot: 2026-07-20

This is a historical research record, not a claim that every target capability is
already implemented. “Current” in the research observations means the Mac state
at the moment of this spike, before later implementation and pairing work.
“Target” means a design direction selected during this research spike; where it
conflicts with the later product interview, the canonical files in
[`docs/product/`](product/INDEX.md) supersede it.

## Executive result

The product is feasible in layers, but the full live critical path is not yet
proven.

- The official Codex Micro experience establishes six agent keys, live status,
  configurable command keys, four analog directions, and reasoning control.
- The installed Codex app-server successfully completed an isolated test using
  `thread/resume` followed by `turn/start` with text and a generated
  `localImage` PNG.
- The installed version-matched protocol schema also accepts `localImage` in
  `turn/steer` and requires an `expectedTurnId` precondition. The methods
  themselves are on this version's default protocol surface.
- The current Desktop process is not connected to a managed app-server daemon.
  Its loopback Chrome DevTools Protocol (CDP) target is reachable: two
  privacy-safe, read-only probes returned six fresh slot records, and the second
  recognized the live version-1 joystick assignments. Activity and current
  reasoning remain degraded. No native event was dispatched, and the isolated
  app-server test did **not** send into a Desktop-owned live session or prove
  Desktop co-presence.
- At the time of this research spike, Tailscale was not installed. It was later
  installed and authenticated on the owner's Mac/iPad, and private QR pairing,
  Home Screen installation and credential reuse worked manually. That later
  observation still does not prove the complete timed/replacement-device matrix.

For the current native-Micro transport studied here, Codex Pad must fail closed
until it can prove both the selected native slot and shared ownership of the
corresponding app-server thread. The later product target generalizes selection
to an exact authenticated session/composer authority, but it keeps the same rule:
never create an invisible parallel copy of a live Desktop thread.

## Official remote surface and Codex Pad's distinct role

OpenAI now documents **Remote** in the ChatGPT mobile app. It can connect a phone to a desktop host, continue chats, send instructions, approve actions, review outputs and switch between hosts or chats. Setup begins in the desktop app and completes through a QR plus the user's ChatGPT account and workspace. OpenAI also documents the experimental `codex remote-control` CLI for managed Remote and SSH workflows, while explicitly distinguishing it from `codex app-server --listen` for a custom local protocol client.

Codex Pad therefore must not be described as the only way to access Codex from mobile. Its confirmed value is the dedicated iPad tactile and Pencil workflow, pinned-session Home organization, native-composer media handoff, Saved Drawings and Site Review. The product may reuse documented primitives only where their exact contracts fit; it must not claim compatibility merely because official Remote exists.

Official sources: [Remote connections](https://learn.chatgpt.com/docs/remote-connections), [`codex remote-control`](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-remote-control).

## Evidence classes

| Label | Meaning |
| --- | --- |
| Official | Published product or developer documentation from the vendor. |
| Version-matched | Generated schema, source tag, or observed behavior matching the installed binary. |
| Reverse-engineered | Open-source inspection of undocumented Desktop renderer behavior. Compatibility may break without notice. |
| Target | A Codex Pad design decision that still needs implementation or operational proof. |

## Current Mac baseline

The current environment was inspected without restarting Desktop or changing
persistent configuration.

| Surface | Current observation |
| --- | --- |
| Desktop application | `/Applications/ChatGPT.app`, bundle id `com.openai.codex`, version `26.715.52143`, build `5591`. |
| Desktop app-server | Bundled `codex-cli 0.145.0-alpha.18`, spawned by Desktop over inherited stdio. It exposes no attachable TCP or managed-daemon socket. |
| Default standalone CLI | `codex-cli 0.144.1`. It is older than the Desktop-bundled protocol and is not the compatibility authority for this build. |
| Managed daemon | `~/.codex/app-server-control/app-server-control.sock` is absent; `app-server daemon version` fails because the socket does not exist. |
| CDP | An exact loopback renderer target is reachable. Two privacy-safe, read-only probes returned six fresh slot records; after the joystick contract fix, only activity and current reasoning remain degraded. No native event was dispatched. |
| Tailscale | No CLI, application bundle, process, launchd job, package receipt, or system extension was found. |

An unrelated independent app-server owned by an existing local service was also
running. It is not Desktop's stdio child or a shared managed daemon. Codex Pad
must establish ownership and stop or isolate competing writers before any live
thread test; it must not attach to that process by assumption.

Static inspection of the installed `app.asar` found dynamically hashed Micro
modules, including a Micro service, slot signals, bridge, settings, joystick,
layout, and command modules. For this build, the structure contains exactly six
agent slots (`AG00` through `AG05`), slot fields for `threadKey`, title,
selection, and status, and native status values including `off`, `idle`,
`working`, `unread`, `awaiting-approval`, `awaiting-response`, and `error`.
It also contains handlers for `codex-micro-hid-event` and
`codex-micro-joystick-event`.

That static evidence proves a compatible structure exists in this installed
bundle. A later privacy-safe, read-only probe reached the exact renderer over a
loopback CDP endpoint and reported six fresh slot records. It did not establish
full adapter authority: the slot store exposes no activity timestamps and the
settings store exposes no current reasoning level. The version-1 joystick
layout uses strict `{ type: "command", commandId }` identities; after the
adapter was updated to carry and revalidate that exact shape, a second read-only
probe no longer reported `joystick-layout-unavailable`. No native event was
dispatched, and no session titles or identifiers were included in the report.

## Historical feasibility spike result — 20 July 2026

This table records the original pre-implementation observation and must not be
read as current runtime status. Since that spike, `setup:mac` has added the
durable managed app-server/control socket, exact-target one-shot authority,
live cwd-scoped skills, and live model/effort catalog/update support. Current
truth is tracked in [`product/CURRENT_STATE.md`](product/CURRENT_STATE.md) and
[`COMPATIBILITY.md`](COMPATIBILITY.md).

On 21 July, the current implementation also completed the control socket's real
WebSocket handshake and returned bounded counts for five models, 53 cwd-scoped
skills and 21 sessions without printing private session content. The original
rows below intentionally remain historical.

The isolated protocol spike used the Desktop-bundled `0.145.0-alpha.18`
app-server, a generated 1×1 blue PNG in a mode-`0600` temporary file, and an
isolated test thread. It initialized the protocol, created and materialized a
seed turn, resumed the same thread id, acknowledged a text-plus-`localImage`
turn, completed it, received the expected image-specific response token, deleted
the test thread, and removed the temporary directory.

| Required proof | Result | Evidence boundary |
| --- | --- | --- |
| Detect Desktop and versions | Proven | Process, bundle metadata, and binary versions were inspected. |
| Establish that the installed build contains six native Micro slot structures | Proven statically | Installed renderer modules; not live values. |
| Read the current six native slots | Partially proven, read-only | Exact loopback CDP probes reported six fresh records; the changed joystick identity is now recognized, while activity and current-reasoning sources remain absent. |
| Extract a real UUID from the selected live `threadKey` | Not proven for control authority | The privacy-safe probe did not publish or assert a selected UUID, and mutations remained disabled. |
| Connect to the same managed app-server as Desktop | Not proven in this historical spike | At that time Desktop used its own stdio child and the managed control socket was absent; this is not the current setup status. |
| `thread/resume` on an isolated test thread | Proven | The resumed id matched the created id. |
| `turn/start` with text plus `localImage` | Proven in isolation | Request acknowledged, turn completed, and image content was recognized. |
| Image support in `turn/steer` | Schema-proven only | Version-matched bindings accept the same `UserInput[]`; runtime steering was not exercised. |
| Message and image appear in the exact Desktop-owned live session | **Not proven** | The spike intentionally avoided a second writer on a live thread. |
| Subsequent Desktop updates remain synchronized | **Not proven** | Requires shared-daemon co-presence proof. |

See [ADR 001](adr/001-thread-transport.md) for the resulting fail-closed
transport decision.

## Official Codex Micro behavior

The [OpenAI Supply Co. product page](https://openai.com/supply/co-lab/work-louder/),
[Work Louder product page](https://worklouder.cc/codex-micro), and
[official Codex Micro documentation](https://learn.chatgpt.com/docs/features/codex-micro)
agree on the user-facing model:

- six Agent Keys follow chats and expose idle, thinking, complete/unread,
  requires-input, error, or unassigned state;
- configured Command Keys perform actions such as approve, decline, new chat,
  push-to-talk, send, and other Desktop commands;
- four analog directions can launch configured commands or skills;
- the dial can navigate composer controls or adjust reasoning effort;
- controls are configured in the Desktop Codex Micro settings.

The official videos—[Getting started with Codex Micro](https://www.youtube.com/watch?v=3-2OH6ReiPM)
and [Introducing the Codex Micro](https://www.youtube.com/watch?v=m8uUUUsMD3Y)—were
used as interaction references, not as protocol documentation.

None of those product sources publishes a programmatic API for reading the six
slots or dispatching their actions. Their artwork, keycap SVGs, screenshots,
logos, video, and trade dress have no open-source grant and are not copied into
Codex Pad.

## Official Codex app-server boundary

OpenAI documents [Codex app-server](https://developers.openai.com/codex/app-server)
as the integration surface for rich Codex clients. It uses JSON-RPC-shaped
messages, requires `initialize` followed by `initialized`, supports
`thread/resume`, `turn/start`, `turn/steer`, and streamed lifecycle events, and
can generate version-specific TypeScript or JSON Schema bindings.

The relevant open-source implementation is
[`openai/codex`](https://github.com/openai/codex/tree/main/codex-rs/app-server),
licensed Apache-2.0. Research inspected:

- current `main` commit
  [`2deed3fb9c00c74dac3d177ea700d6fb7a94539d`](https://github.com/openai/codex/commit/2deed3fb9c00c74dac3d177ea700d6fb7a94539d);
- the installed-version tag `rust-v0.145.0-alpha.18`, commit
  [`f84f9a6406cc55b210395f71b4c6aed236fc7ebb`](https://github.com/openai/codex/commit/f84f9a6406cc55b210395f71b4c6aed236fc7ebb);
- the standalone `0.144.1` tag, commit
  [`44918ea10c0f99151c6710411b4322c2f5c96bea`](https://github.com/openai/codex/commit/44918ea10c0f99151c6710411b4322c2f5c96bea).

OpenAI labels the overall `codex app-server` command **experimental**, primarily
for development/debugging, and subject to change without notice. Within that
experimental product, the protocol distinguishes a default surface from
separately gated experimental methods and fields. In `0.145.0-alpha.18`, basic
`turn/start` and `turn/steer` belong to the default protocol surface.

The installed generated types prove this version-specific shape:

```ts
type UserInput =
  | { type: "text"; text: string; text_elements: TextElement[] }
  | { type: "localImage"; path: string; detail?: ImageDetail };

type TurnSteerParams = {
  threadId: string;
  input: UserInput[];
  expectedTurnId: string;
};
```

This is protocol acceptance, not proof that an independent process can safely
join the same live thread as Desktop.

The shared-daemon topology in
[`openai/codex#31991`](https://github.com/openai/codex/issues/31991) is an open,
user-authored issue with no maintainer endorsement. Its
`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` flag is explicitly described as
undocumented. It is useful evidence for a controlled experiment, not a supported
contract.

## Open-source reference implementations

All four reference repositories were cloned outside this repository and pinned
to the following research revisions.

| Reference | Revision and license | Adopted boundary | Rejected boundary |
| --- | --- | --- | --- |
| [`dazer1234/codex-stream-deck`](https://github.com/dazer1234/codex-stream-deck) | [`f3b61903311e9205e6366bb068977fb7adfd5481`](https://github.com/dazer1234/codex-stream-deck/commit/f3b61903311e9205e6366bb068977fb7adfd5481), MIT, copyright 2026 Dazer | Principal reference for semantic discovery of hashed renderer modules, strict six-slot parsing, UUID suffix extraction, native Micro event dispatch, and degraded-state handling. | No hardcoded asset hash/minified name as a sole strategy; no rollout-log scanning; no official keycap files; no raw browser-supplied evaluation. |
| [`stephenleo/OpenMicro`](https://github.com/stephenleo/OpenMicro) | [`73a153dbdbf877505df0fff6dda1f9ec4cd34dfc`](https://github.com/stephenleo/OpenMicro/commit/73a153dbdbf877505df0fff6dda1f9ec4cd34dfc), MIT, copyright 2026 Stephen Leo | Transport-neutral action vocabulary, press/release gesture safety, and separation between state aggregation and feedback. | Its hook-created sessions are not native Micro slots; AppleScript keystrokes, internal database reads, and deep-link focus are not an exact-thread image transport. |
| [`mrshu/muxboard`](https://github.com/mrshu/muxboard) | [`e4b8375bfb533937cec9815485bad14fdd8b40f4`](https://github.com/mrshu/muxboard/commit/e4b8375bfb533937cec9815485bad14fdd8b40f4), MIT, copyright 2026 Marek Šuppa | Non-overlapping refresh, retained last-good state, explicit stale/offline state, and snapshot-plus-event reconciliation. | No text/spinner inference as authoritative Codex state; no private profile/database edits; no extracted provider or Orca logo paths. |
| [`jordjones/cmux-mobile`](https://github.com/jordjones/cmux-mobile) | [`d1c2584bbacbfca1b2cf997ac28e632af97158bd`](https://github.com/jordjones/cmux-mobile/commit/d1c2584bbacbfca1b2cf997ac28e632af97158bd), MIT, copyright 2026 cmux-mobile contributors | Same-origin local bridge/PWA split, heartbeat, jittered reconnect, visibility resume, full-snapshot recovery, and clear active-target UX. | No direct tailnet-IP binding, loopback trust bypass, terminal keystroke replay, permanent token in a URL, or terminal surface id as a Codex thread id. |

These are reference-informed architectural ideas; no upstream visual asset or
verbatim source file is distributed. The current explicit source-level influence
map is maintained in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md),
including the renderer discovery/runtime files and the corroborated deep-link
boundary. Update that map before release whenever a new file becomes
substantially reference-informed. The full MIT notice is retained there.

## Drawing and Pointer Events

[`perfect-freehand`](https://github.com/steveruizok/perfect-freehand) is the
selected pressure-sensitive stroke-outline engine. The project pins published
version `1.2.3` at commit
[`f56f097e0e211fffa1601b93883e4d9f9dccf122`](https://github.com/steveruizok/perfect-freehand/commit/f56f097e0e211fffa1601b93883e4d9f9dccf122).
The research snapshot of `main` was
[`176e00f2399f4969e1b0965c5921d96a3e50ce9f`](https://github.com/steveruizok/perfect-freehand/commit/176e00f2399f4969e1b0965c5921d96a3e50ce9f).
It is MIT-licensed, copyright 2021 Stephen Ruiz Ltd.

The package converts input points into a stroke polygon. It is not a scene
editor. Codex Pad therefore owns the serializable scene, tools, transforms,
hit-testing, undo/redo, background image, and PNG export.

[Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent),
`pointerType`, pressure, tilt, and pointer capture are documented web-platform
APIs. `getCoalescedEvents()` is standard-track but remains limited-availability
and secure-context-only, so it is feature-detected with a one-event fallback.
See [ADR 003](adr/003-drawing-engine.md).

## Tailscale Serve and MagicDNS

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) is the
selected private ingress. It proxies a loopback service to tailnet peers over a
MagicDNS HTTPS origin. [MagicDNS](https://tailscale.com/docs/features/magicdns)
provides the machine FQDN; it is naming, not authorization.

The owner has since installed and authenticated Tailscale on the Mac and iPad,
and the private pairing/PWA credential-reuse path has worked. The bridge's
production port remains `8787`; `setup:mac` inspects the installed CLI version,
preserves unrelated Serve routes and configures the exact private HTTPS 443
mapping to that loopback service.
Funnel is public and is never permitted. Official Serve documentation does not
explicitly promise WebSocket upgrades, so WSS remains an operational test with
snapshot polling as fallback. See [ADR 004](adr/004-tailscale-serve.md).

## Stability and compatibility summary

| Surface | Classification | Project policy |
| --- | --- | --- |
| Codex Micro user behavior | Official product behavior | Use as the UX model, not as a programmatic API. |
| Codex app-server | Official but experimental product surface | Generate/compare schemas from the Desktop-matched binary; validate every message; maintain compatibility tests. |
| `localImage` in start/steer | Version-matched default protocol surface in `0.145.0-alpha.18` | Supported only after shared-thread ownership is proven. |
| Managed Desktop daemon environment flag | Undocumented internal reported in an open issue | Experimental setup path requiring explicit explanation, restart, and topology verification. Any such restart concerns managed writer topology, not attachment to the already reachable loopback CDP target. |
| CDP transport | Standard Chromium debugging mechanism | Loopback-only and opt-in; renderer modules and Micro event shapes remain undocumented internals. |
| Six-slot renderer discovery/control | Reverse-engineered | Dynamic semantic discovery, strict projection, version fixtures, and fail-closed degradation. |
| Pointer Events | Public web standard | Primary input API with feature detection and real-iPad testing. |
| Tailscale Serve/MagicDNS | Official Tailscale features | Private ingress only; retain app-level pairing/authentication. |

## Intellectual-property and security boundary

Codex Pad is an independent community project. Research and interoperability do
not grant trademark or asset rights.

- Do not copy or distribute OpenAI, Codex, Work Louder, Apple, Stream Deck,
  Orca, CodexBar, or other provider logos, product imagery, screenshots, keycap
  SVGs, extracted icon paths, fonts, or trade dress.
- Use original project icons and neutral text labels. Use third-party names only
  to describe compatibility.
- Never modify the Desktop application, its databases, or rollout logs.
- Never expose CDP, app-server sockets, a shell, a filesystem API, or
  `Runtime.evaluate` to the iPad or network.
- Keep all CDP expressions fixed and bridge-authored. Accept only typed,
  allowlisted commands and project strictly validated data out of the renderer.
- Preserve the notices in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
  in source and packaged releases.
