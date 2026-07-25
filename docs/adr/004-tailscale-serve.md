# ADR 004: Publish only through Tailscale Serve

- Status: Accepted current ingress/security and one-command Mac setup baseline; install-first iPad UX remains target
- Date: 2026-07-20
- Scope: Private iPad ingress, HTTPS/WSS, and origin identity

> **Current boundary:** the loopback, Serve-not-Funnel, exact-origin, revocation and WebSocket security decisions remain authoritative. `setup:mac`, the user LaunchAgent, route inspection, same-terminal QR, five-minute fragment invitation, install-first screen and internal PWA scanner are implemented. A manual Tailscale pairing has worked on the owner's Mac/iPad; the full acceptance matrix and replacement-iPad path remain unproven. See [`docs/product/PAIRING_target.md`](../product/PAIRING_target.md).

## Context

The bridge controls an agent that can modify files and run commands. It must not
listen on a LAN or public interface by default. The PWA also needs a secure HTTPS
origin for installation, service workers, and high-quality browser input APIs.

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) exposes a
loopback service to tailnet peers with HTTPS at a full
[MagicDNS](https://tailscale.com/docs/features/magicdns) name. Tailscale Funnel,
by contrast, publishes a service to the public internet.

No Tailscale CLI or application is installed on the current Mac, so this ADR is
a target decision rather than live deployment proof.

## Decision

The bridge always binds to `127.0.0.1` by default. Tailscale Serve is the only
supported production ingress from the iPad. Funnel is prohibited.

The production bridge listens on loopback port `8787`. The proposed operator
command is:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

The resulting PWA origin uses the full HTTPS MagicDNS FQDN printed by Tailscale.
Short MagicDNS names are not used as the canonical HTTPS origin.

### Setup behavior

1. Detect the actual CLI and version, then inspect `tailscale serve --help`.
   Serve syntax changed in Tailscale 1.52, so setup must not assume an unknown
   older client accepts the current form.
2. Inspect existing Serve and Funnel configuration before proposing changes.
   Use the installed CLI's read-only `tailscale funnel status --json` surface;
   do not infer Funnel absence from Serve output or WSS reachability.
3. In the legacy guided setup, print the exact command and expected FQDN,
   explain that `--bg` persists the route, and require operator consent. For the
   target one-command path, invoking `npm run setup:mac` is itself explicit
   consent to create or repair only Nerva's exact route and LaunchAgent; do
   not add a duplicate confirmation. Do not use `--yes` to broaden authority.
4. Never run `tailscale serve reset`; it can delete unrelated routes.
5. Run `doctor` after setup to verify bridge loopback binding, private Serve
   configuration, HTTPS reachability, and authoritative absence of Funnel on
   the exact route. An unavailable, failed, ambiguous, unparseable, or enabled
   Funnel result is red rather than "probably private."
6. If Tailscale is missing, leave the bridge loopback-only and print installation
   guidance. Do not fall back to an open LAN listener.

An explicitly named development flag may expose a LAN listener only with a
large unsafe warning, random development credential, and no claim of production
security.

### Application authentication

Tailnet membership and ACLs are necessary but not sufficient application
authentication.

- Pair with a one-time fragment invitation that expires after five minutes.
- Exchange it once for a 43-character revocable per-device bearer returned only
  in the pairing response. The server stores its hash; the PWA stores the
  bearer only in exact-origin `codex-pad-origin-auth` IndexedDB or current-page
  memory, never a cookie, URL, service-worker cache, or `localStorage` fallback.
- Use `Authorization: Bearer` for private HTTP APIs and validate the exact full
  HTTPS origin for mutations. Mint a separate origin-bound, single-use
  30-second ticket for each WebSocket upgrade and carry it only in the
  subprotocol header.
- Do not treat `Tailscale-User-*` headers as the Nerva credential. Shared
  users or tagged devices may not provide the same identity data, and local
  processes can spoof headers to a loopback service.
- Keep the bridge on loopback so tailnet callers cannot bypass Serve.

An `HttpOnly` cookie would reduce direct script access after an XSS, but browser
cookies are not scoped by port. A bridge cookie on the MagicDNS hostname would
also be sent to any sibling-port site on that host. Exact-origin IndexedDB avoids
credential disclosure, but it cannot stop a sibling response from setting new
host-wide cookies that later reach the bridge. The current registered-site
baseline is therefore metadata-only and does not expose, embed, or top-level-open
that sibling port; see [ADR 007](007-site-review.md).

The static PWA's CSP, fixed API surface, and XSS controls remain necessary
because JavaScript in the bridge origin can access its own IndexedDB. During
migration, the bridge sends expiration headers for the former host-wide cookie
names and revokes legacy credential records rather than converting them into
bearers.

Machine naming has privacy and lifecycle consequences. HTTPS certificate
issuance places the machine FQDN in public Certificate Transparency logs, even
though the service remains tailnet-restricted. Setup must ask the operator to
choose a stable, non-sensitive machine name. Renaming changes the origin and can
invalidate the installed PWA, service-worker scope, QR URL, and stored device
credential association.

### WebSocket and resume behavior

The preferred foreground channel is a same-origin secure WebSocket proxied by
Serve. Official Serve documentation does not explicitly guarantee WebSocket
upgrade behavior, and there is no installed client on this Mac to test it.
Doctor therefore treats Serve status as declaration evidence only and checks
the separate [Funnel status surface](https://tailscale.com/docs/reference/tailscale-cli/funnel)
before making any private-ingress claim. Only a successful, unambiguous result
showing Funnel disabled for the exact bridge route passes that gate; unavailable
or enabled status is red even when Serve and WSS work.

When Tailscale is online, the loopback bridge is verified healthy, and its exact
HTTPS MagicDNS origin is configured, doctor performs one three-second WSS
upgrade to same-origin `/ws` with a reserved diagnostic subprotocol. This probe
remains factual and independent of the Funnel result: the bridge validates
Origin, completes the protocol switch, and closes the unauthenticated probe with
`4401` before sending application data. A green WSS check does not prove the
route is private. Only the combination of the negative Funnel gate, matching
Serve declaration, and that bounded WSS result can make `tailscale-serve`
green; all skipped, HTTP-only, timeout, or network outcomes remain
warning/degraded.

That diagnostic handshake carries no application credential. The normal PWA
first authenticates `POST /api/ws-ticket` with its bearer and exact Origin,
then presents `codex-pad.v1` plus the returned ticket protocol during upgrade.
The bridge consumes the ticket once and negotiates only `codex-pad.v1`; the PWA
never persists the ticket. Expiry, reuse, Origin mismatch, or device revocation
rejects it, and reconnect always mints another one.

The API always retains a full snapshot endpoint and generation-aware polling
fallback. Every bridge process has a new UUID `bridgeInstanceId`; `sequence` is
monotone only within that generation and may restart at 1 after a bridge
restart. The PWA never assumes a socket survives iPadOS backgrounding. On
`visibilitychange`, `pageshow`, or network restoration it reconnects with the
last `(bridgeInstanceId, sequence)` tuple, fetches a fresh snapshot, replaces
state when the instance changed, reconciles command acknowledgements, and
preserves unsent drawing drafts.

## Rejected alternatives

- Tailscale Funnel: public internet exposure is outside the threat model.
- Binding directly to the Tailscale `100.x` address: bypasses the loopback-only
  invariant and complicates HTTPS/origin handling.
- Plain LAN HTTP: no private identity boundary and unreliable secure-context
  features.
- Exposing app-server or CDP directly through Serve: bypasses the bridge's typed
  allowlist and would expose dangerous local capabilities.
- Treating MagicDNS as authorization: it provides naming/resolution, not access
  control or per-device revocation.

## Consequences

- The PWA has a stable private HTTPS origin without opening a public port.
- Setup requires the operator to install and join Tailscale on both devices.
- Tailnet policy and application pairing form two independent security layers.
- The owner's private paired PWA path is proven manually. A separately recorded
  WSS-specific trace is still required before claiming the socket path rather
  than snapshot/polling fallback; polling remains first-class.

## Validation gate

Production readiness requires a real Mac/iPad test of HTTPS, PWA installation,
WebSocket upgrade, polling fallback, origin rejection, pairing expiration,
credential revocation with active-socket termination, background resume at 1,
10, and 60 minutes, remote tailnet operation, and authoritative installed-CLI
evidence that Funnel is disabled for the exact bridge route and direct LAN
access is unavailable.
