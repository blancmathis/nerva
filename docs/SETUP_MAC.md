# Mac setup

> **Current implementation:** Nerva provides a read-only `npm run setup:check` preflight and one explicit `npm run setup:mac` installer. The base installation is independent from the version-sensitive native Codex integration: it creates private Nerva state, configures only an available exact Tailscale Serve route, installs the bridge LaunchAgent, waits for `/api/health`, and only then creates the pairing invitation. It does not require a separate macOS app. Technical paths and service identifiers retain the `CodexPad` / `codex-pad` compatibility name.

> **Current compatibility result (26 July 2026):** Desktop `0.146.0-alpha.3.1` and managed app-server `0.145.0` differ, but exact binary/schema fingerprints plus live read-only `initialize`, `thread/list` and `model/list` probes are compatible. Doctor reports **Ready with limitations** because exact-socket Desktop ownership and the native Micro adapter are not attested. Three unrelated stdio writers remain visible diagnostics; do not stop them merely to improve the report.

The preflight produces three operator-facing outcomes:

- **Ready:** the base prerequisites and native topology are compatible enough for setup to configure the managed daemon.
- **Ready with limited Codex controls:** the bridge, private route and pairing can be installed, but app-server-backed controls remain unavailable. Setup does not bootstrap a daemon, stop a writer, set a Desktop environment flag, create an ownership attestation or restart Desktop.
- **Blocked:** a base prerequisite or safety boundary prevents installation, such as unsupported macOS/Node, missing Desktop or Tailscale, active or ambiguous Funnel, a conflicting HTTPS route, an unsafe path, or a bridge that cannot become healthy.

The legacy `npm run setup` command remains inspection and Nerva-owned local-state setup. When and only when `setup:check` is **Ready**, `npm run setup:mac` may configure the managed daemon and GUI opt-in; it skips bootstrap when the existing daemon is already running and compatible. It never quits or relaunches Desktop, uses Funnel, resets unrelated Serve routes or kills an unknown writer. Default doctor exits zero for Ready and Ready with limitations; `npm run doctor -- --strict-native` is the maintainer/release gate.

## Fast path from a clone

Prerequisites: Node.js 22/npm, Codex Desktop, and Tailscale already installed and signed into the intended tailnet on both devices.

```bash
git clone https://github.com/blancmathis/nerva.git
cd nerva
curl -fsSL https://chatgpt.com/codex/install.sh | sh
npm run setup:check
npm run setup:mac
```

OpenAI's installer is the supported install/update path for the standalone package required by `app-server daemon`. A version-string mismatch alone is neither compatibility nor incompatibility proof; Nerva fingerprints both binaries, validates both generated schemas and probes the private daemon read-only after every change.

The bootstrap script performs `npm ci` when needed, builds the workspace, reruns the read-only preflight, and refreshes schema caches for both exact Codex binaries. A schema-generation failure cannot prevent the independent bridge/pairing installation, but the affected capability remains unavailable. The script then installs `~/Library/LaunchAgents/com.codex-pad.bridge.plist` with mode `0600`, establishes only the exact private route, verifies local bridge health, and prints the QR. Native daemon configuration is attempted only for a **Ready** preflight. If that later native step fails, setup finishes safely as **Ready with limited Codex controls** instead of discarding the working bridge and pairing path.

In a Ready native topology, setup removes the obsolete Nerva raw-listener LaunchAgent only when its exact old generated shape is recognized. It never removes an unknown service. The command waits for the iPad in the same terminal. Pressing `Ctrl-C` stops only the wait; the launchd bridge remains running.

For a later replacement or cleared iPad credential:

```bash
npm run pair
```

`npm run pair` depends on the installed, healthy bridge—not on a green native app-server topology. Both commands fail closed if Tailscale is offline, Funnel is not authoritatively disabled, HTTPS port 443 is already owned by another route, the built CLI path is unsafe or the bridge cannot become healthy. The owner has completed private Tailscale pairing and reopened the installed PWA on the current Mac/iPad; a timed clean-device and replacement-iPad matrix remains outstanding.

## 1. Manual diagnostic path and prerequisites

