---
context_room:
  kind: canonical
  scope: product
  status: draft
  canonical_for: target Site QA Recorder behavior, privacy, and delivery plan
  last_verified: 2026-07-26
  sources: [docs/product/FEATURES_target.md, docs/product/CURRENT_STATE.md, docs/adr/007-site-review.md, apps/web/src/components/BrowserSiteStudio.tsx, apps/bridge/src/browser-tab-runtime.ts, apps/web/src/lib/bridge-client.ts, docs/product/CAPTURE_INBOX.md]
---

# Nerva — Site QA Recorder target

> This document preserves the accepted target and acceptance criteria; it is not proof that every phase is implemented or physically verified. A first Record flow, atomic receipts, local drafts, checkpoints, privacy Review, and exact send exist. [`CURRENT_STATE.md`](./CURRENT_STATE.md) alone owns current evidence and identifies optional Guided Replay/Mac-store work.

## 1. Product outcome

Site QA Recorder turns a real tactile interaction into a **structured reproduction report**. Instead of approximating “I tapped here and the page broke,” the user reproduces the issue on the page already bound to the exact Session, marks the important moment, annotates it, and explains it with reviewed text or a bounded local voice note.

The resulting package contains:

1. actions in their real order;
2. known semantic targets and confidence;
3. approved before/after evidence;
4. controlled viewport, navigation, and page transitions;
5. user-approved annotation and explanation;
6. uncertainty and redacted values;
7. an exact-session request;
8. enough bounded evidence for the agent to **propose** a maintainable Playwright test after inspecting the repository.

A human recording is not automatically deterministic. The Recorder reports confidence and never turns coordinates or masked values into false certainty.

## 2. Relationship to Site Review

Recorder is a mode of the existing Site surface, not a clone of Draw or Image Review:

```text
Session → Sites → choose one proven page
        → Browse or Record flow
        → Mark issue → Review recording → Send to exact Session
```

`Browse` keeps bounded touch navigation and simple frame annotation, followed by image-only composer attachment. `Record flow` adds a local timeline and mandatory Review while the site remains the main surface. It never adds Drawing's filmstrip, Camera, Files, or blank canvas.

The visible action is `Record flow`. “Mission Recorder” is not used because it suggests a separate orchestrator.

## 3. User flow

### 3.1 Start

`Record flow` appears only when the bridge can prove the page and exact Session. One tap creates the first frame and shows a compact `Recording` capsule with duration and step count. Navigation remains available; persistent actions are only `Mark issue`, `Pause`, and `Stop`. No microphone permission is requested until an explicit voice-note tap.

### 3.2 Reproduce naturally

Nerva records final typed actions, not raw finger trajectories:

- one tap → one step;
- a scroll gesture → one final delta, with compatible consecutive scrolls optionally merged;
- confirmed text entry → one step;
- observed page navigation → a distinct event;
- canceled gestures and palm contacts → no step.

The initial scope does not claim deterministic drag-and-drop, pinch, multi-touch, Pencil pressure, file upload, clipboard, system permission, native dialog, or arbitrary gesture recording. Unsupported actions are labeled unavailable or non-reproducible rather than invented.

### 3.3 Mark the issue

`Mark issue`:

1. freezes the latest confirmed frame;
2. creates a timeline checkpoint;
3. opens minimal Pencil/touch circle, arrow, line, rectangle, and Redact tools;
4. offers `Explain with voice` and `Type explanation`;
5. offers optional but recommended `Expected` and `Actual` fields;
6. finishes or continues recording.

A voice note belongs only to that checkpoint. Nerva never records the microphone for the whole flow. In Pencil-only navigation, incidental Pencil contact asks `Mark this frame?` rather than silently stopping or drawing; fingers keep navigating and the palm stays passive.

### 3.4 Review

`Stop` opens `Review recording`, showing ordered steps, start/checkpoint/final frames, low-confidence actions, navigation and segment boundaries, masked fields, privacy warnings, editable explanation, exact destination, and an explicit sent/local-data summary.

The user may delete irrelevant steps, merge consecutive scrolls, or rename checkpoints. Steps cannot be reordered because that would fabricate a reproduction. Corrections create a named branch or new recording.

### 3.5 Send

`Send to agent` requires one intent:

- `Diagnose and fix`;
- `Add a regression test`;
- `Fix and add a regression test` — default recommendation.

