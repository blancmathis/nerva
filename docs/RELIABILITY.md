---
context_room:
  kind: canonical
  scope: runtime
  status: current
  canonical_for: capability evidence PWA updates notifications and bounded integrations
  last_verified: 2026-07-26
  sources: [packages/protocol/src/runtime.ts, packages/protocol/src/nerva-card.ts, packages/protocol/src/integrations.ts, apps/bridge/src/server.ts, apps/bridge/src/push-notifications.ts, apps/bridge/src/context-room-adapter.ts, apps/web/src/components/CapabilityCenter.tsx, apps/web/src/lib/pwa-updates.ts, apps/web/src/lib/agent-notifications.ts, apps/web/src/lib/activity-timeline.ts, apps/web/src/sw-template.js]
---

# Nerva runtime reliability

This page describes the reliability features that are implemented now. It does not turn a browser fixture, an old compatibility probe or a visible control into proof that the current Mac/iPad path works.

## Current runtime verdict

As observed on 26 July 2026, the bridge and private managed socket are reachable. Desktop `0.146.0-alpha.3.1` and daemon/app-server `0.145.0` differ, but their exact generated schemas accept Nerva's representative payloads and the live daemon returns structurally valid `thread/list` and `model/list` responses. Doctor therefore reports **Ready with limitations**, not a global failure. Desktop ownership on that exact socket and the native Micro adapter remain unverified, so their mutations stay disabled. Three unrelated stdio writers remain visible diagnostics only.

This is the intended fail-closed behavior. Pairing, cached read-only state and local editing may remain available, but an app-server-backed action must not be advertised or executed until its independent capability gate is current. Older live proofs are compatibility history, not authority for this Desktop version.

`npm run setup:check` and default doctor both return success for this limited state. `npm run doctor -- --strict-native` remains nonzero until the principal native capabilities are all attested. The pairing invitation is created only after the installed bridge answers `/api/health`.

## System Diagnostics

The authenticated `GET /api/runtime` endpoint returns a privacy-safe diagnostic document. Nerva exposes it only through **Settings → System Diagnostics**; Home keeps a single unambiguous Settings control.

Each layer is independent:

- sessions and managed Codex transport;
- exact native controls;
- image attachment to the native composer;
- Skills and Model + Reasoning catalogs;
- approvals;
- live Sites;
- browser notification support and permission.

A check is `Available`, `Recovering`, `Needs verification` or `Unavailable`. A successful proof records its time. The response can include bridge, Codex and protocol versions and the installed-schema state, but never a title, prompt, response, cwd, local path, bearer, pairing code or full thread identifier. `Copy summary` copies only this bounded diagnostic projection.

The center is diagnostic, not an override. It cannot enable a missing server capability or bypass an exact-target gate.

## Installed-version schema compatibility

`npm run setup:mac` asks both the Desktop-bundled and managed-daemon Codex binaries to generate experimental JSON Schemas into private version-and-binary-fingerprinted cache entries. Doctor recomputes every manifest hash/file list, validates representative request payloads, then performs read-only live structural calls. A compatibility record is reusable only for the same two binary hashes, schema hashes and `userAgent`; any update triggers a new probe. Schema failure limits the affected controls but does not prevent the independent bridge and pairing installation. Startup reports one of:

- `current`: cache matches the installed binary and version;
- `missing`: no valid cache exists yet;
- `invalid`: cache exists but its manifest, hash, files or identity fail validation;
- `unknown`: the check could not establish a trustworthy result.

System Diagnostics exposes only that state and a safe remediation. It never serves the generated OpenAI schemas to the browser and does not commit them to the repository.

Schema compatibility proves protocol shape only. Native renderer actions, same-Desktop ownership, live Site mapping and physical iPad input retain separate gates.

## Drawing export and recovery

Draw never allocates a bitmap the size of its world. It renders only the viewport during editing and creates bounded PNGs sequentially during export. `Whole board` and `Select area` resolve to one image, a map-first linked package, or one compatibility atlas. The package uses gap-free rectangular cores, 12% symmetric render overlap, stable region IDs, deterministic filenames, external detail headers, neighbor links, mini-maps and identical `R-…` registration markers on both sides of every neighboring pair. A structured Diagram additionally provides an exact-revision node/region and cross-region edge index plus matching continuation codes; no semantics are inferred for Pencil ink. Each image is limited to 8 MiB, a native lot to 24 MiB and cumulative decoded pixels to 64 MP.

Before any native mutation, Nerva validates every image, persists the exact ordered bytes and binds them to the board, checkpoint, command, thread, slot and snapshot. A reload or unknown result cannot silently rebuild a different export. Reconciliation is read-only; only an explicit retry reuses the immutable package and same command ID. Confirmed success checkpoints the board, while failure or uncertainty keeps it active. A partial native batch is never topped up automatically.

The bridge advertises one or twelve composer attachments independently from Review's app-server image limit. The current runtime remains at one until the exact installed Codex Desktop batch path is physically attested, so the atlas fallback is the verified behavior rather than a simulated capability.

## Atomic PWA updates

The build emits an immutable asset graph, a build-specific service worker and `app-meta.json`. The service worker installs a complete new cache before activation and deletes obsolete Nerva caches only after the new worker activates.

The root application build resolves one revision once, passes it to both Web and Bridge, and verifies their emitted runtime identities before succeeding. Browser fixtures build into process-owned temporary directories, so screenshots and E2E runs cannot replace production `apps/web/dist` with a synthetic build.

At bridge startup, Nerva copies that generated distribution into a private process-scoped snapshot and verifies its `buildRevision` and API contract against the bridge's compiled identity before listening. The running process serves only that snapshot; a later repository build cannot replace its JavaScript, CSS, service worker or fallback document underneath an active exact-build gate. A missing or mismatched production identity aborts startup, and the private snapshot is removed on clean shutdown.

