import { MAX_REVIEW_TOTAL_BYTES, type SendReviewCommand } from "@codex-pad/protocol";
import type { BridgeDataPaths } from "./paths.js";
import { validateAndNormalizeSketch, type NormalizedSketch } from "./sketch.js";

export interface NormalizedReview {
  instruction: string;
  images: NormalizedSketch[];
  cleanup(): Promise<void>;
}

export type ReviewInstructionHook = (command: SendReviewCommand, baseInstruction: string) => string | Promise<string>;

function assertInstructionBounds(instruction: string): void {
  if (instruction.trim().length < 1 || instruction.length > 8_000) {
    throw new ReviewValidationError(
      "Review instruction must contain 1 to 8,000 characters; nothing was truncated",
    );
  }
}

function assertStructuredTextIsPresent(command: SendReviewCommand, instruction: string): void {
  for (const [frameIndex, frame] of command.frames.entries()) {
    if (frame.title !== null && !instruction.includes(`title=${JSON.stringify(frame.title)}`)) {
      throw new ReviewValidationError(
        `Atomic review instruction omits the exact title for frame ${frameIndex + 1}; nothing was sent`,
      );
    }
    if (frame.url !== null && !instruction.includes(`url=${JSON.stringify(frame.url)}`)) {
      throw new ReviewValidationError(
        `Atomic review instruction omits the exact URL for frame ${frameIndex + 1}; nothing was sent`,
      );
    }
  }
}

export function defaultReviewInstruction(command: SendReviewCommand): string {
  assertInstructionBounds(command.instruction);
  assertStructuredTextIsPresent(command, command.instruction);
  return command.instruction;
}

export async function validateAndNormalizeReview(
  command: SendReviewCommand,
  paths: BridgeDataPaths,
  instructionHook?: ReviewInstructionHook,
): Promise<NormalizedReview> {
  const images: NormalizedSketch[] = [];
  try {
    const base = defaultReviewInstruction(command);
    const instruction = instructionHook === undefined ? base : await instructionHook(command, base);
    assertInstructionBounds(instruction);
    assertStructuredTextIsPresent(command, instruction);
    for (const frame of command.frames) {
      if (frame.image.kind !== "inlinePng") {
        throw new ReviewValidationError("Upload references are not enabled by this bridge");
      }
      images.push(await validateAndNormalizeSketch({
        commandId: command.commandId,
        snapshotSeq: command.snapshotSeq,
        targetThreadId: command.targetThreadId,
        instruction: command.instruction,
        pngBase64: frame.image.png,
      }, paths));
      if (images.reduce((total, image) => total + image.bytes, 0) > MAX_REVIEW_TOTAL_BYTES) {
        throw new ReviewValidationError("Normalized review images exceed the total upload limit");
      }
    }
    return {
      instruction,
      images,
      cleanup: async () => {
        await Promise.all(images.map((image) => image.cleanup()));
      },
    };
  } catch (error) {
    await Promise.all(images.map((image) => image.cleanup().catch(() => undefined)));
    throw error;
  }
}

export class ReviewValidationError extends Error {
  readonly code = "INVALID_REVIEW";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}
