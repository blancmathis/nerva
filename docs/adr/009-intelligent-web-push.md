# ADR 009: Send only private, decision-linked Web Push alerts

- Status: Accepted and implemented locally
- Date: 2026-07-22
- Scope: installed PWA notification permission, bridge subscriptions/VAPID, event selection, privacy and deep links

## Context

Nerva already observes reliable task state while the PWA is connected. Local service-worker notifications cannot reliably wake a fully suspended Home Screen app, and notifying every state change would turn the iPad into noise. Notifications also appear on a Lock Screen, where task titles, prompts, outputs, commands and one-touch approvals are inappropriate.

iOS/iPadOS supports standards Web Push for installed Home Screen web apps after a direct user gesture. The private Mac bridge can be the sender without introducing a cloud Nerva account or Apple Developer credential.

## Decision

The installed PWA exposes one explicit `Enable`/`Turn off` control. `Enable` requests permission, creates or reuses the browser subscription and registers it for the current authenticated paired device. `Turn off` removes the bridge record before unsubscribing locally. Permission is never requested during pairing, startup or background reconciliation.

The bridge creates one persistent VAPID keypair and stores subscriptions by paired device ID. The private key and subscription material use atomic mode-`0600` files. The browser can read only the public key and whether its own device has a record. Device revocation removes that record; Push-service `404` or `410` also expires it.

Subscription endpoints are not arbitrary URLs. Validation allows only known Apple, Google and Mozilla Push service HTTPS hosts, forbids credentials/custom ports/fragments, and requires exact `p256dh` and `auth` decoded lengths.

The decision engine processes only authoritative native slot snapshots. `live` qualifies directly. Aggregate `degraded` health qualifies only when the independent native refresh proof is at most five seconds old, so loss of an unrelated control/app-server authority does not suppress read-only status alerts. Stale, reconnecting and offline state never qualifies. The first authoritative observation is a silent baseline. It sends only:

- a newly blocking question;
- a newly pending approval;
- a new error;
- a completion for a task the user explicitly pinned;
- one grouped Home Priority alert when several pinned results are ready.

Completions wait eight seconds for grouping. Blocking events use high urgency and one-hour TTL; results use normal urgency and six-hour TTL. An opaque Push topic coalesces obsolete duplicates. Existing synchronized category preferences remain authoritative; `Waiting for your answer` is on by default only for new Product State.

Every payload uses fixed generic English copy. It contains no task title, prompt, output, generated summary, command/approval summary, cwd, local path or credential. The only destination is either one canonical task UUID or the bounded Home Priority target. The legacy `mission` wire value remains accepted only as a compatibility deep link and resolves to that Home focus. The service worker validates the shape again and derives the same-origin URL itself.

Notifications define no action buttons. A tap may focus/open the exact decision context, but approval and rejection remain authenticated in-app operations against a current exact request tuple.

## Current authority limit

The detailed reliable transition stream currently covers the six native Micro slots. The wider session catalog supports overview and navigation but is not sufficient evidence for a blocking question or important completion. Nerva must miss an unproven notification rather than infer one from title, recency, project, UI placement or stale data.

Pinned membership is the current explicit importance signal for completion. This is reversible presentation state and does not alter Codex task execution.

## Failure behavior

- Permission denied: the UI points to iPadOS Settings; no repeated prompt loop.
- Browser permission exists but the server record is missing: foreground reconciliation re-registers the existing subscription without prompting.
- Server record exists but the browser subscription is gone: foreground reconciliation removes the stale server record.
- Bridge restart: the first authoritative state is a baseline, so transitions that occurred while the bridge itself was down are not reconstructed.
- PWA hidden without a background subscription: a local generic fallback may notify only while the service worker is still available.
- Malformed payload or unsafe destination: the service worker displays nothing.
- Delivery failure other than `404`/`410`: the bridge logs one content-free structural warning and does not replay a command or task mutation.

## Consequences

- Nerva can wake the installed PWA through the browser vendor Push service without operating a Nerva cloud backend.
- Focus and notification presentation remain controlled by iPadOS.
- A Push provider sees delivery metadata and encrypted bytes but receives no Nerva credential or command authority.
- Real suspension, Focus, badge timing, duplicate behavior and vendor delivery remain physical-device proof even when local contracts are green.

## Rejected alternatives

- Notify every completion or working transition: too noisy and not decision-oriented.
- Put task titles or summaries in the notification: leaks content on shared/locked screens.
- Approve from a notification action: bypasses the live exact-decision review context and is unsupported on the target Safari surface.
- Use an arbitrary subscription endpoint: creates an SSRF primitive on the Mac bridge.
- Reconstruct missed transitions from stale snapshots after bridge restart: risks false or duplicate alerts.
- Treat every catalog session as authoritative: the catalog does not independently prove detailed blocking/completion transitions.

## Primary platform references

- [WebKit — Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Apple — Sending web push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [RFC 8030 — Generic Event Delivery Using HTTP Push](https://www.rfc-editor.org/rfc/rfc8030)
- [RFC 8291 — Message Encryption for Web Push](https://www.rfc-editor.org/rfc/rfc8291)
- [RFC 8292 — VAPID](https://www.rfc-editor.org/rfc/rfc8292)
