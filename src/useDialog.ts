import { useLayoutEffect, useRef } from "react";

const layers: HTMLElement[] = [];
const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])';

/** One focus boundary for every modal, including a file review opened above another dialog. */
export function useDialog(onClose: () => void) {
  const element = useRef<HTMLElement | null>(null);
  // Capture before React mounts an autoFocus input.
  const previous = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    layers.push(dialog);
    dialog.tabIndex = -1;
    const hidden: { node: HTMLElement; inert: boolean }[] = [];
    for (let node: HTMLElement | null = dialog; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || !(sibling instanceof HTMLElement)) continue;
        hidden.push({ node: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
    }
    const candidates = () => [...dialog.querySelectorAll<HTMLElement>(focusable)]
      .filter(node => node.tabIndex >= 0 && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
    const focus = () => (candidates()[0] ?? dialog).focus();
    if (!dialog.contains(document.activeElement)) focus();
    const key = (event: KeyboardEvent) => {
      if (layers[layers.length - 1] !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
      } else if (event.key === 'Tab') {
        const nodes = candidates(), first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const contain = (event: FocusEvent) => {
      if (layers[layers.length - 1] === dialog && !dialog.contains(event.target as Node)) focus();
    };
    window.addEventListener('keydown', key, true);
    document.addEventListener('focusin', contain);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', contain);
      layers.splice(layers.indexOf(dialog), 1);
      hidden.forEach(({ node, inert }) => { node.inert = inert; });
      if (previous.current?.isConnected && !previous.current.closest('[inert]')) previous.current.focus();
    };
  }, []);
  return (node: HTMLElement | null) => { element.current = node; };
}
