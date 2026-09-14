---
context_room:
  kind: canonical
  scope: release-readiness
  status: current
  canonical_for: production-readiness evidence and remaining acceptance gates
  last_verified: 2026-09-14
  sources: [.github/workflows/ci.yml, apps/bridge/src/web-build-snapshot.ts, apps/bridge/src/mac-setup.ts, apps/bridge/test/mac-setup.test.ts, apps/bridge/test/server.test.ts, apps/web/src/lib/home-layout-storage.ts, apps/web/src/lib/home-layout-storage.test.ts, apps/web/e2e/production-readiness.spec.ts, docs/product/CURRENT_STATE.md, docs/MANUAL_TEST_CHECKLIST.md]
---

# Nerva production-readiness audit

Source and installation audit, with deployment follow-up: 14 September 2026. This is a source-quality and installation audit, not a production release certificate. It includes a bounded current-version schema-cache repair and a coordinated web/bridge deployment. Desktop reconnection and physical acceptance still require their own evidence.

## Decision

**Do not mark the current installation as fully production-ready.** The software candidate must pass every CI group, and the native/runtime and physical-device gates below remain separate requirements. A healthy loopback bridge or a green fixture test cannot establish a working paired iPad or authorize exact-task native actions.

The initial installation findings below precede deployment. The first follow-up deployed `41a2314`; the pin-persistence correction subsequently deployed `0b8ec23`, whose source tree is identical to merge commit `4fb257a`. Both candidate CI runs and the final merge-commit run passed for the pin correction. Desktop ownership and full physical acceptance remain unverified.

## Corrections in this candidate

The Mac follow-up also exposed service scheduling starvation. With launchd's `Background` classification, the running bridge failed to open its port within five minutes under heavy Mac load. The same read-only diagnostic completed in 12 seconds when run normally; the same bridge started and served its assets in 15 seconds after classification as `Interactive`. A temporary background-priority adjustment alone had not resolved the problem. The [Mac installer](../../apps/bridge/src/mac-setup.ts) now generates `Interactive` service definitions and still recognizes the exact historical `Background` definitions for safe upgrade and removal. These timings describe this Mac under its observed load; automated configuration tests do not simulate macOS scheduling.

The installed bridge's health endpoint returned HTTP 200 while both the root page and the `app-meta.json` endpoint returned HTTP 404. The process-scoped PWA snapshot was stored in operating-system temporary space, and its required files were absent during inspection. The [web snapshot](../../apps/bridge/src/web-build-snapshot.ts) now lives in Nerva's private runtime directory, under the exclusive bridge lifetime lease, so operating-system temporary-file cleanup cannot remove a running installation's assets. It retains the existing build-identity and content checks and is removed when that bridge closes. The [server regression](../../apps/bridge/test/server.test.ts) verifies private storage, HTML and JavaScript availability after build scratch space is removed, and cleanup on shutdown. Deployment verification must fetch the PWA and its assets as well as the health endpoint.

The post-merge iPhone gate exposed an interrupted-write defect: removing a pin, then immediately reloading, could load an older IndexedDB copy and overwrite the newer Mac layout. [Home layout recovery](../../apps/web/src/lib/home-layout-storage.ts) now prefers the copy written synchronously before the asynchronous IndexedDB transaction. If local storage rejects a write, its obsolete copy is removed so IndexedDB remains a usable fallback. [Regression tests](../../apps/web/src/lib/home-layout-storage.test.ts) reproduce an interrupted IndexedDB update and cover storage quota failure, IndexedDB-only recovery and unreadable local data. No browser assertion, timeout or retry policy is weakened.

Push and pull-request CI runs now have distinct concurrency groups. Previously they cancelled each other for the same revision, leaving a failed required aggregate beside the successful run and blocking merge. New pushes still cancel obsolete runs of the same event type; the required aggregate continues to reject any failed, skipped or cancelled validation group.

Activity now exposes a visible single-tap actions button as well as long press. Both the trigger and menu actions have at least 44 CSS-pixel touch targets. Conversation titles and project/status metadata are more legible; the scrolling conversation list has an opaque content surface. Menus support arrow keys, Home, End, Escape and leaving with Tab. Closing or pinning returns focus to the correct trigger, and opening an actions menu does not dispatch a task command. Normal conversation taps remain available while an explicit menu is open.

Modal focus management skips disabled and hidden controls, respects events already handled by an inner control, confines programmatic focus, and gives the uppermost nested dialog sole keyboard ownership. Keyboard navigation reveals offscreen controls rather than preserving a scroll position that hides focus. Closing an inactive-but-still-mounted dialog restores its trigger without stealing focus from a replacement dialog.

An actually empty conversation catalog now explains how to start a conversation instead of incorrectly saying that everything is pinned. Browser unit tests explicitly use the JSDOM origin's storage, avoiding Node 26's unrelated host Web Storage globals.

The Activity geometry regression now waits for finite animations to settle instead of sampling after an arbitrary 350 ms delay. Its original 44-pixel minimum assertion is retained. The last baseline CI failure sampled a height of 43.99957275390625 pixels during an animation; that timing failure and the genuinely undersized 38-pixel menu actions are distinct issues.

