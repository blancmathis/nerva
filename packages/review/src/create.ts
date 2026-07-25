import { REVIEW_DRAFT_VERSION } from "./constants.js";
import {
  ReviewDraftSchema,
  type ReviewDraft,
  type ReviewTargetThreadId,
} from "./schemas.js";

export interface CreateReviewDraftOptions {
  readonly id: string;
  readonly targetThreadId: ReviewTargetThreadId | string;
  readonly now?: number;
  readonly generalInstruction?: string;
}

export function createReviewDraft(options: CreateReviewDraftOptions): ReviewDraft {
  const now = options.now ?? Date.now();
  return ReviewDraftSchema.parse({
    version: REVIEW_DRAFT_VERSION,
    id: options.id,
    targetThreadId: options.targetThreadId,
    createdAt: now,
    updatedAt: now,
    generalInstruction: options.generalInstruction ?? "",
    frames: [],
  });
}