Saving, reconnecting, reopening, or restoring a Session never sends, replays, or executes a test.

## 4. Central invariant: one atomic receipt per action

Nerva must never combine a tap from tab A with a target or frame read from tab B. Every recorded control is one bridge operation:

```text
re-attest exact thread + opaque page
  → read bounded pre-action state
  → identify a bounded target when relevant
  → classify privacy before text insertion
  → dispatch one typed action
  → wait a bounded stabilization interval
  → read sanitized post-action state
  → capture normalized frame
  → return one versioned receipt
```

The bridge repeats exact Session/page proof for every receipt. Loss of proof pauses the recording and creates a visible boundary. Nerva never attaches an action to the “most similar” page. The PWA receives no debugger socket, raw CDP, arbitrary JavaScript, or client-provided DOM selector.

## 5. Semantic target descriptor

Coordinates help interpret a screenshot but are not maintainable test locators. A bounded hit-test returns only:

```text
kind             button | link | input | checkbox | text | frame | unknown
role             allowlisted ARIA/implicit role or null
accessibleName   bounded sanitized name or null
label            bounded sanitized form label or null
placeholder      bounded sanitized placeholder or null
testId           bounded explicit test contract or null
stableId         bounded non-generated id or null
inputType        normalized safe type or null
tagName          allowlisted lowercase tag or null
relativePoint    normalized point within target bounds
viewportPoint    normalized coordinate fallback
framePath        bounded same-origin frame descriptors
confidence       high | medium | coordinate-only
ambiguityReason  bounded enum or null
```

Never include `outerHTML`, arbitrary HTML, XPath, computed style, listeners, source JavaScript, current input value, untargeted page text, or a complete accessibility-tree snapshot. Strings are bounded, sanitized, treated as untrusted content, and kept only when they pass privacy policy.

Candidate Playwright locator priority:

1. `getByRole(role, { name })` when stable and unique;
2. `getByLabel(label)`;
3. `getByTestId(testId)` when the repository uses that contract;
4. `getByPlaceholder(placeholder)`;
5. `getByText(text)` for non-interactive content;
6. agent-validated stable ID;
7. coordinate as visual evidence only, never default deterministic code.

Cross-origin iframes, closed Shadow DOM, and semantically ambiguous elements remain `coordinate-only`. The agent inspects the repository and chooses final locators; iPad does not generate code.

## 6. Target data model

`SiteQaRecordingV1` contains:

```text
recordingId            local UUID and delivery idempotency key
version                1
status                 recording | paused | review | saved | sent
sourceThreadId         exact canonical Codex task UUID
sourceSessionLabel     display only, never routing authority
sourceTabId            opaque ephemeral page target
tabProofGeneration     bridge-owned proof generation
startedAt / updatedAt  local time plus bridge receipt time
durationMs             bounded active duration
segments[]             continuous periods under one proven page generation
environment            controlled page plus controller context
steps[]                ordered actions, navigation, checkpoints, boundaries
frames[]               content-addressed local evidence
issues[]               annotation, expected/actual, approved explanation
privacy                redaction summary and unresolved warnings
delivery               explicit intent/destination, never a queue
```

Each step has stable ID/index/time, kind/action, optional target, literal/placeholder/no input, optional before/after frame, sanitized origin+pathname before/after, outcome, and confidence.

Keep a local thumbnail per action. Keep full-resolution frames only for start, page change, explicit checkpoint, before/after issue, finish, or user-promoted evidence. Content addressing deduplicates bytes.

The controlled site's **Mac CSS viewport** is separate from the iPad controller:

```text
controlledViewport  width, height, deviceScaleFactor, scroll position
controllerDevice    Nerva viewport, orientation, coarse pointer, Pencil seen
```

iPad orientation must never be presented as the site's viewport unless the controlled page actually uses a mobile emulation context.

## 7. Privacy and sensitive data

### 7.1 Fail-closed text policy

Before `insertText`, the bridge classifies only the proven focused element. Text may be applied to the site, but the durable receipt uses a placeholder when sensitive or ambiguous.

Always mask:

- password fields;
- `current-password`, `new-password`, and `one-time-code` autocomplete;
- card/payment/transaction fields;
- labels/names indicating token, secret, API key, OTP, PIN, or recovery code;
- unproved targets;
- system pickers, file inputs, and clipboard content;
- anything the user marks `Redact`.