The resumed visual review also found the pairing heading displaying “Connect to 127” on loopback. Pairing now formats DNS machine labels and uses “your Mac” for local/IP addresses instead of truncating an address. This is display-only: exact-origin invitation checks are unchanged.

Camera startup now has a disabled “Starting camera…” state and an immediately available Cancel control. A request-generation guard prevents duplicate permission requests, stops late streams after cancellation/unmount, and ignores stale playback/frame decoding. Active camera cancellation releases every track. Camera denial, unreadable preview and unexpected connection failures provide an actionable recovery message instead of an unhandled failure.

QA voice notes now have explicit requesting/recording/stopping states and microphone ownership scoped to the visible checkpoint, exact task and tab. Cancel, leaving the checkpoint, a task/tab change and unmount invalidate pending permissions and release the microphone. Page hide stops capture, constructor/start/recorder errors release tracks, and a missing stop event cannot leave Save waiting indefinitely. Save waits for the final audio chunk; a failed active recording is not silently saved as a successful voice note. The existing three-minute limit and local-only audio policy are unchanged. Written reviewed explanations remain the only audio-derived text sent to an agent.

## Automated evidence and reproducibility

Both full candidate runs passed all 11 jobs at `41a2314`: [push validation](https://github.com/blancmathis/nerva/actions/runs/34825607330) and [pull-request validation](https://github.com/blancmathis/nerva/actions/runs/34825611520). Local validation at that revision passed 1,152 unit tests (two opt-in exclusions), 19 probe tests, 438 browser tests (24 explicit exclusions), six production-bridge tests, screenshots, build, bundle and release/dependency audits. One initial unit attempt exceeded a UI wait under parallel load; the isolated suite and complete unit suite with two workers passed without changing assertions. Context Room reported one route-reference warning, subsequently removed by clarifying that the metadata name is an HTTP endpoint.

The subsequent [merge-commit run](https://github.com/blancmathis/nerva/actions/runs/34826758029) failed the immediate-reload pin scenario on Chromium iPhone. Its trace shows the unpin reaching the Mac before reload, followed by a stale local layout overwriting it. This is recorded as a real persistence defect, not a passing run or a retry-only repair. The deterministic interrupted-write unit regression failed before the storage fix and passed afterward. The follow-up pull request's own checks establish validation of that correction.

The pin fix `0b8ec23` passed all 11 jobs in both [push](https://github.com/blancmathis/nerva/actions/runs/34828574197) and [PR](https://github.com/blancmathis/nerva/actions/runs/34828582494) runs. Its [merge-commit run](https://github.com/blancmathis/nerva/actions/runs/34829665740) also passed all 11 jobs. Local checks passed 1,156 unit tests (two opt-in exclusions), 18 immediate-reload browser checks across six profiles, six production-bridge tests, build and release checks. The service-scheduling follow-up requires its own checks; the installer tests reproduce the old classification and preserve recognition of both legacy service variants.

The focused pre-fix regression suite reproduced nine failures. All ten tests in that initial suite passed after correction. Additional regression tests cover ordinary row activation, genuinely empty catalogs, and browser storage under newer Node versions. Browser coverage includes explicit menu actions, exact-thread routing, small/rotated phone viewports, readable metadata and light-theme accessibility.

The resumed audit inspected [CI run 34782243398](https://github.com/blancmathis/nerva/actions/runs/34782243398) for candidate `116ad22` (tested merge `ecc6122`). All six mobile profiles, production bridge and public screenshots, Node 26 compatibility, and the macOS setup-check contract passed. The Node 22 quality job passed 1,124 unit tests (two opt-in live integration tests excluded), 19 probe-safety tests, type checking, build, bundle budget and the release audit. Its only failing step was Context Room: an audit note had been placed inside YAML front matter. The note is now outside the metadata block; the strict check remains enabled. The local strict Context Room check, documentation check and full dependency audit passed after correction, with zero reported dependency vulnerabilities. These results are not a passing result for the entire old CI run and do not establish native or physical-device acceptance.

On 14 September, three newly added camera-ownership tests failed against the previous implementation and passed after repair. The extended focused suite then passed all 28 tests (pairing, Activity and modal focus), and the web TypeScript check passed. The six-profile browser gate additionally checks pending-camera cancellation and the loopback machine label. See the checks attached to [PR #1](https://github.com/blancmathis/nerva/pull/1) for the final source revision rather than treating an earlier run as current evidence.

The 18 targeted browser regressions for Activity and pairing passed locally across all six profiles at `4031803`, without retries. Thirteen additional voice-ownership unit tests cover late grants, duplicate requests, cancellation, task changes, final chunks, recorder failures, bounded stop, capture duration and page hiding. A browser regression exercises pending/active microphone cancellation through the actual QA checkpoint UI with synthetic media APIs; it verifies that cancellation emits no task command. These synthetic microphone tests are lifecycle evidence, not a real-device recording attestation.

The combined pairing, Activity, modal-focus and voice-note unit suite passed 41 tests, with web TypeScript and strict documentation checks passing. The WebKit iPhone browser profile passed both the new checkpoint microphone-lifecycle regression and the existing full record → annotate → review → exact-task send flow. [CI run 34813562220](https://github.com/blancmathis/nerva/actions/runs/34813562220) is fully green for `4031803` before the voice-note hardening; the final voice-note revision requires its own full CI result.

The exact candidate's GitHub Actions run is the authoritative full-suite result. Local long-running attempts encountered timeouts under substantial machine load and must not be reported as complete passing runs. The audit recorded load averages above 40 on 14 logical CPUs and more than 7 GiB of swap usage; this is context for reproducing failures, not an exemption from the CI checks.

[CI](../../.github/workflows/ci.yml) runs these independent validation groups:

- Node 22 documentation, type checking, all unit/probe tests, coordinated production build, bundle budget, release/license audit, Context Room validation and dependency audit.
- The complete browser suite in all six existing profiles: Chromium and WebKit, each in iPad landscape, iPad portrait and iPhone. No retry or weaker geometry threshold is used.
- The real production-bridge boundary harness and the full synthetic public-screenshot generation check.
- The unit/probe suite on Node 26, plus the existing read-only macOS setup-check contract.

The original required-check name, `Node.js 22`, is retained as an aggregate gate. It fails unless every group, including every mobile matrix entry, succeeds; failed, skipped and cancelled groups cannot yield a passing result. Synthetic UI images and failure traces are retained as CI artifacts. They contain fixture data, not a captured user session.

To repeat the canonical local suite on a machine with sufficient resources:

```sh
npm ci
npx playwright install chromium webkit
npm run validate
npm run context-room:doctor
npm audit --audit-level=high
```

Read-only checks of the actual installation must be performed after building the source checkout, so a missing local `dist` directory is not misreported as a deployed-runtime defect:

```sh
npm run build
npm run setup:check -- --json
npm run doctor -- --strict-native --json
```

## Pre-deployment installation findings — rechecked 14 September

Codex Desktop is `26.908.40834`, build `8881`, with bundled CLI `0.154.0-alpha.6.2`. The running managed app-server reports `0.153.4`; its read-only compatibility probe passes despite the version difference. This is not proof of Desktop mutation authority.

The earlier 13 September observations of an unavailable standalone CLI, unresponsive managed probe and unproven private route are superseded by the fresh checks below. `setup-check --json` now reports `limited` with no installation blockers. `doctor --strict-native --json` still fails the full-native gate, as intended.

The documented `setup --generate-schemas --json` command generated 426 schema files from the exact installed Desktop binary. A subsequent diagnostic reports the current-version schema check green. No task command, Desktop restart, managed daemon bootstrap, ownership attestation, pairing rotation, or Tailscale route change was performed. Private diagnostic output remains outside the public repository.

| Gate | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Deployed loopback bridge and PWA | `0b8ec23` is installed; health and web metadata agree, HTML and both referenced assets return HTTP 200, and the snapshot is under private runtime storage with mode 0700. Its actual LaunchAgent uses `Interactive`. | Validate and deliver the matching installer update so future setup retains the responsive service classification. Health alone is insufficient. |
| Private filesystem and exposure | Inspected state is owner-only; Funnel is disabled for the configured route | Preserve these constraints. Never expose CDP beyond loopback. |
| Current-version protocol schemas | Repaired; 426 files generated from the installed binary, then validated by doctor | Revalidate after any installed Codex update. |
| Managed app-server / standalone CLI | Standalone tooling is found; managed read-only compatibility passes | Reconcile the running/new binary versions during the coordinated native validation. A read-only pass does not authorize mutation. |
| Desktop ownership | No positive current Desktop-owned peer proof | Establish the supported managed connection and validate ownership through the normal tooling. Never hand-edit an attestation. |
| Native Desktop discovery | CDP and the native six-slot adapter remain unavailable/degraded | Save active work before an explicitly authorized Desktop relaunch; repeat strict diagnostics and exact-task acceptance. |
| Private HTTPS/WSS | Exact Serve route and same-origin WSS upgrade pass from the Mac; unauthenticated connection closes before data | Verify the paired physical device over its actual private network. |
| Physical iPad/iPhone acceptance | An iPad Air 11-inch (M2), iPadOS 26.6.1, is paired and available over USB; physical interaction is not yet validated | Verify pairing, installed PWA behavior, sleep/resume, camera permissions, Pencil/palm rejection and supported notification/voice paths on real hardware. |

A full production rollout must satisfy the remaining native gates, deploy the validated follow-up revision, and run the product's exact-task acceptance scenarios on the physical devices. The first deployment encountered a transient launchd registration refusal; the old runtime was restored and checked before a bounded registration retry completed the validated installation. Configuration, credentials and the Desktop process were unchanged. No stable release tag has been created. The historical evidence in [Current state](CURRENT_STATE.md) is not a substitute for current-binary and physical-device acceptance.
