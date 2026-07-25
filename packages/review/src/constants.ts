export const REVIEW_DRAFT_VERSION = 3 as const;

/** Hard app-server text-input ceiling for an atomic multimodal review. */
export const REVIEW_SEND_INSTRUCTION_MAX_CHARACTERS = 8_000 as const;

export const REVIEW_LIMITS = Object.freeze({
  frames: 12,
  images: 20,
  instructionCharacters: 20_000,
  frameInstructionCharacters: 8_000,
  titleCharacters: 512,
  urlCharacters: 4_096,
  fileNameCharacters: 512,
  referenceCharacters: 512,
  imageBytes: 25 * 1024 * 1024,
  dataUrlCharacters: 36 * 1024 * 1024,
  imageDimension: 32_768,
} as const);
