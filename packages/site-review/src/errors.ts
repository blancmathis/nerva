export type SiteReviewErrorCode =
  | "INVALID_ASSOCIATION"
  | "INVALID_CAPTURE"
  | "INVALID_CAPTURE_PATH"
  | "INVALID_ORIGIN"
  | "SITE_NOT_APPROVED";

export class SiteReviewError extends Error {
  constructor(
    readonly code: SiteReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SiteReviewError";
  }
}
