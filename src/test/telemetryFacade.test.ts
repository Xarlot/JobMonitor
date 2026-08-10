/**
 * The renderer facade.
 *
 * The property that matters most here is a negative one: **with no desktop bridge, nothing
 * happens.** That is what makes the GitHub Pages build genuinely free of telemetry rather than
 * merely configured not to send — no counters accumulate, no interval is created, no listener is
 * registered. Under jsdom there is no `window.desktop`, so the default state of every test in this
 * file is the hosted build, and the inertness assertions are the first ones written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Telemetry, __resetTelemetry, flush, CrashSource } from '../lib/telemetry';
import { Feature, Operation, ErrorCategory } from '@jobmonitor/telemetry-schema/registry';
import type { CrashReport, TelemetryDelta } from '../lib/telemetry/bridge';

interface Captured {
  deltas: TelemetryDelta[];
  crashes: CrashReport[];
}

function mountBridge(): Captured {
  const captured: Captured = { deltas: [], crashes: [] };
  (window as unknown as Record<string, unknown>).desktop = {
    telemetry: {
      flush: (delta: TelemetryDelta) => captured.deltas.push(delta),
      crash: (report: CrashReport) => captured.crashes.push(report),
    },
  };
  __resetTelemetry();
  return captured;
}

function unmountBridge(): void {
  delete (window as unknown as Record<string, unknown>).desktop;
  __resetTelemetry();
}

beforeEach(() => {
  unmountBridge();
});

afterEach(() => {
  unmountBridge();
  vi.restoreAllMocks();
});

describe('the hosted build collects nothing', () => {
  it('records nothing when there is no bridge', () => {
    Telemetry.featureUsed(Feature.FLOW_CREATED);
    Telemetry.operationCompleted(Operation.GH_PR_LIST_POLL, 42);
    Telemetry.operationFailed(Operation.GH_PR_LIST_POLL, ErrorCategory.NETWORK);
    Telemetry.reportCrash({ name: 'TypeError', stack: 'at x' });

    // Nothing accumulated, so a later flush has nothing to hand over. Mounting the bridge now and
    // flushing proves the counters were never stored in the first place.
    const captured = mountBridge();
    flush();
    expect(captured.deltas).toEqual([]);
  });

  it('arms no timer', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const addEventListener = vi.spyOn(window, 'addEventListener');

    for (let i = 0; i < 100; i++) Telemetry.featureUsed(Feature.VIEW_FLOWS);

    // A 15-second interval firing forever to flush nothing is precisely the kind of thing that
    // turns up in someone's battery report and cannot be explained.
    expect(setInterval).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('still runs the measured function and returns its value', () => {
    // Instrumentation must be invisible to behaviour, including when it is disabled.
    return expect(Telemetry.measure(Operation.CONFIG_LOAD, async () => 'value')).resolves.toBe(
      'value',
    );
  });
});

describe('recording', () => {
  it('batches feature counts into one delta', () => {
    const captured = mountBridge();

    Telemetry.featureUsed(Feature.FLOW_CREATED);
    Telemetry.featureUsed(Feature.FLOW_CREATED);
    Telemetry.featureUsed(Feature.VIEW_FLOWS);
    flush();

    expect(captured.deltas).toHaveLength(1);
    expect(captured.deltas[0].features).toEqual(
      expect.arrayContaining([
        [Feature.FLOW_CREATED, 2],
        [Feature.VIEW_FLOWS, 1],
      ]),
    );
  });

  it('sends nothing when there is nothing to send', () => {
    const captured = mountBridge();
    flush();
    flush();
    expect(captured.deltas).toEqual([]);
  });

  it('clears after a flush so nothing is counted twice', () => {
    const captured = mountBridge();

    Telemetry.featureUsed(Feature.FLOW_CREATED);
    flush();
    flush();

    expect(captured.deltas).toHaveLength(1);
  });

  it('collects duration samples per operation', () => {
    const captured = mountBridge();

    Telemetry.operationCompleted(Operation.GH_JOB_LOG_FETCH, 100);
    Telemetry.operationCompleted(Operation.GH_JOB_LOG_FETCH, 250);
    Telemetry.operationCompleted(Operation.CONFIG_LOAD, 5);
    flush();

    const { operations } = captured.deltas[0];
    expect(new Map(operations).get(Operation.GH_JOB_LOG_FETCH)).toEqual([100, 250]);
    expect(new Map(operations).get(Operation.CONFIG_LOAD)).toEqual([5]);
  });

  it('records failures with a category', () => {
    const captured = mountBridge();
    Telemetry.operationFailed(Operation.GH_PR_LIST_POLL, ErrorCategory.RATE_LIMIT);
    flush();
    expect(captured.deltas[0].failures).toEqual([
      [Operation.GH_PR_LIST_POLL, ErrorCategory.RATE_LIMIT],
    ]);
  });
});

describe('measure', () => {
  it('records a completion and returns the value', async () => {
    const captured = mountBridge();

    await expect(Telemetry.measure(Operation.CONFIG_LOAD, async () => 7)).resolves.toBe(7);
    flush();

    expect(new Map(captured.deltas[0].operations).get(Operation.CONFIG_LOAD)).toHaveLength(1);
  });

  it('rethrows, so instrumentation cannot swallow an error', async () => {
    // The failure mode this prevents is the worst kind: adding telemetry to a call site silently
    // changes its error handling.
    const captured = mountBridge();
    const boom = new TypeError('network down');

    await expect(
      Telemetry.measure(Operation.GH_PR_LIST_POLL, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    flush();
    expect(captured.deltas[0].failures).toEqual([
      [Operation.GH_PR_LIST_POLL, ErrorCategory.NETWORK],
    ]);
    // A failure is not also a completion.
    expect(captured.deltas[0].operations).toEqual([]);
  });
});

describe('crash reporting', () => {
  it('sends the name and stack but never a message', () => {
    const captured = mountBridge();
    const error = new TypeError('could not open /home/me/salary.pdf');

    Telemetry.reportCrash({ name: error.name, stack: error.stack });

    expect(captured.crashes).toHaveLength(1);
    expect(captured.crashes[0].name).toBe('TypeError');
    expect(JSON.stringify(captured.crashes[0])).not.toContain('salary');
    expect(captured.crashes[0]).not.toHaveProperty('message');
  });

  it('flushes pending counters first', () => {
    // What the user was doing immediately before a crash is often the whole explanation, and it is
    // about to be lost with the process.
    const captured = mountBridge();

    Telemetry.featureUsed(Feature.AI_TRIAGE_DEEP);
    Telemetry.reportCrash({ name: 'Error', stack: 'at x' });

    expect(captured.deltas).toHaveLength(1);
    expect(captured.deltas[0].features).toEqual([[Feature.AI_TRIAGE_DEEP, 1]]);
  });

  it('defaults to the React boundary source', () => {
    const captured = mountBridge();
    Telemetry.reportCrash({ name: 'Error' });
    expect(captured.crashes[0].source).toBe(CrashSource.REACT_BOUNDARY);
  });
});

describe('failure containment', () => {
  it('never throws when the bridge throws', () => {
    // Nothing in the app awaits a telemetry call, so a broken bridge must be indistinguishable
    // from no telemetry at all.
    (window as unknown as Record<string, unknown>).desktop = {
      telemetry: {
        flush: () => {
          throw new Error('IPC gone');
        },
        crash: () => {
          throw new Error('IPC gone');
        },
      },
    };
    __resetTelemetry();

    Telemetry.featureUsed(Feature.FLOW_CREATED);
    expect(() => flush()).not.toThrow();
    expect(() => Telemetry.reportCrash({ name: 'Error' })).not.toThrow();
  });
});

describe('the API surface', () => {
  it('exposes no way to send a string', () => {
    // The structural guarantee. A generic `track(name, attributes)` is how telemetry systems end
    // up shipping repository and file names — not through malice, but because someone needed one
    // more dimension and a string parameter was right there.
    expect(Object.keys(Telemetry).sort()).toEqual([
      'featureUsed',
      'measure',
      'operationCompleted',
      'operationFailed',
      'reportCrash',
    ]);
    expect((Telemetry as Record<string, unknown>).track).toBeUndefined();
  });
});