- Apple Silicon Mac
- Node.js 22 or newer
- npm
- Codex Desktop installed at `/Applications/ChatGPT.app`
- OpenAI-managed standalone Codex CLI at `~/.codex/packages/standalone/current/codex`
- Tailscale for production iPad access, with either the Standalone app's CLI integration enabled or the App Store app's bundled CLI used explicitly

The local preflight on 26 July 2026 observed macOS `26.5.1` build `25F80`, Codex Desktop `26.721.41059` build `5848`, bundle ID `com.openai.codex`, bundled `codex-cli 0.146.0-alpha.3.1`, standalone Codex `0.145.0`, Node `22.23.0`, npm `10.9.8` and Tailscale `1.98.9`. This is an observation, not a hardcoded support promise. Settings → System Diagnostics, `setup:check`, and doctor must report the currently installed versions after every update.

Verify the local tools:

```bash
node --version
npm --version
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/ChatGPT.app/Contents/Info.plist
/Applications/ChatGPT.app/Contents/Resources/codex --version
```

Prefer the binary bundled with Codex Desktop for schema compatibility and renderer-adjacent inspection. The durable daemon itself deliberately runs the versioned OpenAI-managed standalone binary; an npm-global CLI alone is insufficient for that daemon manager.

## 2. Install and inspect

From the repository root:

```bash
npm run setup:check
npm run setup:mac
npm run doctor
```

The npm scripts build the workspace packages imported by the CLI; a clean clone does not need committed or pre-existing `dist` output. `setup:check` is fully read-only and supports `--json`. `setup:mac` generates installed-version schemas in Nerva-owned state, installs the bridge, and produces a pairing invitation only after health succeeds. Doctor reports `ready`, `limited` or `blocked`, plus exact versions, `userAgent`, probe result and per-capability states. Default doctor exits zero for `ready` and `limited`; `--strict-native` requires `ready`.

Read the full setup/doctor result before continuing. A useful report distinguishes:

- Desktop process and version;
- whether CDP exists and is bound to loopback;
- main renderer target and Micro module structure;
- managed app-server control socket ownership;
- other app-server writers;
- installed-version protocol generation support;
- bridge storage permissions;
- Tailscale and Serve availability.
- optional transport capabilities such as multi-image input, exact session list/read and legacy registered-route capture;
- verified Codex Browser discovery needed by the bounded live Site driver.

The report should include versions and structural error categories, not titles, prompts, source code, full thread IDs, tokens, or drawings.

Treat the capability report literally. Native Micro controls, full session list/read, multi-frame send, live Codex Browser frames, legacy route capture and native Dictate are independent gates. A green isolated image spike must not enable the other capabilities. Home, Capture Inbox, local Draw/Review drafts and last-good session state may remain consultable while remote operations are disabled. Capture Inbox stores neutral Photo, Scan, Sketch, File and Note records with no destination or voice recorder; it has no speech recognition, transcript routing, Mac upload or reconnect send. Native Dictation remains recorded and transcribed by Codex Desktop with the Mac-selected microphone.

## 3. Inspect the managed app-server

Only a **Ready** preflight lets `setup:mac` configure Codex's own durable app-server control-socket service; it is not a Nerva-owned raw listener. **Ready with limited Codex controls** leaves that service and every writer untouched. Before replacing or debugging the service manually, confirm that active Codex turns are idle and investigate every existing app-server process:

```bash
pgrep -lf 'codex.*app-server'
ls -l "$HOME/.codex/app-server-control/app-server-control.sock"
/Applications/ChatGPT.app/Contents/Resources/codex app-server daemon version
```

Do not stop or reuse an unfamiliar process merely to make doctor green. Resolve its owner and purpose first. Codex owns the durable daemon lifecycle; Nerva performs a WebSocket handshake directly against its private Unix control socket. `app-server proxy` is a byte relay for SSH/stdio clients and is not Nerva's local transport.

