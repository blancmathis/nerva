import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppBootBoundaryProps {
  readonly children: ReactNode;
}

interface AppBootBoundaryState {
  readonly failed: boolean;
  readonly repairing: boolean;
}

const NERVA_SHELL_CACHE_PREFIX = "codex-pad-shell-";

async function clearNervaAppShell(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(NERVA_SHELL_CACHE_PREFIX))
      .map((key) => caches.delete(key)));
  }
}

export class AppBootBoundary extends Component<AppBootBoundaryProps, AppBootBoundaryState> {
  public override state: AppBootBoundaryState = { failed: false, repairing: false };

  public static getDerivedStateFromError(): Partial<AppBootBoundaryState> {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Nerva startup failed", error, info.componentStack);
  }

  private repairAndReopen = async (): Promise<void> => {
    this.setState({ repairing: true });
    try {
      await clearNervaAppShell();
    } finally {
      const url = new URL(window.location.href);
      url.searchParams.set("recovered", Date.now().toString(36));
      window.location.replace(url);
    }
  };

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="cp-boot-recovery" role="alert" aria-labelledby="nerva-startup-error-title">
        <div className="cp-boot-recovery__panel">
          <span className="cp-boot-recovery__mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <p>Nerva recovery</p>
          <h1 id="nerva-startup-error-title">Startup was interrupted.</h1>
          <p>Nerva can refresh only its app shell. Your sessions, sections, captures, and drawings stay in place.</p>
          <div className="cp-boot-recovery__actions">
            <button type="button" disabled={this.state.repairing} onClick={() => void this.repairAndReopen()}>
              {this.state.repairing ? "Repairing…" : "Repair and reopen"}
            </button>
            <button type="button" disabled={this.state.repairing} onClick={() => window.location.reload()}>Reload only</button>
          </div>
        </div>
      </main>
    );
  }
}
