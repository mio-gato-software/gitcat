import { useLayoutEffect, useRef, useState } from "react";

/** Scroll the project strip without changing the selected project or the saved tab order. */
export function useTabOverflow(activeId: string | undefined, layoutKey: string) {
  const navigation = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });

  useLayoutEffect(() => {
    const frame = navigation.current, strip = viewport.current, items = content.current;
    if (!frame || !strip || !items) return;

    const updateEdges = () => {
      // Measure against the space available WITHOUT arrows, so showing the arrows
      // cannot make them persist after the tabs would otherwise fit.
      const overflow = items.scrollWidth > frame.clientWidth + 1;
      const left = overflow && strip.scrollLeft > 1;
      const right = overflow && strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1;
      setEdges(previous => previous.overflow === overflow && previous.left === left && previous.right === right
        ? previous : { overflow, left, right });
    };
    const reveal = (tab: Element | null) => {
      if (!tab) return;
      const bounds = tab.getBoundingClientRect(), visible = strip.getBoundingClientRect();
      if (bounds.left < visible.left || bounds.width > visible.width) strip.scrollLeft += bounds.left - visible.left;
      else if (bounds.right > visible.right) strip.scrollLeft += bounds.right - visible.right;
    };
    const layout = () => {
      reveal(items.querySelector(".window-tab.active"));
      updateEdges();
    };
    const focus = (event: FocusEvent) => {
      reveal((event.target as HTMLElement).closest(".window-tab"));
      updateEdges();
    };
    const wheel = (event: WheelEvent) => {
      // Keep native horizontal trackpad gestures and browser zoom intact.
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || items.scrollWidth <= frame.clientWidth + 1) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1;
      strip.scrollLeft += event.deltaY * unit;
    };
    const observer = new ResizeObserver(layout);
    observer.observe(frame);
    observer.observe(strip);
    observer.observe(items);
    strip.addEventListener("scroll", updateEdges, { passive: true });
    strip.addEventListener("wheel", wheel, { passive: false });
    strip.addEventListener("focusin", focus);
    layout();
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", updateEdges);
      strip.removeEventListener("wheel", wheel);
      strip.removeEventListener("focusin", focus);
    };
  }, [activeId, layoutKey]);

  const scroll = (direction: -1 | 1) => {
    const strip = viewport.current;
    if (!strip) return;
    strip.scrollBy({ left: direction * Math.max(1, strip.clientWidth * .8),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  return { navigation, viewport, content, ...edges, scroll };
}