Verify the job and actual socket rather than assuming setup succeeded:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server daemon version
stat "$HOME/.codex/app-server-control/app-server-control.sock"
```

After a Ready native setup, `setup:mac` also sets the local-daemon opt-in for later Desktop launches:

```bash
launchctl setenv CODEX_APP_SERVER_USE_LOCAL_DAEMON 1
```

This changes the environment inherited by subsequently launched GUI applications. To undo the integration deliberately:

```bash
launchctl unsetenv CODEX_APP_SERVER_USE_LOCAL_DAEMON
```

Quit and relaunch Codex Desktop only after saving composer text and waiting for active turns. Run doctor again. Full shared ownership is an optional stronger topology: doctor must positively observe one private socket identity, one current kernel listener generation, one owning daemon, one Desktop process/version, and one exact reciprocal Desktop-owned peer accepted by that listener before any app-server mutation can be enabled. Only when doctor offers the command, create the private attestation explicitly:

```bash
npm run setup -- --attest-desktop-ownership
```

The record is bound to the socket device/inode, kernel listener address/inode/generation, exact reciprocal Desktop peer, and the process-start identities of the daemon, Desktop, and Desktop-owned client. Nerva revalidates it on every managed connection. The asynchronous probe returns a one-shot opaque token tied to the current client, delegate, and topology epoch; a concurrent probe or disconnect revokes it, and the managed client synchronously checks the token plus exact socket/two-peer topology at the WebSocket message write. Runtime full-ownership authority requires exactly two reciprocal clients on that generation: the attested Desktop peer and the current bridge socket client.

An unlinked socket A cannot be composed with replacement socket B; either split generation, any restart, PID reuse, version change, third peer, unsafe file mode, or topology mismatch closes the delegate and returns mutations to unavailable. This closes cooperative bridge/provider races but is not an OS sandbox against a hostile or uncooperative same-UID process. There is no environment-variable override. Do not create or edit the attestation by hand.

Without that full-ownership attestation, Nerva permits compatible app-server reads such as session, model, skill and usage catalogs, but no app-server mutation. An exact selected native target does not override missing ownership. Drawing remains locally editable; any delivery path keeps its own exact composer and ownership gates. Native Micro controls use their separately revalidated HID path.

## 4. Launch Codex with loopback CDP

The native six-slot adapter needs a Chrome DevTools endpoint. CDP must remain on `127.0.0.1` and use a random port. Never add a fixed LAN-facing debugging port.

Wait for all turns to become idle, save unsent composer text, and quit Codex Desktop completely. Confirm that no main Desktop process remains. Then launch the app executable directly:

```bash
/Applications/ChatGPT.app/Contents/MacOS/ChatGPT \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=0
```

Do not use `open -na` while Codex is already running; a second application/app-server instance can create writer ambiguity. Run `npm run doctor` again. Doctor must verify the resolved listener is loopback and select the main `app://` renderer before native controls are enabled.

CDP is not exposed by the Nerva HTTP or WebSocket API. The browser can send only fixed typed commands that the adapter translates into bridge-authored native events.

## 5. Installed-version protocol generation

`setup:mac` generates experimental JSON Schemas for both the Desktop-bundled and managed-daemon binaries. The manual command below refreshes the Desktop side only:

```bash
npm run setup -- --generate-schemas
```

The caches are beneath `~/Library/Application Support/CodexPad/cache/app-server-schemas/<exact-version>--<binary-fingerprint>/`. This keeps Desktop and daemon schemas separate even when their version strings are identical. Setup hashes the exact binary and every generated file, then records both in `manifest.json`. Doctor validates representative Nerva requests with Ajv against both sets, then performs only read-only live calls. Do not copy these generated artifacts into committed source directories.

### Optional bounded multi-image attestation

A one-image Review does not require a multi-image attestation. Sending 2–12 retained images in one atomic Review remains disabled until the exact installed binary passes the separate opt-in probe. The probe is never run by `setup`, `doctor`, `start`, or `serve`; it creates and deletes a disposable app-server thread and must be requested explicitly.

First run schema setup and copy the exact values printed after `Generated installed-version schemas:` and `Schema SHA-256:`. Then, only if creating that disposable thread is acceptable, run:

