import { z } from "zod";

export const MAX_SKETCH_BYTES = 8 * 1024 * 1024;
export const MAX_SKETCH_BASE64_LENGTH = Math.ceil(MAX_SKETCH_BYTES / 3) * 4;

export function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export const PngBase64Schema = z
  .string()
  .min(12)
  .max(MAX_SKETCH_BASE64_LENGTH)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Expected base64 data without a data URL prefix")
  .refine((value) => value.length % 4 === 0, "Expected padded base64 data")
  .refine((value) => value.startsWith("iVBORw0KGgo"), "Expected PNG signature")
  .refine((value) => decodedBase64Length(value) <= MAX_SKETCH_BYTES, "PNG exceeds the upload limit");
