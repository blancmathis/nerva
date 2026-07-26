---
context_room:
  kind: canonical
  scope: product
  status: draft
  canonical_for: target pairing experience and security requirements
  last_verified: 2026-07-26
  sources: [docs/adr/004-tailscale-serve.md, docs/SETUP_MAC.md, docs/SETUP_IPAD.md]
---

# Nerva — target pairing in under two minutes

> This document defines the accepted target and completion bar; it is not physical completion proof. The no-form path is implemented. [`CURRENT_STATE.md`](./CURRENT_STATE.md) and [`ADR 004`](../adr/004-tailscale-serve.md) own current evidence and remaining hardware gates.

## Expected outcome

When the Mac and iPad are already on the same tailnet, a non-technical user must be able to open Nerva on the iPad in under two minutes with one copied Terminal command and without copying a URL, typing a code, naming the device, or opening a second terminal.

Quality objectives:

- target median: 30–45 seconds;
- 95% under 120 seconds on a supported configuration;
- about two seconds of deliberate Mac interaction: run the copied command, then wait for the QR;
- one command, one scan, system installation gestures, and one explicit `Connect` tap;
- no permission or confirmation that adds no protection;
- immediate revocation from the Mac.

Installing and signing into Tailscale is a separate prerequisite whose timing depends on the App Store, identity provider, and tailnet policy.

## Primary flow

### 1. Mac

There is no separate Nerva macOS app. From a clone:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
npm run setup:check
npm run setup:mac
```

The official OpenAI installer is both the install and update path. An existing standalone file is insufficient when its version differs from Codex Desktop.

`setup:check` is read-only and classifies the machine:

- **Ready:** base installation and native Codex configuration can proceed;
- **Ready with limited Codex controls:** Nerva can install and pair, but no daemon/writer/Desktop mutation is allowed and app-server-backed controls remain unavailable;
- **Blocked:** a base prerequisite or private-network safety issue must be repaired first.

`setup:mac` is idempotent and:

1. installs missing dependencies and builds required artifacts;
2. reruns the preflight;
3. creates or hardens private Nerva state;
4. discovers the Tailscale MagicDNS origin without asking the user to copy it;
5. preserves or creates only Nerva's exact Serve route and refuses Funnel or a conflicting port 443 route;
6. installs or updates the user LaunchAgent without `sudo`;
7. starts/reloads the loopback bridge and waits for `/api/health`;
8. configures the managed Codex daemon only after a Ready preflight;
9. creates the invitation and prints its QR only after bridge health;
10. waits for pairing, prints `iPad connected`, and returns control.

If native configuration fails after the bridge succeeds, installation finishes with limited Codex controls. It does not discard pairing, restart Desktop, kill a writer, fabricate ownership, or weaken a capability gate.

The first `npm ci` and build may take time; the “two seconds from Git” objective describes user effort, not network/download duration. Later runs skip current work.

After initial pairing, no daily command is required. The LaunchAgent restores the bridge after login/restart and the iPad credential remains valid until revocation, origin change, or PWA storage loss.

### 2. Safari and Home Screen installation

The QR opens Nerva's private HTTPS origin in Safari without consuming the invitation. The page presents a short `Add to Home Screen` instruction and asks the user to keep `Open as Web App` enabled.

The QR uses `/pair#pair=<invitation>`. The fragment is not part of the HTTP request and reaches the bridge only in the body of `POST /api/pair`. The manifest uses a fixed `/pair` `start_url`. Because iPadOS may install the current fragment URL or fall back to `start_url`, Nerva never assumes Safari and the installed PWA share storage or navigation state.

### 3. First installed-app opening

The installed app shows one decision:

```text
Connect to Mathis's Mac

Private connection through your tailnet.

[ Connect ]
```

`Connect` is the only explicit confirmation. Nerva assigns an automatic device label such as `iPad — Nerva`, editable later in Settings.

On success:

1. the invitation is removed from visible navigation state;
2. Nerva shows short feedback and uses haptics only when the platform exposes a real compatible API;
3. the Mac prints `iPad connected`;
4. Home opens with the current Mac session available, without pinning it automatically.

## No-typing fallbacks

### Invitation not transferred to the installed app

