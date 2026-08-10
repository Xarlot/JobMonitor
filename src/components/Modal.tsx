import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Heading, IconButton, Text } from '@primer/react';
import { XIcon } from '@primer/octicons-react';
import { subtleScrollbar } from '../lib/scrollbar';
import styles from './Modal.module.css';

/**
 * Large, scrollable modal rendered into a body-level portal (so it isn't clipped
 * by the flow card's overflow). Bigger than Primer's Dialog (which caps at 640px).
 *
 * **Closing is deliberate only: the ✕, or Escape.** A backdrop click used to close it too,
 * and that was wrong here — these dialogs hold work. Several carry text the user has typed
 * (a pull request's title and description, a custom prompt) and a mis-aimed click threw it
 * away with no warning and no undo; others are mid-operation, where dismissing the window
 * looks like cancelling something that is in fact still running.
 *
 * Escape stays, because it is the keyboard route out of a dialog and the only one screen
 * reader and keyboard users have. It is also not something you hit by missing.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  footer,
  children,
  width = 'min(1080px, 94vw)',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    // No onClick: the backdrop dims and blocks, it does not dismiss.
    <div
      className={styles.overlay}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={styles.panel} style={{ width }}
      >
        <div
          className={styles.flexGap2}
        >
          <div className={styles.grow}>
            <Heading as="h2" className={styles.title}>
              {title}
            </Heading>
            {subtitle && (
              <Text className={styles.smallFgMuted}>
                {subtitle}
              </Text>
            )}
          </div>
          <IconButton icon={XIcon} aria-label="Close" variant="invisible" onClick={onClose} />
        </div>

        <div className={`${styles.body} ${subtleScrollbar}`}>{children}</div>

        {footer && (
          <div
            className={styles.px3Py2}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
