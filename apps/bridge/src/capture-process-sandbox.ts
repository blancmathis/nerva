export const CAPTURE_NETWORK_CONFINEMENT_UNAVAILABLE_DETAIL =
  "No OS- or VM-enforced outbound network confinement compatible with system Chrome's own sandbox is available. Browser proxy settings and request interception are defense in depth, not a production isolation boundary; site capture remains disabled.";

/**
 * Production capture requires a destination-level boundary outside the page
 * and browser policy layers. macOS `sandbox-exec` cannot provide that boundary
 * around Chrome without conflicting with Chrome's own Seatbelt profiles, and
 * launching Chrome with `--no-sandbox` is never an acceptable fallback.
 *
 * Keep this gate closed until a separately contained helper (for example a VM
 * or supported network namespace) is implemented and dynamically attested.
 */
export async function defaultCaptureNetworkSandboxAvailable(): Promise<boolean> {
  return false;
}
