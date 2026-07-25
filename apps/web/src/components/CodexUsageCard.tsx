import type { CSSProperties } from "react";
import type { CodexUsageSnapshot, CodexUsageWindow } from "@codex-pad/protocol";

import { RefreshIcon } from "./Icons";

interface CodexUsageCardProps {
  readonly usage: CodexUsageSnapshot | null;
  readonly loaded: boolean;
  readonly onRefresh: () => void;
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function usageWindowLabel(minutes: number | null, index: number): string {
  if (minutes === 60) return "Hourly limit";
  if (minutes === 300) return "5-hour limit";
  if (minutes === 1_440) return "Daily limit";
  if (minutes === 10_080) return "Weekly limit";
  if (minutes !== null && minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`;
  if (minutes !== null && minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  if (minutes !== null) return `${plural(minutes, "minute")} limit`;
  return index === 0 ? "Primary limit" : "Secondary limit";
}

function compactUsageWindowLabel(minutes: number | null, index: number): string {
  if (minutes === 60) return "Hour";
  if (minutes === 300) return "5h";
  if (minutes === 1_440) return "Day";
  if (minutes === 10_080) return "Week";
  if (minutes !== null && minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes !== null && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes !== null) return `${minutes}m`;
  return index === 0 ? "Main" : "Other";
}

export function resetLabel(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null) return "Reset time unavailable";
  const remainingMinutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
  if (remainingMinutes < 60) return `Resets in ${plural(remainingMinutes, "minute")}`;
  if (remainingMinutes < 1_440) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return `Resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetsAt))}`;
}

function UsageWindow({ value, index }: { readonly value: CodexUsageWindow; readonly index: number }) {
  const remainingPercent = Math.max(0, 100 - value.usedPercent);
  const label = usageWindowLabel(value.windowMinutes, index);
  const level = value.usedPercent >= 90 ? "critical" : value.usedPercent >= 75 ? "warning" : "normal";
  const style = { "--cp-usage-remaining": `${remainingPercent}%` } as CSSProperties;
  return (
    <div className={`cp-usage-window level-${level}`} title={resetLabel(value.resetsAt)}>
      <div className="cp-usage-window__line">
        <span><span className="sr-only">{label}</span><span aria-hidden="true">{compactUsageWindowLabel(value.windowMinutes, index)}</span></span>
        <strong><span aria-hidden="true">{remainingPercent}%</span><span className="sr-only">{remainingPercent}% remaining</span></strong>
      </div>
      <div
        className="cp-usage-window__track"
        role="progressbar"
        aria-label={`${label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent}
        aria-valuetext={`${remainingPercent}% remaining`}
        style={style}
      ><i /></div>
      <small>{resetLabel(value.resetsAt)}</small>
    </div>
  );
}

export function CodexUsageCard({ usage, loaded, onRefresh }: CodexUsageCardProps) {
  const windows = usage?.available
    ? [usage.primary, usage.secondary]
      .filter((value): value is CodexUsageWindow => value !== null)
      .sort((left, right) => (right.windowMinutes ?? -1) - (left.windowMinutes ?? -1))
    : [];
  return (
    <aside className={`cp-usage-card${usage?.available && usage.rateLimitReached ? " is-critical" : ""}`} aria-label="Codex usage">
      <header>
        <button type="button" aria-label="Refresh Codex usage" onClick={onRefresh}><RefreshIcon /></button>
      </header>
      {!loaded && usage === null ? (
        <div className="cp-usage-card__loading" aria-label="Loading Codex usage"><i /><i /></div>
      ) : usage?.available ? (
        <>
          <div className="cp-usage-card__windows">
            {windows.map((window, index) => <UsageWindow key={`${window.windowMinutes ?? "unknown"}-${index}`} value={window} index={index} />)}
            {windows.length === 0 && <p>Usage windows are not available for this account.</p>}
          </div>
          {(usage.stale || usage.credits?.hasCredits === true) && (
            <footer>
              {usage.stale && <span>Last known usage</span>}
              {usage.credits?.hasCredits === true && <span>{usage.credits.unlimited ? "Unlimited credits" : usage.credits.balance ? `${usage.credits.balance} credits` : "Credits available"}</span>}
            </footer>
          )}
        </>
      ) : (
        <p className="cp-usage-card__unavailable">Usage unavailable <small>Tap refresh when Codex reconnects.</small></p>
      )}
    </aside>
  );
}
