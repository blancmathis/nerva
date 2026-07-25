# Contributing

Codex Pad accepts focused contributions that preserve its exact-thread and loopback-only safety boundaries. A feature is not complete because the interface looks connected; it needs evidence at the layer it claims to change.

## Development setup

Requirements are macOS, Node.js 22 or newer, npm, and a Codex Desktop installation for optional compatibility checks.

```bash
npm ci
npm run check
npm test
npm run build
```

Start both development processes with:

```bash
npm run dev
```

Run `npm run doctor` before investigating a Desktop integration failure. The opt-in real integration test creates a disposable app-server thread and should be run only when that side effect is acceptable:

```bash
npm run test:integration
```

Do not run a standalone writer against an active Desktop thread. Do not restart Codex, bootstrap a managed daemon, set `launchctl` environment values, or expose a service through Tailscale without the user's explicit awareness.

## Repository guide

- `apps/bridge`: authenticated loopback server, state service, pairing, upload handling, idempotency, setup, and doctor.
- `apps/web`: React PWA, pairing, current Home/Session surfaces, recovery behavior, drawing/review workflows and IndexedDB drafts.
- `packages/protocol`: browser/bridge runtime contracts.
- `packages/codex-desktop`: undocumented renderer compatibility adapter.
- `packages/drawing`: deterministic scene and export primitives.
- `docs/adr`: decisions and proof boundaries.

Read the [confirmed product target](docs/product/INDEX.md), [Architecture](docs/ARCHITECTURE.md), [Security](SECURITY.md), and [Compatibility](docs/COMPATIBILITY.md) before changing integration code. Technical documents describe the current implementation unless they explicitly point to a target requirement.

## Change rules

- Keep changes small and use existing patterns, schemas, and error types.
- Preserve the distinction between native status, visual status, bridge health, and freshness.
- Never infer a thread from a title, selected window, recent list, database row, or fallback session.
- Never expose generic CDP evaluation, shell execution, arbitrary paths, URLs, or event names.
- Never weaken Origin, bearer/ticket authentication, pairing, credential, upload, or command validation to simplify a test.
- Never log prompts, responses, source code, images, full thread IDs, pairing codes, or credentials.
- Keep dependencies local at runtime. Do not add a CDN, telemetry, cloud database, or hosted authentication provider.
- Keep the native six slots authoritative for current native Micro controls only. A target session outside those slots must use an exact authenticated Mac-issued session/composer identity; review decks, saved drawings, site frames, layout boxes, titles, focus and visual selection can never become implicit routing authority.
- Keep layout presentational. `Automatic by Status` may place cards from a reliable Codex status, but neither manual placement nor an automatic section may set or infer Codex state. Do not add Kanban mutations, background task orchestration, an IDE, a terminal, or a general-purpose prompt queue.
- Treat media as sensitive untrusted input. Do not fetch a client-provided arbitrary URL or silently select a frame. The PWA must never request microphone access, record/store audio, run browser speech recognition, or route transcripts. Dictation may only invoke a freshly verified native Codex action for the exact selected task; Desktop owns the Mac microphone and transcription.
- Keep generated app-server schemas out of Git. Generate them from the installed Desktop-bundled Codex binary into an application cache or temporary directory.
- Create original UI and icons. Do not copy OpenAI, Work Louder, Apple, or reference-project branding or artwork.

## Testing expectations

Run the nearest focused test while iterating. Before proposing a change, run:

```bash
npm run check
npm test
npm run build
npm run audit:release
```

Use `npm run validate` for the complete local gate. Report every command actually run and separate:

- unit or fake-server proof;
- local browser proof;
- isolated installed app-server proof;
- live Codex Desktop proof;
- real iPad/Tailscale proof.

Do not label one category as another.

Additional requirements by area:

| Area | Required evidence |
| --- | --- |
| Protocol | Schema accept/reject tests, idempotency behavior, and backward-compatible parsing where intended. |
| Native adapter | A redacted compatibility fixture, dynamic-discovery fallback test, loopback target test, and explicit degraded result. |
| Thread transport | Fake app-server handshake, resume, idle start, busy routing, timeout, and cleanup tests. A real integration result is supplemental. |
| Pairing/security | Pairing expiry/reuse rejection, bearer storage, one-use WebSocket tickets, rate limiting, revocation, exact Origin, and active-socket closure tests. |
| Drawing | Scene round-trip, pointer pressure fallback, bounds, export limits, and draft restoration. |
| Multi-frame/comparison | Per-frame and total limits, provenance, retained-item deletion to omit media, deterministic comparison/export, and no partial fallback send. |
| Native dictation | Exact selected-task binding, live keycap/action revalidation, one native dispatch, stale/unverified fail-closed behavior, and `Permissions-Policy: microphone=()` with no PWA media API use or voice persistence. |
| Home/session catalog | 0–12 pin bounds, manual section/case persistence, exact manual restoration after automatic mode, no status mutation, Unpinned completeness, Product State revision conflicts and strict distinction from native-slot authority. |
| Saved Drawings | Strict scene/PNG validation, private atomic storage, 48/8 MiB/128 MiB limits, thumbnail-only list, independent working copies and explicit deletion. |
| PWA | iPad portrait/landscape browser tests, reconnect reconciliation, accessibility, and reduced-motion behavior. |
| Hardware behavior | A completed copy of the manual checklist with versions and evidence. |

## Compatibility changes

Codex Desktop internals are versioned fixtures, not a stable API. A compatibility change must:

1. record the tested Desktop and bundled Codex versions;
2. avoid current asset hashes or minified export names when structural discovery is possible;
3. add or update a synthetic/redacted fixture;
4. make an unknown shape degrade safely;
5. update `docs/COMPATIBILITY.md` and the relevant ADR;
6. avoid committing extracted proprietary application assets or generated OpenAI protocol code.

Capture only the smallest structure needed for a fixture. Remove titles, prompts, paths, IDs, and tokens.

## Documentation and attribution

Documentation should state current truth, planned behavior, and unproven hardware/runtime behavior separately. Link to source evidence in `docs/research.md` and record substantial MIT adaptations in `THIRD_PARTY_NOTICES.md` with upstream URL, revision, copyright, license, and adapted files.

After changing any production dependency, run `npm run licenses:generate` and
review the resulting `THIRD_PARTY_LICENSES.json` plus the direct-dependency table
in `THIRD_PARTY_NOTICES.md`. A standalone binary or installer must also retain
the upstream license/notice files and the sharp/libvips native component terms;
the source release audit does not certify that packaging format.

Do not import code from a reference repository whose license or asset provenance is unclear. Architectural inspiration may be described without copying implementation.

## Pull request checklist

- The change has a single clear outcome.
- Security and exact-thread invariants still hold.
- New behavior is runtime-validated.
- Tests cover success, stale state, malformed input, and failure cleanup.
- The focused diff contains no generated schemas, proprietary assets, personal paths, secrets, or fixture prompts.
- Documentation describes the actual proof level.
- `npm run validate` is green, or the exact missing check is stated.

By contributing, you agree that your contribution is licensed under this repository's MIT License.
