import { describe, expect, it } from 'vitest';
import { describeTestReportHint, testReportHint } from '../lib/testReportHint';

describe('testReportHint', () => {
  /**
   * The exact line from the failure this was built for: a Gradle shard that reported a real test
   * failure and named not one test. Everything downstream — the annotations, the quick read — was
   * correctly reporting that it could not see the names, which is true and useless.
   */
  it('reads Gradle’s pointer to its own report', () => {
    const hint = testReportHint([
      "Execution failed for task ':devexpress-printing-core-tests:test'.",
      '> There were failing tests. See the report at: file:///home/runner/work/dxvcs/dxvcs/Java/devexpress-printing-core-tests/build/reports/tests/test/index.html',
      '##[error]Process completed with exit code 1.',
    ]);
    expect(hint?.tool).toBe('Gradle');
    // The module above the build root is kept: it is what tells two shards' reports apart.
    expect(hint?.where).toBe(
      'devexpress-printing-core-tests/build/reports/tests/test/index.html',
    );
  });

  it('reads Maven’s', () => {
    const hint = testReportHint([
      '[ERROR] Please refer to /home/runner/work/app/target/surefire-reports for the individual test results.',
    ]);
    expect(hint).toEqual({ tool: 'Maven', where: 'app/target/surefire-reports' });
  });

  it('reads the TRX path from dotnet test', () => {
    const hint = testReportHint(['  Results File: /home/runner/work/x/TestResults/_fv-az.trx']);
    expect(hint?.tool).toBe('dotnet test');
    expect(hint?.where).toMatch(/TestResults\/_fv-az\.trx$/);
  });

  /**
   * The narrowness is the point. A pytest or Jest log carries its own failures, so claiming the
   * detail is elsewhere would send a reader after an artifact they do not need — and would put a
   * false sentence on the one screen this feature exists to make trustworthy.
   */
  it('says nothing about a log that carries its own failures', () => {
    expect(
      testReportHint([
        'FAILED tests/test_export.py::test_rotated_page - assert 0 == 3',
        '=== 1 failed, 40 passed in 12.4s ===',
      ]),
    ).toBeNull();
    expect(testReportHint([])).toBeNull();
    expect(testReportHint(['See the report at: nothing about tests here'])).toBeNull();
  });

  it('phrases it the same way wherever it is shown', () => {
    expect(describeTestReportHint({ tool: 'Gradle', where: 'build/reports/tests/test' })).toMatch(
      /Gradle wrote them to build\/reports\/tests\/test/,
    );
  });
});
