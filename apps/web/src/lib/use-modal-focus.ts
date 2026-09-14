import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button", "a[href]", "input:not([type='hidden'])", "select", "textarea",
  "[tabindex]", "[contenteditable='true']",
].join(",");

interface ModalEntry {
  readonly dialog: HTMLElement;
}

// A single document can contain a sheet above another dialog. Only the
// uppermost owner may handle keys or redirect focus into its surface.
const modalStacks = new WeakMap<Document, ModalEntry[]>();

function available(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled")) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true") return false;
    const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
  }
  return true;
}

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
    const document = dialog.ownerDocument;
    const window = document.defaultView;
    if (!window) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const stack = modalStacks.get(document) ?? [];
    modalStacks.set(document, stack);
    const entry = { dialog };
    // React mounts child effects first; an ancestor must not cover its child.
    const childIndex = stack.findIndex((candidate) => dialog.contains(candidate.dialog));
    if (childIndex < 0) stack.push(entry);
    else stack.splice(childIndex, 0, entry);
    const isTop = () => stack.at(-1) === entry;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((element) => element.tabIndex >= 0 && available(element));
    const focusInitial = () => {
      const requested = options.initialFocus ? dialog.querySelector<HTMLElement>(options.initialFocus) : null;
      const initial = requested && available(requested) ? requested : focusable()[0] ?? dialog;
      initial.focus({ preventScroll: true });
    };
    if (isTop()) focusInitial();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop() || event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape" && options.closeOnEscape !== false) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      event.preventDefault();
      if (candidates.length === 0) {
        dialog.focus();
        return;
      }
      const currentIndex = candidates.indexOf(document.activeElement as HTMLElement);
      const nextIndex = currentIndex < 0
        ? event.shiftKey ? candidates.length - 1 : 0
        : (currentIndex + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length;
      // Keyboard navigation must reveal offscreen controls in scrollable sheets.
      candidates[nextIndex]!.focus();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isTop() && !dialog.contains(event.target as Node)) focusInitial();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      window.requestAnimationFrame(() => {
        // A remount or a newly opened unrelated modal owns focus now.
        if (stack.some((candidate) => candidate.dialog === dialog)) return;
        const current = stack.at(-1)?.dialog;
        if (current && (!previous || !current.contains(previous))) return;
        const focused = document.activeElement;
        if (!current && focused instanceof HTMLElement && focused !== document.body
          && !dialog.contains(focused) && focused !== previous && available(focused)) return;
        // active=false may leave a hidden dialog mounted: ref=null is not a
        // prerequisite for returning to the original trigger.
        if (previous && available(previous)) previous.focus({ preventScroll: true });
      });
    };
  }, [dialogRef, options.active, options.closeOnEscape, options.initialFocus]);
}
