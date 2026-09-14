---
context_room:
  kind: canonical
  scope: release-readiness
  status: current
  canonical_for: production-readiness evidence and remaining acceptance gates
  last_verified: 2026-09-14
  sources: [.github/workflows/ci.yml, apps/web/e2e/production-readiness.spec.ts, docs/product/CURRENT_STATE.md, docs/MANUAL_TEST_CHECKLIST.md]
---

# Nerva production-readiness audit

Source and installation rechecked: 14 September 2026. This is a source-quality and installation audit, not a production release certificate. It includes one bounded current-version schema-cache repair; it does not include a Desktop restart or candidate deployment.

## Decision

**Do not mark the current installation as fully production-ready.** The software candidate must pass every CI group, and the native/runtime and physical-device gates below remain separate requirements. A healthy loopback bridge or a green fixture test cannot establish a working paired iPad or authorize exact-task native actions.

The existing Mac installation was inspected without replacing its running bridge, restarting Codex Desktop, changing Tailscale routes, editing ownership attestations or sending commands to real user tasks. Its health result is therefore not evidence that this branch has been deployed.

## Corrections in this candidate

Activity now exposes a visible single-tap actions button as well as long press. Both the trigger and menu actions have at least 44 CSS-pixel touch targets. Conversation titles and project/status metadata are more legible; the scrolling conversation list has an opaque content surface. Menus support arrow keys, Home, End, Escape and leaving with Tab. Closing or pinning returns focus to the correct trigger, and opening an actions menu does not dispatch a task command. Normal conversation taps remain available while an explicit menu is open.

Modal focus management skips disabled and hidden controls, respects events already handled by an inner control, confines programmatic focus, and gives the uppermost nested dialog sole keyboard ownership. Keyboard navigation reveals offscreen controls rather than preserving a scroll position that hides focus. Closing an inactive-but-still-mounted dialog restores its trigger without stealing focus from a replacement dialog.

An actually empty conversation catalog now explains how to start a conversation instead of incorrectly saying that everything is pinned. Browser unit tests explicitly use the JSDOM origin's storage, avoiding Node 26's unrelated host Web Storage globals.

The Activity geometry regression now waits for finite animations to settle instead of sampling after an arbitrary 350 ms delay. Its original 44-pixel minimum assertion is retained. The last baseline CI failure sampled a height of 43.99957275390625 pixels during an animation; that timing failure and the genuinely undersized 38-pixel menu actions are distinct issues.

The resumed visual review also found the pairing heading displaying “Connect to 127” on loopback. Pairing now formats DNS machine labels and uses “your Mac” for local/IP addresses instead of truncating an address. This is display-only: exact-origin invitation checks are unchanged.

Camera startup now has a disabled “Starting camera…” state and an immediately available Cancel control. A request-generation guard prevents duplicate permission requests, stops late streams after cancellation/unmount, and ignores stale playback/frame decoding. Active camera cancellation releases every track. Camera denial, unreadable preview and unexpected connection failures provide an actionable recovery message instead of an unhandled failure.

## Automated evidence and reproducibility

The focused pre-fix regression suite reproduced nine failures. All ten tests in that initial suite passed after correction. Additional regression tests cover ordinary row activation, genuinely empty catalogs, and browser storage under newer Node versions. Browser coverage includes explicit menu actions, exact-thread routing, small/rotated phone viewports, readable metadata and light-theme accessibility.

The resumed audit inspected [CI run 34782243398](https://github.com/blancmathis/nerva/actions/runs/34782243398) for candidate `116ad22` (tested merge `ecc6122`). All six mobile profiles, production bridge and public screenshots, Node 26 compatibility, and the macOS setup-check contract passed. The Node 22 quality job passed 1,124 unit tests (two opt-in live integration tests excluded), 19 probe-safety tests, type checking, build, bundle budget and the release audit. Its only failing step was Context Room: an audit note had been placed inside YAML front matter. The note is now outside the metadata block; the strict check remains enabled. The local strict Context Room check, documentation check and full dependency audit passed after correction, with zero reported dependency vulnerabilities. These results are not a passing result for the entire old CI run and do not establish native or physical-device acceptance.

On 14 September, three newly added camera-ownership tests failed against the previous implementation and passed after repair. The extended focused suite then passed all 28 tests (pairing, Activity and modal focus), and the web TypeScript check passed. The six-profile browser gate additionally checks pending-camera cancellation and the loopback machine label. See the checks attached to [PR #1](https://github.com/blancmathis/nerva/pull/1) for the final source revision rather than treating an earlier run as current evidence.

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

## Actual-installation findings — rechecked 14 September

Codex Desktop is `26.908.40834`, build `8881`, with bundled CLI `0.154.0-alpha.6.2`. The running managed app-server reports `0.153.4`; its read-only compatibility probe passes despite the version difference. This is not proof of Desktop mutation authority.

The earlier 13 September observations of an unavailable standalone CLI, unresponsive managed probe and unproven private route are superseded by the fresh checks below. `setup-check --json` now reports `limited` with no installation blockers. `doctor --strict-native --json` still fails the full-native gate, as intended.

The documented `setup --generate-schemas --json` command generated 426 schema files from the exact installed Desktop binary. A subsequent diagnostic reports the current-version schema check green. No task command, Desktop restart, managed daemon bootstrap, ownership attestation, pairing rotation, or Tailscale route change was performed. Private diagnostic output remains outside the public repository.

| Gate | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Existing loopback bridge | Health responds on a verified loopback listener | Deploy and verify the candidate's actual coordinated web/bridge revision. Existing health is not candidate deployment evidence. |
| Private filesystem and exposure | Inspected state is owner-only; Funnel is disabled for the configured route | Preserve these constraints. Never expose CDP beyond loopback. |
| Current-version protocol schemas | Repaired; 426 files generated from the installed binary, then validated by doctor | Revalidate after any installed Codex update. |
| Managed app-server / standalone CLI | Standalone tooling is found; managed read-only compatibility passes | Reconcile the running/new binary versions during the coordinated native validation. A read-only pass does not authorize mutation. |
| Desktop ownership | No positive current Desktop-owned peer proof | Establish the supported managed connection and validate ownership through the normal tooling. Never hand-edit an attestation. |
| Native Desktop discovery | CDP and the native six-slot adapter remain unavailable/degraded | Save active work before an explicitly authorized Desktop relaunch; repeat strict diagnostics and exact-task acceptance. |
| Private HTTPS/WSS | Exact Serve route and same-origin WSS upgrade pass from the Mac; unauthenticated connection closes before data | Verify the paired physical device over its actual private network. |
| Physical iPad/iPhone acceptance | Not performed in this audit | Verify pairing, installed PWA behavior, sleep/resume, camera permissions, Pencil/palm rejection and supported notification/voice paths on real hardware. |

A full production rollout must satisfy the remaining native gates, deploy a coordinated source revision, and run the product's exact-task acceptance scenarios on the physical devices. No stable release tag, auto-merge or deployment is created by this audit. The historical evidence in [Current state](CURRENT_STATE.md) is not a substitute for current-binary and physical-device acceptance.