```bash
npm run probe:multi-image -- \
  --acknowledge-disposable-thread \
  --write-attestation \
  --codex-binary /Applications/ChatGPT.app/Contents/Resources/codex \
  --codex-version '<exact Generated installed-version schemas value>' \
  --schema-sha256 '<exact Schema SHA-256 value>'
```

The command uses synthetic generated images and writes `~/Library/Application Support/CodexPad/security/image-input-capability.json` only after it verifies one image, 12 ordered images in one `turn/start`, and deletion of the disposable thread. This is a fixed path derived from the operating-system account home; neither `HOME` nor an arbitrary capability-path environment variable can redirect it. The private record includes the exact `codexBinaryPath`, Codex version, schema hash, app-server user agent, and probe result.

With `--write-attestation`, the command first validates Node, the acknowledgement and supplied identities, then resolves the Codex binary to an executable canonical path. Only after that non-mutating preflight does it invalidate a prior record, still before app-server launch. Automatic invalidation accepts only a strict, bounded, owner-matching, mode-`0600` regular file with one link beneath verified non-symlink directories. A symlink, wrong type, wrong mode or owner, extra hard link, malformed/non-strict JSON, oversized content, or identity change stops the command without deleting the entry or creating a probe thread. Inspect and remediate that local path manually before retrying; do not point the probe at another path. A failed or interrupted probe after successful invalidation cannot leave an old result enabled.

At normal startup, Nerva does not trust the record alone. It strictly parses the installed-version cache manifest, recomputes the deterministic SHA-256 over every non-manifest schema file, verifies the exact file list, binary path, and version, and only then projects the private attestation. Absence is normal. An invalid or stale record produces a path-free local warning and the bridge continues with the one-image Review limit.

This attestation proves only the isolated binary's bounded multi-image `turn/start` behavior. It does not prove that Codex Desktop and Nerva share one writer, grant exact-thread authority, prove live same-Desktop delivery, or prove image input to `turn/steer`; those independent gates must still pass.

## 6. Build the bridge

```bash
npm run build
```

Do not start the foreground bridge yet. It locks its allowed public origin at startup, so first obtain the exact MagicDNS origin and rotate the pairing code in the next two sections.

When started, the supported listener is:

```text
http://127.0.0.1:8787
```

The local address must be `127.0.0.1`, not `0.0.0.0`, `::`, a LAN address, or a Tailscale address.

For development, use `npm run dev`. Development URLs and authentication behavior may differ; do not treat a development server as the production remote-control surface.

## 7. Configure private HTTPS with Tailscale Serve

Install Tailscale from its official distribution, sign the Mac and iPad into the intended tailnet, and verify the current client before changing Serve state. The Standalone app can install `/usr/local/bin/tailscale` from **Settings → CLI integration**; the App Store build exposes `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Resolve either form once for the current shell:

```bash
CODEX_PAD_TAILSCALE_BIN="$(command -v tailscale 2>/dev/null || true)"
if [ ! -x "$CODEX_PAD_TAILSCALE_BIN" ]; then
  CODEX_PAD_TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" version
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" status --json
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" serve --help
```

If the final path is not executable, fix the Tailscale installation or CLI integration before continuing. See the [official macOS CLI instructions](https://tailscale.com/docs/reference/tailscale-cli?tab=macos).

Configure the private proxy and copy the exact HTTPS MagicDNS origin it prints:

```bash
TAILSCALE_BE_CLI=1 "$CODEX_PAD_TAILSCALE_BIN" serve --bg --https=443 http://127.0.0.1:8787
```

It is acceptable for the upstream to be temporarily unavailable because the foreground bridge has not started yet. Use the HTTPS MagicDNS URL printed by Tailscale. Do not use Funnel. Do not bind the bridge directly to the Tailscale IP.

Inspect or remove the Serve configuration with the commands documented by the installed Tailscale version. Do not run a broad reset if other local services also use Serve.

No separate Push account, Apple Developer membership, certificate or notification daemon is required. On first bridge startup, Nerva creates one private VAPID keypair beneath `~/Library/Application Support/CodexPad/security/`; the iPad registers its subscription only after the user taps **Enable** in the installed PWA. The Mac must be allowed to make outbound HTTPS requests to the browser Push service selected by iPadOS—normally an Apple `*.push.apple.com` endpoint. An outbound firewall that blocks that host will prevent delivery while leaving normal Tailscale sync available.

## 8. Rotate pairing for the exact origin

Rotate the short-lived pairing payload before the foreground bridge starts. This persists the exact MagicDNS origin that the bridge will accept when it initializes:

```bash
npm run codex-pad -- pairing rotate \
  --origin https://your-mac.your-tailnet.ts.net \
  --name "iPad"
