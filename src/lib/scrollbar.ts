/**
 * A thin, subtle scrollbar for scrollable overlays/dialogs — replaces the chunky
 * default OS scrollbar that looks out of place inside a modal. Themed via Primer's
 * CSS variables so it works in light and dark modes.
 */
export const subtleScrollbarSx = {
  scrollbarWidth: 'thin',
  scrollbarColor: 'var(--borderColor-muted, rgba(110,118,129,0.4)) transparent',
  '&::-webkit-scrollbar': { width: '10px', height: '10px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    backgroundColor: 'var(--borderColor-muted, rgba(110,118,129,0.4))',
    borderRadius: '8px',
    border: '3px solid transparent',
    backgroundClip: 'content-box',
  },
  '&::-webkit-scrollbar-thumb:hover': {
    backgroundColor: 'var(--fgColor-muted, rgba(110,118,129,0.7))',
  },
} as const;