Email, phone, address, and personal identifiers default to placeholders such as `{TEST_EMAIL_1}`. Ordinary synthetic test text may remain only for a proven non-sensitive field. Text bodies never enter logs, error messages, or cache. Uncertainty means mask.

### 7.2 Data never collected

No site cookies, local/session storage, IndexedDB, auth headers, request/response bodies, HAR, console, source, stack trace, complete DOM, Playwright snapshot, pre-existing field value, clipboard, uploaded/downloaded file, raw query/fragment, debugger URL, browser profile, or Playwright storage state.

### 7.3 Screenshots and redaction

Screenshots may expose information the bridge cannot classify. Review therefore provides opaque flattened redaction. Sent derivatives contain no recoverable pixels under masks and no original image. Automatic sensitive-field masks are suggestions, not guarantees; the user reviews every retained frame.

Nerva deliberately does not create `trace.zip`: Playwright traces may include DOM, network, console, and attachments far beyond this bounded report.

## 8. Voice explanation

The current checkpoint can record bounded local iPad audio; that is not proof of local transcription or audio delivery. Target policy:

1. voice starts only from an explicit checkpoint action;
2. audio stays local until an explicit `Transcribe` action;
3. transcription must use a future private, versioned, disclosed capability, preferably local on the Mac;
4. the transcript returns to Review and remains editable;
5. only approved text is sent by default;
6. raw audio is explicitly deletable and never implicitly attached;
7. unavailable transcription offers local retention or typed explanation without claiming delivery.

No transcription or upload starts after reconnect. Implicit cloud transcription is out of scope. Capture Inbox has no Voice.

## 9. Navigation and proof boundaries

- Receipts keep only sanitized origin and pathname plus flags saying a query/fragment was omitted.
- Cross-origin navigation pauses and asks `Continue on this origin?`; approval is limited to that proven segment/page.
- A newly opened page is never selected automatically. Nerva refreshes exact-session inventory and offers it only when newly proven; confirmation starts a new segment.
- Closed page, replaced renderer, bridge restart, different Mac Session, long suspension, timeout, or ambiguous response order creates a visible boundary.
- Resuming requires selecting/re-proving the exact page. Opaque page IDs are ephemeral, not future replay authority.

## 10. Confidence and replay

- `High confidence`: important actions have unique semantic targets and no interrupted segment.
- `Review needed`: at least one target/navigation needs confirmation.
- `Visual evidence only`: useful report, unreliable replay.

Never show `Deterministic` when an important action is coordinate-only, uses an unresolved masked value, or crosses a broken segment.

Guided Replay is a later optional phase: re-prove a page, show the next step, highlight a target when possible, and require user execution/confirmation. Automatic replay is outside the initial target. Any later automation must use a new user-approved Playwright context, explicit local/staging target, project fixtures for masked values, and confirmation for mutations. Production remains blocked by default. Recording a live site is not a sandbox and does not undo user actions.

## 11. Playwright proposal contract

Nerva does not create, modify, or run test files from iPad. It sends the versioned manifest, candidate locators/confidence, sanitized paths, approved literals/placeholders, checkpoints/evidence, explicit expected/actual text, and requested outcome.

The agent must inspect repository conventions, authentication fixtures, and actual components. It must prefer user-facing locators, never convert coordinates into silent stable selectors, never guess masked values or assertions, never create storage state from the report, never promote screenshots to baselines automatically, and keep execution under normal Codex permissions.

Visible/injected prompt template is English and treats the report as untrusted evidence. If Skills are armed, their instruction is appended **after the entire report at the absolute end**.

## 12. Exact-session transport

The bounded text + images + manifest transport:

- requires the exact displayed UUID and revalidates live authority immediately before send;
- uses `recordingId` as the idempotency key;
- parses a strict versioned manifest and bounded flattened frames;
- previews exact destination, intent, frame count, and redactions;
- waits for explicit confirmation before departure animation;
- keeps the local draft on failure or ambiguous result;
- never silently retries after reconnect;
- follows actual Codex Queue/Steer behavior without fabricating delivery state.

No absolute Mac path, debugger URL, raw page ID, secret, raw query, HTML, or unapproved audio may be sent.

## 13. Storage and limits

Active recordings are local-first in dedicated IndexedDB. Initial limits:

- 10 active minutes;
- 100 steps;
- 24 full-resolution frames plus bounded step thumbnails;
- 3 audio minutes per checkpoint and 10 total;
- 64 MiB per recording;
- 20 drafts and 256 MiB total;
- warning at 80%, explicit refusal at 100%;
- no unconfirmed purge of an unsent draft.