```

In normal mode the CLI renders a terminal QR, then prints its HTTPS URL and five-minute expiry. Scan that QR directly with the iPad; it contains the one-time nonce in the URL fragment and no permanent credential. Add `--json` only when structured `qrPayload`/`expiresAt` metadata is needed. Re-render the current unexpired pairing QR with:

```bash
npm run codex-pad -- pairing show
```

If a bridge is already running with another origin, stop it with `Ctrl-C`, rotate the pairing code, and restart it. As an explicit alternative for one launch, pass the same exact origin to the process:

```bash
CODEX_PAD_PUBLIC_ORIGIN=https://your-mac.your-tailnet.ts.net npm run start
```

Do not rotate to a new host after the bridge has started and assume the running Origin policy changed; it is established during startup.

## 9. Start the foreground bridge in a second terminal

Keep the first terminal open if you want the QR visible. Open a second terminal at the repository root and run:

```bash
npm run start
```

The bridge remains in the foreground. Verify its listener before opening the pairing URL:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
npm run doctor
```

The local address must be `127.0.0.1:8787`. Doctor reports the private Serve declaration, explicit `tailscale-funnel` negative evidence, and live WSS route separately. It uses the installed CLI's read-only `tailscale funnel status --json` surface: an unavailable, non-zero, ambiguous, unparseable, or enabled result is red, while only authoritative evidence that Funnel is disabled for the exact bridge route passes that gate. Serve/WSS reachability alone never proves private-only ingress.

With Funnel excluded, Serve becomes green only when its declared loopback mapping is accompanied by a real, bounded WSS upgrade to the exact same-origin `/ws`; the credential-free probe must then be closed by the bridge with `4401` before application data. A warning means the route or one of its prerequisites remains unproven, even if `tailscale serve status` contains plausible HTTPS text. These checks still do not prove iPad ACL reachability, a paired Safari credential, resume behavior, or message delivery.

From the iPad, scan the QR or open its HTTPS URL and pair. Then:

- name the device clearly;
- verify it appears in the paired-device list;
- confirm the browser reports `Connected` and a fresh state sequence;
- revoke the device once as a test, confirm its socket closes, then pair again.

Continue with [iPad setup](SETUP_IPAD.md).

## 10. Manage legacy registered Review context (optional)

The visible **Sites** picker does not need registration. It lists only verified Codex Browser pages whose native webview conversation is proven for the exact requested task, and operates only the opaque page explicitly chosen by the user. Ambiguous or duplicate mappings remain hidden.

The older Review-image path still retains a private registered-site compatibility API. The CLI remains available only for that path and never grants authority to the live Sites picker. A Mac operator can register one exact loopback origin and intended MagicDNS metadata against an exact thread UUID or opaque project-cwd identifier:

```bash
npm run codex-pad -- site add \
  --thread 11111111-1111-4111-8111-111111111111 \
  --url http://127.0.0.1:3000 \
  --public-origin https://your-mac.your-tailnet.ts.net:3000
```

Replace the synthetic UUID, host, and port with the intended target. `--url` remains the private loopback source; `--public-origin` records intended future metadata only. Its hostname must exactly equal the authoritative bridge MagicDNS hostname from `CODEX_PAD_PUBLIC_ORIGIN` or the persisted pairing record, while its dedicated port must equal the local source port. The CLI fails closed when that bridge origin is unavailable or the hostname differs.

Use `--thread` for one exact task, or `--project "/absolute/project/cwd"` to make the registration available to sanitized sessions with the same opaque `projectId`. The API never returns that absolute cwd, and an exact thread registration takes precedence when both scopes match. The command writes only the private Nerva registry and reports live preview unavailable; it prints no Serve command.

