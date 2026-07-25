import { ReviewTargetThreadIdSchema, type ReviewDraft } from "./schemas.js";

export class ReviewTargetMismatchError extends Error {
  public readonly expectedThreadId: string;
  public readonly receivedThreadId: string;

  public constructor(expectedThreadId: string, receivedThreadId: string) {
    super(`Review targets thread ${expectedThreadId}, not ${receivedThreadId}`);
    this.name = "ReviewTargetMismatchError";
    this.expectedThreadId = expectedThreadId;
    this.receivedThreadId = receivedThreadId;
  }
}

/** Fails closed if a review is about to be sent to a thread other than its immutable target. */
export function assertDraftTarget(draft: ReviewDraft, targetThreadId: string): void {
  const normalizedTarget = ReviewTargetThreadIdSchema.parse(targetThreadId);
  if (draft.targetThreadId !== normalizedTarget) {
    throw new ReviewTargetMismatchError(draft.targetThreadId, normalizedTarget);
  }
}
