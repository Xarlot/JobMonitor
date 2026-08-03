/**
 * Keeps a scrollable element pinned to its newest content, `tail -f` style.
 *
 * The important half is that it *stops* following once the reader scrolls up:
 * streaming output that yanks the view back to the bottom while someone is reading an
 * earlier line is worse than not following at all. Scrolling back to the bottom
 * re-arms it.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** How close to the bottom still counts as "following". */
const PINNED_SLACK_PX = 24;

export function useStickToBottom<T extends HTMLElement>(
  /** Changes whenever new content arrives — a length, or the text itself. */
  content: unknown,
): RefObject<T> {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const detach = useRef<(() => void) | null>(null);

  // Layout effect so the jump lands in the same frame the content grows, rather than
  // as a visible second step.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Attached here rather than in a mount-time effect: the element these feeds live
    // in doesn't exist until the first line arrives, so a `[]` effect would run while
    // the ref was still null and never bind — leaving `pinned` stuck true and
    // overriding the reader's own scrolling.
    if (!detach.current) {
      const onScroll = () => {
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        pinned.current = fromBottom <= PINNED_SLACK_PX;
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      detach.current = () => el.removeEventListener('scroll', onScroll);
    }

    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  useEffect(
    () => () => {
      detach.current?.();
      detach.current = null;
    },
    [],
  );

  return ref;
}