The stored source must use IPv4 loopback `127.0.0.1`; `localhost` is normalized and IPv6 `[::1]` is rejected. The current fixed port allowlist is `3000`, `3001`, `4173`, `4200`, `4321`, `5000`, `5173`, `5174`, `8000`, and `9000`. The intended HTTPS port must equal that local port and cannot be `443` or `8787`. Do not configure a sibling Site Serve route for this legacy registered-route path. It would provide no supported experience to the current live-tab picker and would reintroduce the shared-host cookie risk described below.

Inspect or remove registrations with:

```bash
npm run codex-pad -- site list
CODEX_PAD_SITE_ID="paste-exact-site-id-from-list"
npm run codex-pad -- site remove "$CODEX_PAD_SITE_ID"
```

A legacy registration proves only operator intent for that registered-route Review driver. It does not appear in the current Sites picker, does not embed or top-level-open the page, and does not authorize the bounded live-tab driver. The bridge and registered site use the same MagicDNS hostname on different ports, but ports do not isolate cookies; even an opaque sandboxed response can set host-wide cookies that later reach or overflow bridge request headers.

Capture is independently unavailable. The current production build returns `process-sandbox-unavailable` before launching Chrome: on the audited Mac, its exact-egress macOS process policy could not coexist with Chrome's own required child sandbox. Do not work around this by disabling Chrome's sandbox. Manually capture a screenshot outside Nerva, import it through Photos/Files, then annotate, compare, and send through the independently gated review path.

## 11. Development-only unsafe LAN mode

Tailscale Serve is the production path. For an isolated development network only, the CLI requires a concrete non-loopback address and its exact HTTP Origin:

```bash
npm run codex-pad -- pairing rotate \
  --unsafe-lan 192.0.2.10 \
  --origin http://192.0.2.10:8787 \
  --port 8787

npm run start -- \
  --unsafe-lan 192.0.2.10 \
  --origin http://192.0.2.10:8787 \
  --port 8787
```

The first command creates a five-minute, single-use HTTP pairing QR and is accepted only with the same explicit unsafe-LAN address and port. Unsafe mode uses the same exact-origin bearer design as production—dedicated browser IndexedDB or memory, `Authorization: Bearer` for HTTP, and one-time WebSocket tickets—not a development cookie. Replace the documentation address with one explicit interface address. Hostnames, loopback addresses, wildcards, mismatched ports, and paths are rejected. Authentication and Origin checks stay enabled, but the nonce, bearer, and all traffic are unencrypted on this HTTP network. Never use this mode on an untrusted network or present it as production security.

## 12. Optional Context Room health

Nerva can show a read-only Context Room health card. This integration is off unless the bridge process receives an exact loopback HTTP origin:

```bash
launchctl setenv CODEX_PAD_CONTEXT_ROOM_ORIGIN http://127.0.0.1:4319
launchctl kickstart -k "gui/$(id -u)/com.codex-pad.bridge"
```

Replace `4319` only with the exact local room port. The value must contain no credentials, query, fragment or non-loopback hostname. The adapter reads only `/api/health`, sanitizes the room basename/version/state and exposes no Context Room mutation. Remove the optional integration with `launchctl unsetenv CODEX_PAD_CONTEXT_ROOM_ORIGIN` and restart the exact bridge service.

## 13. Validation

```bash
npm run check
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
npm run validate
npm run doctor
```

`npx playwright install chromium webkit` installs Playwright's managed test browsers for the configured iPad landscape, iPad portrait and phone matrices. They are not runtime dependencies of the bridge. WebKit automation verifies Push parsing, settings and safe navigation contracts, but still does not prove physical Pencil, palm rejection, real vendor Push delivery, Focus behavior or iPadOS suspension.

Run the isolated spike when starting a disposable app-server test thread is acceptable:

```bash
npm run spike
```

Finally complete the [manual hardware checklist](MANUAL_TEST_CHECKLIST.md). A green local build does not prove live native slots, same-Desktop thread routing, Tailscale, or iPad/Pencil behavior.
