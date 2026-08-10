'use client';

/**
 * The date range control.
 *
 * **The first client component in this application, and it earns it.** Everything else is server
 * rendered with no JavaScript at all; this needs to read the current URL and write a new one
 * without a full navigation, which is not something markup can do.
 *
 * It holds no state of its own beyond what is being typed. The selected range lives in the URL, so
 * the server components re-run their queries on navigation and there is no possibility of the
 * control and the charts disagreeing about what is being shown.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, SegmentedControl, Spinner, TextInput } from '@primer/react';

/*
 * Layout is plain CSS, from the stylesheet in the root layout.
 *
 * Primer 38 removed the `sx` prop along with styled-components — components are styled with CSS
 * modules now. What is still worth taking from it is the interactive parts: a segmented control, a
 * date input and a spinner that match the rest of the design system and handle their own keyboard
 * and accessibility behaviour. Positioning them is not something a component library needs to do.
 */

import { PRESETS, resolveRange, toDayString } from '@/lib/range';

export function RangeControl() {
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Resolved here as well as on the server, deliberately.
   *
   * A layout is not given `searchParams`, so the alternative would be repeating this strip in
   * every page. Duplicating the resolution is safe because it is pure and the inputs are the same
   * URL: preset labels are constant strings, and a custom label comes from the two dates in the
   * query. The only thing that differs is `now` by a few milliseconds, which no label shows.
   */
  const range = resolveRange(Object.fromEntries(params.entries()));
  // `useTransition` so the pending state is real: navigation re-runs the server queries, and
  // without this the control would look inert for however long that takes.
  const [pending, startTransition] = useTransition();

  const [customFrom, setCustomFrom] = useState(() => toDayString(range.from));
  const [customTo, setCustomTo] = useState(() => toDayString(range.to));

  const navigate = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      startTransition(() => router.push(query ? `?${query}` : '?', { scroll: false }));
    },
    [router],
  );

  const choosePreset = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('range', id);
      // A preset and an explicit window are alternatives, not layers. Leaving the old dates behind
      // would make the URL say two contradictory things, and `resolveRange` prefers the dates.
      next.delete('from');
      next.delete('to');
      navigate(next);
    },
    [navigate, params],
  );

  const applyCustom = useCallback(() => {
    const next = new URLSearchParams(params.toString());
    next.set('from', customFrom);
    next.set('to', customTo);
    next.delete('range');
    navigate(next);
  }, [navigate, params, customFrom, customTo]);

  const selectedIndex = PRESETS.findIndex((p) => p.id === range.preset);

  return (
    <div className="range">
      <SegmentedControl aria-label="Time range" size="small">
        {PRESETS.map((preset, i) => (
          <SegmentedControl.Button
            key={preset.id}
            selected={i === selectedIndex}
            onClick={() => choosePreset(preset.id)}
          >
            {preset.id}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>

      <div className="range-custom">
        <TextInput
          type="date"
          size="small"
          aria-label="From"
          value={customFrom}
          onChange={(e) => setCustomFrom(e.target.value)}
        />
        <span className="range-dash">—</span>
        <TextInput
          type="date"
          size="small"
          aria-label="To"
          value={customTo}
          onChange={(e) => setCustomTo(e.target.value)}
        />
        <Button size="small" onClick={applyCustom} disabled={!customFrom || !customTo || pending}>
          Apply
        </Button>
      </div>

      {/*
        The resolved range, not what was typed. A custom window is clamped to a year and reversed
        dates are swapped, so what the server actually queried can differ from the inputs — and the
        reader deserves to see the former.
      */}
      <div className="range-status">
        {pending && <Spinner size="small" />}
        <span>
          Showing <strong>{range.label}</strong> <span className="range-tz">UTC</span>
        </span>
      </div>
    </div>
  );
}
