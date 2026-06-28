import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Box, Heading, IconButton, Text } from '@primer/react';
import { XIcon } from '@primer/octicons-react';
import { subtleScrollbarSx } from '../lib/scrollbar';

/**
 * Large, scrollable modal rendered into a body-level portal (so it isn't clipped
 * by the flow card's overflow). Closes on backdrop click and Escape. Bigger than
 * Primer's Dialog (which caps at 640px).
 */
export function Modal({
  title,
  subtitle,
  onClose,
  footer,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <Box
      onClick={onClose}
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        bg: 'rgba(1,4,9,0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        p: [2, 3, 4],
        overflowY: 'auto',
      }}
    >
      <Box
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        sx={{
          mt: [3, 4, 5],
          width: 'min(1080px, 94vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          bg: 'canvas.default',
          color: 'fg.default',
          border: '1px solid',
          borderColor: 'border.default',
          borderRadius: 12,
          boxShadow: 'shadow.large',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 2,
            px: 3,
            py: 3,
            borderBottom: '1px solid',
            borderColor: 'border.default',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Heading as="h2" sx={{ fontSize: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title}
            </Heading>
            {subtitle && (
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
                {subtitle}
              </Text>
            )}
          </Box>
          <IconButton icon={XIcon} aria-label="Close" variant="invisible" onClick={onClose} />
        </Box>

        <Box sx={{ p: 3, overflowY: 'auto', flex: 1, ...subtleScrollbarSx }}>{children}</Box>

        {footer && (
          <Box
            sx={{
              px: 3,
              py: 2,
              borderTop: '1px solid',
              borderColor: 'border.default',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 2,
            }}
          >
            {footer}
          </Box>
        )}
      </Box>
    </Box>,
    document.body,
  );
}
