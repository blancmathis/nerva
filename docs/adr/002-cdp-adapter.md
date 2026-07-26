# ADR 002: Isolate CDP behind a versioned Micro compatibility adapter

- Status: Accepted as an opt-in compatibility boundary; live reads, bounded native controls and one image attachment primitive are implemented
- Date: 2026-07-20
- Scope: Reading and controlling native Codex Micro state

> **Target boundary:** this adapter remains authoritative only for the six native Micro slots and actions it actually proves. The confirmed Home target may display 0–12 pinned sessions obtained through exact authenticated Mac session identity; a session does not need to occupy a Micro slot to appear on Home, but it may not inherit Micro controls merely by being pinned. See [`docs/product/FEATURES_target.md`](../product/FEATURES_target.md#3-home-and-pinned-sessions).

## Context

Codex Desktop does not publish an API for the six native Micro slots or their
configured HID, joystick, and encoder actions. The installed application does
contain those structures in dynamically hashed renderer modules.

[`dazer1234/codex-stream-deck`](https://github.com/dazer1234/codex-stream-deck)
demonstrates that a loopback Chrome DevTools Protocol connection can discover
loaded renderer modules, locate the six-slot store, and dispatch native Micro
events. These React/store/module shapes and event payloads are undocumented
Desktop internals.

## Current evidence

Desktop `26.715.61943` build `5628` exposes a loopback CDP target reached by
privacy-safe live probes without restarting Desktop. The current adapter reads
six fresh slot records, and static `app.asar` inspection also confirms:

- exactly six agent-slot structures, `AG00` through `AG05`;
- slot data including `threadKey`, title, selected state, and status, plus
  activity-related renderer structures that do not yield an authoritative live
  timestamp on this build;
- dynamically hashed Micro service, signals, bridge, settings, layout, and
  command modules;
- native HID and joystick event handlers.

The adapter is aligned with the observed version-1 joystick assignment shape,
`{ type: "command", commandId }`. The owner observed an exact-task Dictation
dispatch reach `0:00`, proving native event delivery while also exposing the
old atomic press/release defect; the corrected paired gesture still needs a
sustained physical retest. Separately, a generated PNG was dispatched to the
exact visible composer's live paste handler, appeared as one removable
attachment without submit, and was removed afterward. Activity timestamp and
current native reasoning remain unavailable from the live stores, and CDP
evidence does not prove app-server co-presence.

## Decision

All CDP behavior lives behind `CodexMicroAdapter`. The rest of the bridge sees
only validated snapshots and typed commands.

### Launch and discovery

1. Reuse a single existing Desktop process when safely CDP-enabled. Never start
   a second Desktop instance beside a running one.
2. If no validated loopback target is already reachable, an opt-in setup action
   may relaunch Desktop with
   `--remote-debugging-address=127.0.0.1` and a random port
   (`--remote-debugging-port=0`) only after explaining the restart and checking
   for active work. The current read-only attachment did not require a restart;
   any restart needed for managed app-server writer topology is a separate
   transport concern.
3. Discover the assigned port from process-owned state, then verify with `lsof`
   that it is bound only to loopback. If loopback cannot be proven, terminate
   the attempted integration and fail closed.
4. Select the renderer target by executable identity plus structural probes; do
   not trust page title or array order alone.
5. Record PID, process start time, executable path, bundle id, Desktop version,
   port, and renderer asset fingerprint. Revalidate them on every attachment.

### Dynamic renderer discovery

1. Enumerate script/link resources, Resource Timing entries, and late-loaded
   resources. Normalize URLs by pathname so query strings do not break matching.
2. Import each unseen candidate with bounded concurrency and cache its module
   namespace for the current execution context.
3. Match candidates semantically: known setting keys, exactly six slot ids,
   handler-map/dispatch behavior, and expected resolver/store shapes.
4. Require unique validated matches. Ambiguity is `incompatible`, never a guess.
5. Invalidate cached handles on navigation, execution-context loss, version or
   asset-fingerprint change, failed structural validation, or handler mismatch.
6. Permit one pre-mutation cache rebuild. Never automatically retry a native
   command after a timeout because the first dispatch may have succeeded.

Asset hashes and minified exports may appear in version fixtures as evidence,
but they cannot be the production discovery contract.

### Data projection and commands

- Keep raw `threadKey` inside the adapter. Project only allowlisted fields:
  slot number, canonical thread UUID, title, native status, visual status,
  selected state, activity time, ownership, and compatibility provenance.
- Preserve unknown native status values and map them to degraded/unknown. Never
  coerce a future status to idle.
- A selection command includes slot and expected canonical UUID. Re-read the
  current native slot before dispatch and reject a stale target.
- Implement a tap as one server-side, atomic down/up gesture bound to the same
  captured slot and `threadKey`. Dictation is the only current hold action: it
  uses explicit begin/end commands, and the accepted begin command ID becomes
  the opaque gesture ID that the matching end must reference.
- Resolve configured action labels from the live native layout. Do not assume
  the factory defaults. Project each action's keycap identity and nullable
  native-command identity into the validated snapshot.
- A HID command must echo both `expectedKeycapId` and
  `expectedNativeCommandId` from that snapshot. A joystick command echoes the
  separate nested `expectedAssignment` `{ type: "command", commandId }` from
  the live version-1 layout. After module discovery, re-read the corresponding
  live assignment immediately before every event and reject when its identity,
  the slot/direction, or the exact target changed. Never synthesize a joystick
  keycap identity.
- An unavailable or changed assignment before the first native event is a
  definitive fail-closed rejection. Uncertainty after a press may mean Desktop
  observed the action, so report `DELIVERY_UNKNOWN` and never auto-retry it.
- Expose one separate composer attachment operation limited to an exact
  canonical thread UUID, fixed filename and bounded canonical PNG. Revalidate
  the selected task, require one unique native add-context control and live
  `onPaste` handler, dispatch one in-memory `File`, and confirm its visible
  remove control. This operation must never expose submit, arbitrary text,
  keyboard shortcuts or an app-server method. See [ADR 001](001-thread-transport.md).
- CDP expressions are fixed, reviewed, bridge-authored programs. No browser
  request may supply JavaScript, module URLs, object paths, shell text, or an
  unrestricted `Runtime.evaluate` payload.

### Failure behavior

The adapter exposes `connecting`, `ready`, `degraded`, `offline`, and
`incompatible` health separately from agent status. It may retain the last valid
snapshot for display with a stale timestamp, but every mutation fails closed
unless the current renderer target, handlers, and target slot were freshly
validated.

Diagnostics include versions, probe names, structural error categories, and
asset fingerprints. They exclude prompts, transcript content, raw renderer
objects, credentials, drawing content, and local rollout data.

## Rejected alternatives

- Editing the Desktop application or injecting persistent files: breaks code
  signing and violates the project boundary.
- Reading or modifying Desktop databases or rollout logs: unnecessary private
  data access and not authoritative for native slot state.
- GUI/AppleScript automation as the primary adapter: focus-dependent and unable
  to prove exact native slot identity.
- Exposing CDP over the bridge or Tailscale: converts a local debugging surface
  into remote arbitrary code execution.
- Hardcoding the current hashed filenames or minified export names: guaranteed
  compatibility debt after Desktop updates.

## Consequences

- Native Micro fidelity is possible, including configured action assignments,
  but it is explicitly an undocumented compatibility layer.
- Desktop updates can degrade control without losing drawing drafts or the PWA.
- Live acquisition is proven on the current Mac for six fresh records, the
  version-1 joystick assignments, one Dictation event sequence reaching Codex,
  and one bounded image attachment without submit. Activity and reasoning
  authority remain degraded; sustained Dictation and physical iPad attachment
  still need device validation.
- A Desktop restart may still be needed to establish a single managed
  app-server writer topology, but not to attach to the current loopback CDP
  target.
- Compatibility fixtures and a `doctor` command are release requirements, not
  optional polish.

## Validation gate

A Desktop version is supported only after tests prove target discovery, strict
six-slot parsing, UUID extraction, unknown-status degradation, configured action
and assignment-identity discovery, live pre-event identity revalidation, native
selection, pre/post-dispatch failure classification, the fixed composer
attachment/no-submit contract and visible postcondition, cache invalidation,
restart recovery, and loopback-only CDP binding against that version.