If iPadOS loses the fragment, Nerva shows `Scan the QR again` and scans the same QR still visible on the Mac. There is no manual code or URL field.

### Nerva already installed

An installed but unpaired app opens its scanner. Run `npm run pair` on the Mac and scan from Nerva; Safari installation is skipped. `npm run pair` works after both Ready and limited installations because it depends on the healthy bridge, not native app-server authority.

### Expiration and cancellation

- invitations are random, single-use, and valid for five minutes;
- the Mac can cancel immediately;
- `Pairing expired` directs the user to show a new QR;
- a new invitation invalidates the old invitation;
- a network failure does not consume the invitation before durable credential issuance.

### Replacing an iPad

The replacement flow must avoid accidental lockout:

1. the new iPad follows normal pairing;
2. it restores global Mac-backed state;
3. the old credential is revoked only after the new pairing succeeds.

Two simultaneously active iPads are not a primary product scenario, but temporary overlap must not corrupt storage.

## Security model

### Short invitation

- random 256-bit secret;
- carried in the QR fragment and submitted only in the pairing request body;
- exact HTTPS origin required;
- single-use, five-minute expiry, constant-time comparison, and rate limiting;
- reachable only through private Tailscale Serve;
- absent from logs, cookies, `localStorage`, service-worker cache, and diagnostics.

### Device credential

- random credential unique to the installation, returned once;
- only its hash is stored in a private Mac file;
- the PWA stores it in exact-origin IndexedDB, with memory-only fallback;
- HTTP uses `Authorization: Bearer`;
- every WebSocket uses a separate short-lived, single-use, Origin-bound ticket;
- revocation invalidates the credential, unused tickets, and active sockets.

The tailnet and app credential are independent barriers: Tailscale limits reachability; Nerva authorizes a typed API device.

### Not requested

- no Nerva account or password;
- no extra Face ID gate;
- no post-scan Mac confirmation;
- no additional macOS app;
- no durable bearer in the QR;
- no public Funnel or production LAN fallback.

## UI states

| State | Primary copy | Action |
| --- | --- | --- |
| Ready | `Nerva setup check: READY` | Install and show QR |
| Limited | `READY WITH LIMITED CODEX CONTROLS` | Install/pair; native controls stay unavailable |
| Blocked | Precise failed safety check | Repair and rerun preflight |
| Active QR | `Scan with your iPad camera` | `Press Ctrl-C to cancel` |
| Safari | `Add Nerva to your Home Screen` | System instruction |
| Installed app | `Connect to <Mac name>` | `Connect` |
| Success | `iPad connected` | Open Home |
| Expired | `Pairing expired` | New Mac QR |
| Revoked | `This iPad was disconnected` | `Pair again` |

## Acceptance criteria

Target pairing is not complete until real-device evidence proves:

1. clean flow under 120 seconds after prerequisites;
2. one setup command after clone, no second terminal or native Nerva Mac app;
3. no typed code, URL, origin, or device name;
4. Home Screen install, fixed `start_url`, and second-scan fallback;
5. already-installed pairing without Safari;
6. persistence after terminal close, reconnect, and Mac restart;
7. expiry, cancellation, replay prevention, and rate limiting;
8. no secret in HTTP logs, server history, cookies, service worker, or diagnostics;
9. revocation closes the active socket immediately;
10. replacement does not revoke the old device before new success;
11. no Funnel and a loopback-only bridge;
12. limited-mode pairing with every app-server-backed control visibly unavailable and no command sent to an unattested writer.

## Current gap

The fundamental security and no-form UI are implemented and automatically tested. The maintainer has completed one private Tailscale pairing, Home Screen installation, and credential reuse. Still missing are a timed clean-clone run, physical expiry/cancellation, replacement with deferred revocation, a broader iPadOS matrix, and the explicit limited-runtime physical check. See [`CURRENT_STATE.md`](./CURRENT_STATE.md).

## Platform references

- [WebKit — Home Screen web apps in iOS and iPadOS 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- [WebKit — Home Screen web app and Safari separation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [WebKit bug 181849 — do not assume shared Safari storage](https://bugs.webkit.org/show_bug.cgi?id=181849)
- [W3C Web App Manifest — `start_url` is advisory](https://www.w3.org/TR/appmanifest/#start_url-member)
