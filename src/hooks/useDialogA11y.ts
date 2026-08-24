// Shared dialog semantics for every modal/overlay in the app: focus moves
// into the panel on open, Tab is trapped inside it, Escape closes it, and
// focus returns to whatever triggered it on close. Attach the returned ref
// to the dialog panel (the content box, not the backdrop) and give that
// element role="dialog"/aria-modal/aria-labelledby.
import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogA11y<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const panelRef = useRef<T>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = (): HTMLElement[] => {
      if (!panel) return [];
      const nodes = panel.querySelectorAll(FOCUSABLE_SELECTOR) as NodeListOf<HTMLElement>;
      return Array.from(nodes).filter((el) => el.offsetParent !== null);
    };

    (focusable()[0] ?? panel)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  return panelRef;
}
