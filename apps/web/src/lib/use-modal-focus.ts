import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Focus containment and restoration for a mounted modal surface. */
export function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { readonly active?: boolean; readonly closeOnEscape?: boolean; readonly initialFocus?: string } = {},
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (options.active === false) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const initial = options.initialFocus
      ? dialog.querySelector<HTMLElement>(options.initialFocus)
      : null;
    (initial ?? focusable()[0] ?? dialog).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && options.closeOnEscape !== false) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      const currentIndex = candidates.indexOf(document.activeElement as HTMLElement);
      const nextIndex = currentIndex < 0
        ? event.shiftKey ? candidates.length - 1 : 0
        : (currentIndex + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length;
      candidates[nextIndex]!.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => {
        if (dialogRef.current !== null) return;
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      });
    };
  }, [dialogRef, options.active, options.closeOnEscape, options.initialFocus]);
}
