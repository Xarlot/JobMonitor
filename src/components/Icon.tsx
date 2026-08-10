/**
 * Renders an octicon chosen at runtime.
 *
 * Primer 38 removed `Octicon`, and for the call sites that name their icon literally there is
 * nothing to replace: an octicon named literally is just the component itself. What it does not cover
 * is an icon picked from a variable — a status style, a chevron that depends on whether a row is
 * open — because JSX only treats a capitalised name as a component, so `<style.icon />` does not
 * parse and the alternative is a local alias at every one of those sites.
 *
 * This is deliberately the smallest thing that works. It is not a wrapper we are adding on top of
 * Primer; it is the two lines of `Octicon` that this application actually used, kept locally now
 * that Primer no longer ships them.
 */

import type { ComponentProps, ComponentType } from 'react';

type OcticonProps = { size?: number | 'small' | 'medium' | 'large'; className?: string };

export function Icon({
  icon: Component,
  ...rest
}: { icon: ComponentType<OcticonProps> } & ComponentProps<'svg'> & OcticonProps) {
  return <Component {...rest} />;
}
