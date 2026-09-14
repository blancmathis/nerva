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

Installation observed: 13 September 2026. CI and documentation rechecked: 14 September 2026. This is a source-quality and read-only installation audit, not a production release certificate.

## Decision

**Do not mark the current installation as fully production-ready.** The software candidate must pass every CI group, and the native/runtime and physical-device gates below remain separate requirements. A healthy loopback bridge or a green fixture test cannot establish a working paired iPad or authorize exact-task native actions.

The existing Mac installation was inspected without replacing its running bridge, restarting Codex Desktop, changing Tailscale routes, editing ownership attestations or sending commands to real user tasks. Its health result is therefore not evidence that this branch has been deployed.

## Corrections in this candidate

Activity now exposes a visible single-tap actions button as well as long press. Both the trigger and menu actions have at least 44 CSS-pixel touch targets. Conversation titles and project/status metadata are more legible; the scrolling conversation list has an opaque content surface. Menus support arrow keys, Home, End, Escape and leaving with Tab. Closing or pinning returns focus to the correct trigger, and opening an actions menu does not dispatch a task command. Normal conversation taps remain available while an explicit menu is open.

Modal focus management skips disabled and hidden controls, respects events already handled by an inner control, confines programmatic focus, and gives the uppermost nested dialog sole keyboard ownership. Keyboard navigation reveals offscreen controls rather than preserving a scroll position that hides focus. Closing an inactive-but-still-mounted dialog restores its trigger without stealing focus from a replacement dialog.

An actually empty conversation catalog now explains how to start a conversation instead of incorrectly saying that everything is pinned. Browser unit tests explicitly use the JSDOM origin's storage, avoiding Node 26's unrelated host Web Storage globals.

The Activity geometry regression now waits for finite animations to settle instead of sampling after an arbitrary 350 ms delay. Its original 44-pixel minimum assertion is retained. The last baseline CI failure sampled a height of 43.99957275390625 pixels during an animation; that timing failure and the genuinely undersized 38-pixel menu actions are distinct issues.

## Automated evidence and reproducibility

The focused pre-fix regression suite reproduced nine failures. All ten tests in that initial suite passed after correction. Additional regression tests cover ordinary row activation, genuinely empty catalogs, and browser storage under newer Node versions. Browser coverage includes explicit menu actions, exact-thread routing, small/rotated phone viewports, readable metadata and light-theme accessibility.

The resumed audit inspected [CI run 34782243398](https://github.com/blancmathis/nerva/actions/runs/34782243398) for candidate `116ad22` (tested merge `ecc6122`). All six mobile profiles, production bridge and public screenshots, Node 26 compatibility, and the macOS setup-check contract passed. The Node 22 quality job passed 1,124 unit tests (two opt-in live integration tests excluded), 19 probe-safety tests, type checking, build, bundle budget and the release audit. Its only failing step was Context Room: an audit note had been placed inside YAML front matter. The note is now outside the metadata block; the strict check remains enabled. The local strict Context Room check, documentation check and full dependency audit passed after correction, with zero reported dependency vulnerabilities. These results are not a passing result for the entire old CI run and do not establish native or physical-device acceptance.

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

## Actual-installation findings

The read-only audit found Codex Desktop `26.908.40834`, build `8881`, with bundled CLI `0.154.0-alpha.6.2`. These installed-version observations do not establish compatibility with another update.

| Gate | Observed result | Required before a full production claim |
| --- | --- | --- |
| Existing loopback bridge | Health responds on a verified loopback listener | Deploy and verify the candidate's actual coordinated web/bridge revision. |
| Private filesystem and exposure | Inspected state is owner-only; Funnel is absent for the configured route | Keep those constraints; do not expose CDP or enable Funnel. |
| Current-version protocol schemas | No cache matching the installed CLI version | Generate and validate schemas from the exact installed binary; do not reuse old-version schemas. |
| Managed app-server and ownership | The installed binary's control probe does not answer; Desktop ownership is not positively established | Establish the supported managed connection and prove current Desktop ownership using the normal tooling. Never hand-edit an attestation. |
| Native Desktop discovery | CDP and the native six-slot adapter are unavailable/degraded | Use a controlled Desktop relaunch only after saving active work; repeat strict diagnostics and exact-task acceptance. |
| Required standalone tooling | The expected managed standalone CLI is unavailable | Complete the documented official installation path and rerun setup checks. |
| Private HTTPS/WSS | Tailscale is online, but the exact Serve route and same-origin WSS upgrade are not proven | Reconcile the route with the existing private services before changing anything; verify HTTPS, WSS and device access. |
| Physical iPad/iPhone acceptance | Not performed in this audit | Verify pairing, installed PWA behavior, sleep/resume, camera permissions, Pencil/palm rejection and supported notification/voice paths on real hardware. |

A production rollout must save active work, satisfy these remaining gates and run the product's exact-task acceptance scenarios. No stable release tag, auto-merge or deployment is created by this audit. The historical evidence in [Current state](CURRENT_STATE.md) remains useful but is not a substitute for current-binary and physical-device acceptance.
