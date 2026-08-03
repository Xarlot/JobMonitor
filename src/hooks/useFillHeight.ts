/**
 * Height in pixels from an element's top to the bottom of the viewport.
 *
 * Measured rather than computed from a `calc(100vh - …)` offset, because the chrome
 * above varies: the header, the nav, the toolbar row, and an activity panel that
 * comes and goes. A hard-coded offset would be wrong for at least one of those
 * states, and silently wrong again the next time the chrome changes.
 *
 * **Driven by layout, not by renders.** This used to run a `useLayoutEffect` with no
 * dependency array — measuring after *every* render — and relied on an equality guard to
 * stop the resulting feedback loop. That guard only holds while the measurement is stable:
 * open a modal over the page and the measured top alternates between two values, so the
 * guard never fires, every render schedules another, and React aborts with "maximum update
 * depth exceeded". Observing the layout instead removes the render → measure → render
 * cycle at its source: a measurement now happens when something actually moves.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Ignore sub-pixel and one-pixel churn.
 *
 * A scrollbar appearing because the pane grew, then disappearing because it shrank, is a
 * two-state oscillation that an exact-equality guard cannot break. A pixel of slack costs
 * nothing visually and makes that impossible.
 */
const TOLERANCE_PX = 2;

export function useFillHeight(
  ref: RefObject<HTMLElement | null>,
  options: { min?: number; bottomGap?: number } = {},
): number | null {
  const { min = 240, bottomGap = 24 } = options;
  const [height, setHeight] = useState<number | null>(null);
  // Read inside the observer callback, which must not be rebuilt on every measurement.
  const latest = useRef<number | null>(height);
  latest.current = height;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const current = ref.current;
      if (!current) return;
      const top = current.getBoundingClientRect().top;
      const next = Math.max(min, Math.round(window.innerHeight - top - bottomGap));
      if (latest.current !== null && Math.abs(latest.current - next) <= TOLERANCE_PX) return;
      latest.current = next;
      setHeight(next);
    };

    measure();

    // The element's *top* moves when anything above it resizes, which is what has to be
    // watched — its own height is what we are setting, so observing that would be the loop
    // all over again.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    if (el.parentElement) observer.observe(el.parentElement);

    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, min, bottomGap]);

  // One deferred re-measure after mount: fonts, images and late-arriving chrome can shift
  // the top after the first layout pass, and nothing above will have resized to say so.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const current = ref.current;
      if (!current) return;
      const top = current.getBoundingClientRect().top;
      const next = Math.max(min, Math.round(window.innerHeight - top - bottomGap));
      if (latest.current === null || Math.abs(latest.current - next) > TOLERANCE_PX) {
        latest.current = next;
        setHeight(next);
      }
    }, 100);
    return () => window.clearTimeout(id);
  }, [ref, min, bottomGap]);

  return height;
}
