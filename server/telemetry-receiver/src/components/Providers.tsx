'use client';

/**
 * Primer's runtime context.
 *
 * Primer 38 renders through CSS modules rather than styled-components, so there is no style
 * registry to wire up and no server-side extraction step — the stylesheet is a static import and
 * the SSR output is already styled. That is the whole reason this application is on Primer 38 while
 * the Job Monitor client is on 36: 36 requires React 18 and styled-components 5, and Next 16
 * requires React 19.
 *
 * `colorMode="auto"` follows the operating system, matching the hand-written CSS in the layout that
 * the server-rendered pages still use for their own elements.
 */

import type { ReactNode } from 'react';
import { BaseStyles, ThemeProvider } from '@primer/react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider colorMode="auto">
      <BaseStyles>{children}</BaseStyles>
    </ThemeProvider>
  );
}
