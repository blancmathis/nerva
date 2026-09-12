// Use the short edge so rotating a phone does not make a new canvas pen-only.
// Saved drafts keep their explicitly selected input mode.
export function defaultPencilOnly(): boolean {
  return Math.min(window.innerWidth, window.innerHeight) >= 700;
}
