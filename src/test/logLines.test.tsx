import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { LogLines } from '../components/LogLines';

function renderLog(text: string) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <LogLines text={text} />
      </BaseStyles>
    </ThemeProvider>,
  );
}

describe('LogLines', () => {
  /**
   * The marker is the runner's own framing, not part of the message. Leaving it in was
   * what the plain <pre> did, and it is noise on every error line.
   */
  it('drops the workflow-command marker from what is shown', () => {
    renderLog('##[error]Process completed with exit code 1.');
    expect(screen.getByText('Process completed with exit code 1.')).toBeTruthy();
    expect(screen.queryByText(/##\[error\]/)).toBeNull();
  });

  it('renders each line as its own element, so they can be coloured apart', () => {
    // Direct children of the <pre>: sx compiles to classes, so an inline-style check
    // would find nothing.
    const { container } = renderLog('first line\nsecond line');
    expect(container.querySelector('pre')?.children).toHaveLength(2);
  });

  /** Blank lines carry the shape of a log; collapsing them misaligns everything after. */
  it('keeps blank lines as rows', () => {
    const { container } = renderLog('a\n\nb');
    expect(container.querySelector('pre')?.children).toHaveLength(3);
  });

  it('strips the timestamp prefix by default', () => {
    renderLog('2026-07-31T14:11:02.1234567Z Compiling sources...');
    expect(screen.getByText('Compiling sources...')).toBeTruthy();
    expect(screen.queryByText(/2026-07-31T14/)).toBeNull();
  });

  it('shows a short clock time when asked', () => {
    render(
      <ThemeProvider>
        <BaseStyles>
          <LogLines text={'2026-07-31T14:11:02.1234567Z Compiling sources...'} showTimestamps />
        </BaseStyles>
      </ThemeProvider>,
    );
    expect(screen.getByText('14:11:02')).toBeTruthy();
  });

  /** Log text is whatever the build printed; it must never be read as markup. */
  it('renders markup in a log line as text', () => {
    const { container } = renderLog('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
});

describe('the marker stripe', () => {
  const marks = [
    { line: 2, severity: 'error' as const, label: 'the test failed', note: 'The first failure.', text: 'boom' },
    { line: 4, severity: 'warning' as const, label: 'gradle gave up', note: null, text: 'gave up' },
  ];

  function renderMarked(props: Partial<React.ComponentProps<typeof LogLines>> = {}) {
    return render(
      <ThemeProvider>
        <BaseStyles>
          <LogLines text={'one\ntwo\nthree\nfour'} marks={marks} {...props} />
        </BaseStyles>
      </ThemeProvider>,
    );
  }

  /** No findings, no furniture: the stripe is an AI result, not a permanent fixture. */
  it('draws nothing when there are no findings', () => {
    const { container } = renderLog('one\ntwo');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('draws one tick per finding', () => {
    renderMarked();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  /**
   * The tick is how you get to a line without scrolling for it, so it has to be a real
   * control — labelled, focusable, and reporting which finding it is.
   */
  it('reports which finding was clicked', () => {
    const picked: number[] = [];
    renderMarked({ onPickMark: (i: number) => picked.push(i) });
    screen.getByLabelText(/Go to line 4/).click();
    expect(picked).toEqual([1]);
  });

  it('names the line and what was found on it', () => {
    renderMarked();
    expect(screen.getByLabelText('Go to line 2: the test failed')).toBeTruthy();
    expect(screen.getByTitle(/Line 2: the test failed — The first failure\./)).toBeTruthy();
  });

  /** A finding pointing past the end of the text must not take the pane down with it. */
  it('survives a mark beyond the last line', () => {
    expect(() =>
      renderMarked({
        marks: [{ line: 99, severity: 'error', label: 'off the end', note: null, text: 'x' }],
        focusLine: 99,
      }),
    ).not.toThrow();
  });
});
