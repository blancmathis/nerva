interface PwaUpdateBannerProps {
  readonly safeToReload: boolean;
  readonly availableBuildId: string | null;
  readonly onReload: () => void;
}

export function PwaUpdateBanner({ safeToReload, availableBuildId, onReload }: PwaUpdateBannerProps) {
  return (
    <div className="cp-update-banner" role="status">
      <span>
        <strong>Nerva update ready</strong>
        <small>{safeToReload
          ? "Reload to use the new verified build."
          : "Your visual workspace is protected. Close it before reloading."}</small>
      </span>
      {availableBuildId && <code>{availableBuildId}</code>}
      <button type="button" disabled={!safeToReload} onClick={onReload}>Reload</button>
    </div>
  );
}
