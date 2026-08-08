/**
 * How the shared modal closes — and, more to the point, how it does not.
 *
 * Every dialog in the app is this component, so the rule lives in one place and is worth
 * pinning down there: a backdrop click must not dismiss it. It used to, and that lost work
 * — several of these dialogs hold text the user has typed (a pull request's title and
 * description, a custom prompt), with no warning and no undo when the window went away.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { Modal } from '../components/Modal';

function renderModal(onClose: () => void) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <Modal title="Open a pull request" onClose={onClose} footer={<button>Cancel</button>}>
          <input aria-label="Title" defaultValue="something typed" />
        </Modal>
      </BaseStyles>
    </ThemeProvider>,
  );
}

/** The dimmed area behind the dialog — the dialog's parent in the portal. */
function backdrop(): HTMLElement {
  const el = screen.getByRole('dialog').parentElement;
  if (!el) throw new Error('the dialog has no backdrop');
  return el;
}

describe('Modal', () => {
  it('does not close when the backdrop is clicked', () => {
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.click(backdrop());

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on the ✕', () => {
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /** The keyboard route out of a dialog, and the only one some users have. */
  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The backdrop used to close on any click that reached it, which the dialog stopped from
   * bubbling. With the handler gone that guard went too — so this checks the outcome
   * rather than the mechanism: clicking inside, including on the content, keeps it open.
   */
  it('stays open when its own content is clicked', () => {
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(screen.getByLabelText('Title'));
    fireEvent.click(screen.getByText('Open a pull request'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops listening for Escape once it is gone', () => {
    const onClose = vi.fn();
    const { unmount } = renderModal(onClose);

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
