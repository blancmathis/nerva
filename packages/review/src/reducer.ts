import { REVIEW_LIMITS } from "./constants.js";
import {
  ReviewDraftSchema,
  ReviewFrameSchema,
  type ReviewDraft,
  type ReviewFrame,
} from "./schemas.js";

export type ReviewFramePatch = Partial<Omit<ReviewFrame, "id">>;

export type ReviewDraftAction =
  | { readonly type: "addFrame"; readonly frame: ReviewFrame; readonly atIndex?: number }
  | { readonly type: "reorderFrame"; readonly frameId: string; readonly toIndex: number }
  | { readonly type: "updateFrame"; readonly frameId: string; readonly patch: ReviewFramePatch }
  | { readonly type: "deleteFrame"; readonly frameId: string }
  | { readonly type: "setGeneralInstruction"; readonly instruction: string };

function touch(draft: ReviewDraft, changes: Partial<ReviewDraft>, now: number): ReviewDraft {
  return ReviewDraftSchema.parse({ ...draft, ...changes, updatedAt: Math.max(now, draft.updatedAt) });
}

function requireIndex(items: readonly { readonly id: string }[], id: string, label: string): number {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new RangeError(`${label} ${id} does not exist`);
  }
  return index;
}

export function reviewDraftReducer(
  draft: ReviewDraft,
  action: ReviewDraftAction,
  now = Date.now(),
): ReviewDraft {
  ReviewDraftSchema.parse(draft);

  switch (action.type) {
    case "addFrame": {
      const frame = ReviewFrameSchema.parse(action.frame);
      if (draft.frames.some((candidate) => candidate.id === frame.id)) {
        throw new TypeError(`Frame id ${frame.id} already exists`);
      }
      if (draft.frames.length >= REVIEW_LIMITS.frames) {
        throw new RangeError(`A review may contain at most ${REVIEW_LIMITS.frames} frames`);
      }
      const atIndex = action.atIndex ?? draft.frames.length;
      if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > draft.frames.length) {
        throw new RangeError("Frame insertion index is out of range");
      }
      const frames = [...draft.frames];
      frames.splice(atIndex, 0, frame);
      return touch(draft, { frames }, now);
    }
    case "reorderFrame": {
      const fromIndex = requireIndex(draft.frames, action.frameId, "Frame");
      if (!Number.isInteger(action.toIndex) || action.toIndex < 0 || action.toIndex >= draft.frames.length) {
        throw new RangeError("Frame destination index is out of range");
      }
      if (fromIndex === action.toIndex) {
        return draft;
      }
      const frames = [...draft.frames];
      const [frame] = frames.splice(fromIndex, 1);
      if (frame === undefined) {
        throw new RangeError(`Frame ${action.frameId} does not exist`);
      }
      frames.splice(action.toIndex, 0, frame);
      return touch(draft, { frames }, now);
    }
    case "updateFrame": {
      const frameIndex = requireIndex(draft.frames, action.frameId, "Frame");
      const previous = draft.frames[frameIndex];
      if (previous === undefined) {
        throw new RangeError(`Frame ${action.frameId} does not exist`);
      }
      const next = ReviewFrameSchema.parse({ ...previous, ...action.patch, id: previous.id });
      const frames = [...draft.frames];
      frames[frameIndex] = next;
      return touch(draft, { frames }, now);
    }
    case "deleteFrame": {
      const frameIndex = requireIndex(draft.frames, action.frameId, "Frame");
      const frames = [...draft.frames];
      frames.splice(frameIndex, 1);
      return touch(draft, { frames }, now);
    }
    case "setGeneralInstruction":
      return touch(draft, { generalInstruction: action.instruction }, now);
  }
}
