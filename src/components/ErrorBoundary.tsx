import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render/lifecycle errors anywhere below it and shows the message
 * (instead of a blank page), so failures are diagnosable. Uses plain inline
 * styles so it renders even if the UI/theme layer is what failed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Job Monitor crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: 'ui-monospace, monospace', maxWidth: 900, margin: '0 auto' }}>
        <h2 style={{ color: '#cf222e' }}>Job Monitor hit an error</h2>
        <p style={{ color: '#57606a' }}>
          The app caught an exception. Details below — “Reset local data” clears cached config /
          tokens / response cache for this site if it’s a storage issue.
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f8fa', padding: 12, borderRadius: 6, overflowX: 'auto' }}>
          {error.message}
          {'\n\n'}
          {error.stack}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => location.reload()} style={{ padding: '6px 12px' }}>
            Reload
          </button>
          <button
            onClick={() => {
              try {
                localStorage.clear();
                indexedDB.deleteDatabase('job-monitor');
              } catch {
                /* ignore */
              }
              location.reload();
            }}
            style={{ padding: '6px 12px' }}
          >
            Reset local data
          </button>
        </div>
      </div>
    );
  }
}