The active document is not silently reloaded. When a new worker controls the origin, Nerva shows a reload banner. Reload is disabled while Drawing, image Review or Site Review is active so an unsaved working surface is not discarded. The user can finish or leave that surface, then reload explicitly.

The update monitor also checks when the app returns to the foreground and at a bounded interval. Pairing credentials and drafts remain in their separate IndexedDB stores and are not placed in the service-worker cache.

## Activity and attention

Nerva derives privacy-safe reliable status transitions for Home attention counts, the app badge and allowed notifications. It does not render a growing per-task `Recent activity` feed. Home exposes compact counts for approval, error, working, waiting and completed across the validated catalog. Each count filters the existing Home cards directly; the separate priority button shows pinned attention first, then other pinned sessions, then unpinned attention. These views are temporary and never rewrite manual sections, cases, pins or order.

Events contain only task ID, status, timestamp and fixed English status copy. They never contain prompts, agent output, inferred progress, source code or a generated summary. Initial observation does not create a false transition event.

## Notifications and badges

Current behavior:

- permission is requested only after the user taps `Enable` in Settings;
- the installed PWA creates a standards-based Push subscription and registers it for the exact paired device with the authenticated Mac bridge;
- the bridge creates one persistent private VAPID identity and sends encrypted `aes128gcm` Web Push messages through the browser vendor's allowlisted HTTPS Push endpoint;
- the decision engine sends only an approval, blocking question, error, important completion, or grouped-results notification. An important completion is currently defined as a transition to `Completed` for a pinned task;
- the first authoritative observation after bridge startup establishes a baseline and never creates a false alert. `live` snapshots qualify; a `degraded` aggregate health snapshot qualifies only when its native slot proof was refreshed within five seconds, allowing a read-only status alert when an unrelated mutation/control layer is unavailable. Stale, reconnecting and offline snapshots do not create transitions;
- approvals, blocking questions and errors use high urgency with a one-hour TTL. Completions are grouped for eight seconds, use normal urgency and expire after six hours. Browser Push topics coalesce stale duplicates;
- one pinned completion opens its exact Session. More than one ready pinned completion opens Home's priority focus as one grouped review alert;
- when the PWA is hidden but still running and no background subscription exists, a local service-worker fallback uses the same generic status-only copy;
- the installed-app badge mirrors the current pinned attention count when the browser exposes the Badging API;
- notification title, body, tag and target are bounded. Push payloads never contain a task title, prompt, response, command summary, output, cwd or approval action;
- the service worker accepts only an exact canonical task UUID or the bounded Home priority target as a destination. A tap focuses an existing Nerva window or opens the safe same-origin deep link;
- revoking a paired device removes its subscription. HTTP `404` or `410` from a Push service removes the expired subscription automatically.

Security and platform boundaries:

- there is deliberately no notification action button. In particular, an approval cannot be accepted or rejected from the Lock Screen; tapping only opens the exact decision context in Nerva;
- the bridge accepts subscription endpoints only from the known Apple, Google and Mozilla Push service hosts, preventing the subscription API from becoming a general server-side request primitive;
- VAPID private keys and subscriptions live in `~/Library/Application Support/CodexPad/security/` as atomically replaced mode-`0600` files. The browser endpoint and subscription keys are never returned by the status API;
- notification preferences remain part of synchronized Product State. `Waiting for your answer` is enabled by default only for new state; an existing explicit preference is preserved;
- the reliable native transition source currently covers the six Codex Micro slots. A task known only through the wider catalog cannot yet produce a blocking/completion Push event because its detailed state is not independently proven;
- real fully suspended delivery, Focus routing, badge behavior, duplicate handling and long-suspension behavior still require the physical iPad checklist. Browser automation does not prove them.

Web Push on iOS/iPadOS requires an installed Home Screen web app and a permission request initiated by a direct user gesture. It uses the standards Push API and integrates with iPadOS notification settings and Focus; no Apple Developer membership is required for this standards path. See [WebKit — Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) and [Apple — Sending web push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers). Delivery headers and VAPID follow [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030), [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) and [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292).

Safari/iPadOS does not expose a dependable Vibration API for this installed web app. Nerva disables the Haptics setting when `navigator.vibrate` is missing and does not simulate a visual press as physical vibration.

## Context Room and Nerva Cards

The optional Context Room adapter is read-only. It accepts only one explicit loopback HTTP origin with no credentials, query or fragment, then fetches only `/api/health` with a short timeout. The browser receives a sanitized room basename, version, state and reason. A failed refresh may keep the last good display value marked unavailable; it grants no control authority.

Nerva Cards are strict versioned data documents with bounded text, metrics, progress, lists and status blocks. The schema has no HTML, JavaScript, CSS, URL, event-handler or arbitrary component escape hatch. Unknown or invalid documents render nothing. The current UI uses this foundation for Context Room health; a general agent/provider feed is not yet implemented.

## Proof boundaries

| Evidence | What it proves | What it does not prove |
|---|---|---|
| Type/unit tests | Validation, redaction and deterministic state behavior | Live Desktop ownership or iPadOS lifecycle |
| Chromium/WebKit Playwright | Browser layout and pointer/event flows at representative viewports | Physical Pencil, palm rejection, real notification delivery or Add to Home Screen persistence |
| Doctor/System Diagnostics | Current local structural checks and last runtime proof | An action not independently advertised for the exact task |
| Physical Mac/iPad checklist | The recorded hardware/version path | Other OS, Codex or device versions |

Use [`MANUAL_TEST_CHECKLIST.md`](./MANUAL_TEST_CHECKLIST.md) for the release verdict and [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) when a layer is degraded.