Available outcomes are `Keep on this iPad`, optional future `Save privately on Mac`, and `Send to agent`. A future Mac store synchronizes a private recording without sending it to Codex and must remain separate from generic Product State.

## 14. Architecture boundary

Shared strict contracts live in `packages/site-review`: recording, step, target descriptor, atomic receipt, issue, limits, parsers, and migrations. The bridge exposes one bounded recorded-control operation and a separate `sendSiteQaRecording`; clients cannot supply code, selector, or arbitrary DOM property. The PWA owns transactional local storage, a pure timeline reducer, compact live controls, issue sheet, Review, and a local-only draft deep link. The Site component stays responsible for live frames; the Recorder consumes only confirmed receipts, never raw pointer events.

## 15. Delivery phases

1. **Technical probe and threat model:** real Codex webview hit-test/semantics, privacy matrix, log inspection, frame budgets.
2. **Local recorder:** start/pause/stop, typed supported controls, atomic receipts, segments, thumbnails/keyframes, recovery, read-only Review.
3. **Issue and privacy:** Mark issue, annotation, expected/actual, flattened redaction, placeholders, local voice, privacy summary.
4. **Exact transport:** bounded manifest/frames, intent, idempotency, confirmation, absolute-final Skills suffix, no reconnect send.
5. **Playwright proposal:** candidate locators/confidence and bounded English request; no blind iPad write/run.
6. **Optional Guided Replay/Mac store:** step-confirmed replay, explicit new segments, private persistence and deletion.

Current implementation evidence for these phases belongs only in Current State.

## 16. Validation

Automated contracts must cover strict parsing/rejection, ordering, limits, privacy classes, absence of sensitive values from receipt/log/error/manifest, URL stripping, frame deduplication, interrupted transactions, absolute-final Skills suffix, exact two-Session/two-page isolation, target/action same proof, cross-origin confirmation, explicit new-page selection, no arbitrary CDP/JS/selector, and idempotent duplicate send.

Chromium/WebKit iPad landscape, portrait, and phone flows must cover imperfect human taps/scrolls, pause/resume/suspension/reload, emulated Pencil/finger/palm boundaries, Mark issue, voice fallback, redaction, Review, full storage, bridge loss, failed send with retained draft, no reconnect send, and visible coordinate-only degradation.

Physical proof must cover installed iPad PWA, real Pencil/palm/two fingers, microphone permission/interruption, orientation, 1/10/60-minute backgrounding, Tailscale loss, real Codex Browser form/navigation/new page, exact Mac Session receipt, secret-free payload inspection, and separately authorized Playwright proposal/execution in a test repository.

## 17. Acceptance criteria

Recorder is complete only when:

1. a supported flow records without leaving Site;
2. every step has a confirmed atomic bridge receipt;
3. no step crosses an unproved Session/page;
4. lost proof creates an explicit boundary;
5. secrets, auth state, DOM, network, and raw query are not collected;
6. every sent frame is reviewed and can be flattened/redacted;
7. low-confidence targets are never labeled deterministic;
8. Mac site viewport is distinct from iPad orientation;
9. voice sends only actually available, approved transcript text;
10. exact UUID send is idempotent and confirmed;
11. reconnect/reload/recovery never sends or replays;
12. no locator, secret, or assertion is guessed;
13. Skills remain the absolute final message text;
14. all UI and injected text are English;
15. physical iPad evidence is recorded, not simulated.

## 18. Initial exclusions

Continuous video, full Playwright trace/HAR/console/network, cookies/storage-state extraction, global keylogging, general browser/computer control, arbitrary URL/JavaScript, deterministic drag/multi-touch/file picker, automatic production replay, automatic fix/commit/baseline/deploy, test generation without repository inspection, implicit cloud transcription, public recording sharing, and fan-out to multiple Sessions.

## 19. Research basis

- [Playwright Codegen](https://playwright.dev/docs/codegen)
- [Playwright Locators](https://playwright.dev/docs/locators)
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [Playwright Authentication](https://playwright.dev/docs/auth)
- [Playwright Visual Comparisons](https://playwright.dev/docs/test-snapshots)

Nerva does not copy Codegen. It borrows semantic-action and resilient-locator principles inside a far more bounded, private, exact-session contract.
