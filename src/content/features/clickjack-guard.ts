/**
 * Clickjacking guard for extension controls whose host element lives in the
 * page's light DOM. Page CSS or script can make such a host invisible,
 * enlarge it under the cursor, or clip it, so a trusted click on what looks
 * like page content lands on our control. isTrusted cannot tell those apart.
 */

export interface ControlSize {
  min: number;
  max: number;
}

function drawnNormally(element: Element, view: Window): boolean {
  const style = view.getComputedStyle(element);
  const opacity = style.opacity === "" ? 1 : Number(style.opacity);
  const clipPath = style.getPropertyValue("clip-path");
  const filter = style.getPropertyValue("filter");
  return (
    opacity >= 1 &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    (filter === "" || filter === "none") &&
    (clipPath === "" || clipPath === "none")
  );
}

/**
 * True when `control` is drawn at its expected size and neither it, its
 * shadow host, nor the root element is transparent, filtered, or clipped.
 */
export function controlLooksUntampered(
  control: Element,
  host: Element,
  size: ControlSize,
  view: Window = window,
): boolean {
  const rect = control.getBoundingClientRect();
  if (
    rect.width < size.min ||
    rect.height < size.min ||
    rect.width > size.max ||
    rect.height > size.max ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= view.innerWidth ||
    rect.top >= view.innerHeight
  ) {
    return false;
  }
  return [control, host, view.document.documentElement].every((element) =>
    drawnNormally(element, view),
  );
}

interface VisibilityEntry extends IntersectionObserverEntry {
  isVisible?: boolean;
}

/**
 * Track whether `element` is unoccluded and untransformed using
 * IntersectionObserver v2 where the browser has it (Chromium). It also
 * catches an opaque page overlay with pointer-events:none on top of the
 * control, which no style check can see. Elsewhere it reports visible.
 */
export function trackOcclusion(element: Element): {
  isVisible(): boolean;
  disconnect(): void;
} {
  const supported =
    typeof IntersectionObserver === "function" &&
    typeof IntersectionObserverEntry === "function" &&
    "isVisible" in IntersectionObserverEntry.prototype;
  if (!supported) return { isVisible: () => true, disconnect: () => undefined };

  let visible = false;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries as VisibilityEntry[]) {
        visible = entry.isVisible === true;
      }
    },
    { trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  );
  observer.observe(element);
  return { isVisible: () => visible, disconnect: () => observer.disconnect() };
}
