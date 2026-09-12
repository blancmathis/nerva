import { useState } from "react";

import { GlobeIcon, LinkIcon, MacIcon, RefreshIcon } from "./Icons";

interface ConnectionRecoveryProps {
  readonly phase: "connecting" | "reconnecting" | "offline";
  readonly onRetry: () => Promise<boolean>;
  readonly onOpenCaptureInbox?: () => void;
}

type RetryState = "idle" | "trying" | "failed" | "restoring";

export function ConnectionRecovery({ phase, onRetry, onOpenCaptureInbox }: ConnectionRecoveryProps) {
  const [retryState, setRetryState] = useState<RetryState>("idle");

  const retry = async () => {
    if (retryState === "trying") return;
    setRetryState("trying");
    const recovered = await onRetry().catch(() => false);
    setRetryState(recovered ? "restoring" : "failed");
  };

  const retryMessage = retryState === "failed"
    ? "The private link is still unavailable. Check Tailscale on both devices, then try again."
    : retryState === "restoring"
      ? "Connection found. Restoring your workspace…"
      : phase === "connecting"
        ? "Nerva is still looking for the Mac."
        : "Your sessions remain safe on the Mac.";

  return (
    <main className="cp-connection-recovery" aria-labelledby="connection-recovery-title">
      <section className="cp-connection-recovery__panel">
        <header className="cp-connection-recovery__header">
          <span className="cp-connection-recovery__brand" aria-label="Nerva">
            <span aria-hidden="true"><i /><i /><i /><i /></span>
            <strong>Nerva</strong>
          </span>
          <span className="cp-connection-recovery__state" role="status">
            <i aria-hidden="true" />
            Private link unavailable
          </span>
        </header>

        <div className="cp-connection-recovery__body">
          <div className="cp-connection-recovery__copy">
            <p>Nerva connection</p>
            <h1 id="connection-recovery-title">Can’t reach your Mac.</h1>
            <p>Nerva is open, but the private path to the Mac is unavailable. Tailscale being disconnected is the most common cause.</p>
          </div>

          <ol className="cp-connection-recovery__checks" aria-label="Connection checks">
            <li>
              <span aria-hidden="true"><MacIcon /></span>
              <div><strong>Check the Mac</strong><small>Turn on Tailscale from the menu bar and keep the Mac awake.</small></div>
            </li>
            <li>
              <span aria-hidden="true"><GlobeIcon /></span>
              <div><strong>Check this device</strong><small>Open Tailscale and confirm that the iPad or phone is connected.</small></div>
            </li>
            <li>
              <span aria-hidden="true"><LinkIcon /></span>
              <div><strong>Restore the private link</strong><small>Return to Nerva, then try again. No new QR should be needed.</small></div>
            </li>
          </ol>
        </div>

        <footer className="cp-connection-recovery__footer">
          <button type="button" disabled={retryState === "trying" || retryState === "restoring"} onClick={() => void retry()}>
            <RefreshIcon />
            {retryState === "trying" ? "Checking…" : retryState === "restoring" ? "Restoring…" : "Try again"}
          </button>
          <p className={retryState === "failed" ? "is-warning" : undefined} aria-live="polite">{retryMessage}</p>
        </footer>
      </section>
      {onOpenCaptureInbox && <button type="button" className="cp-home-capture" onClick={onOpenCaptureInbox}>Open Capture Inbox</button>}
      <p className="cp-connection-recovery__note">Nerva cannot identify the exact broken link until the Mac answers again.</p>
    </main>
  );
}
