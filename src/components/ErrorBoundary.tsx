import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Feature, Telemetry } from '../lib/telemetry';

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
    // The highest-value crash source in the app: this is the failure a user actually sees, and
    // the component stack usually says which view caused it. The message is deliberately not
    // passed — only the type, the stack and the component path (see docs/telemetry.md).
    Telemetry.reportCrash({
      name: error.name,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
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
                // Worth knowing how often people reach for the escape hatch: a rising count is a
                // signal about storage bugs that nothing else in the telemetry would show.
                Telemetry.featureUsed(Feature.LOCAL_DATA_RESET);
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
