import type { HealthReasonCode } from "./types.js";

export class CodexDesktopAdapterError extends Error {
  readonly code: HealthReasonCode;

  constructor(code: HealthReasonCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexDesktopAdapterError";
    this.code = code;
  }
}

export function asAdapterError(error: unknown): CodexDesktopAdapterError {
  if (error instanceof CodexDesktopAdapterError) return error;
  return new CodexDesktopAdapterError(
    "native-discovery-failed",
    error instanceof Error ? error.message : "Codex Desktop native state could not be read."
  );
}
