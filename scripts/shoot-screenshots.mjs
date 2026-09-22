/**
 * Regenerate the README's screenshots from mock mode.
 *
 * Mocks rather than a live repository, for three reasons: the shots are reproducible, they
 * contain nobody's real branch names or logins, and the AI features can be shown at all —
 * they need a desktop bridge and a `claude` that answers, neither of which exists in CI or
 * in a browser. The bridge here is a stand-in that returns fixed, obviously-fictional
 * analyses, so a screenshot never implies the model said something it didn't.
 *
 * Usage:
 *   VITE_MOCK=1 npx vite --port 5199 --strictPort &
 *   node scripts/shoot-screenshots.mjs
 *
 * Writes into docs/screenshots/. Pass shot names to regenerate only some of them.
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const BASE = process.env.SHOT_URL ?? 'http://localhost:5199';
const only = process.argv.slice(2);

/** Fixed answers, so the shots are stable and plainly illustrative. */
const BLAME = `### Summary

**Who:** @jdoe (\`a1b2c3d4\`) — 70% confidence
**What happened:** \`ExportToPdfTests.exportsInvoice\` fails the PDF comparison since the font-embedding rewrite.
**When:** first failed in run #418 (2026-07-30 11:40); last good run #417.
**Kind:** commit

The failing assertion compares exporter output, and this is the only commit in the range that touches it. The other two cannot reach the failing code.

### Boundary

Last good: run #417 (\`d4d4d4d\`, 2026-07-30 09:12). First bad: run #418 (\`c3c3c3c\`, 2026-07-30 11:40). Both \`schedule\`.

### Who

| Likelihood | Author | Commit | What they changed | Why it is implicated |
|---|---|---|---|---|
| 70% | @jdoe | \`a1b2c3d4\` | \`PdfExporter.cs\`, \`FontCache.cs\` | The failing assertion compares exporter output; this rewrote the font-embedding path. |
| 25% | @asmith | \`e5f6a7b8\` | \`build.gradle\` | Bumped the PDF library a minor version — could change rendering, but nothing points at it. |
| 5% | @bwong | \`c9d0e1f2\` | \`README.md\` | Documentation only; cannot reach the failing code. |

### What would settle it

Revert \`a1b2c3d4\` on a scratch branch and re-run. If it goes green, that is the answer.`;

const REWRITTEN_LOG = `## Run tests

\`\`\`
ExportToPdfTests > exportsInvoiceWithEmbeddedFonts() FAILED
    org.opentest4j.AssertionFailedError: Expected 0 diffs but got 3
        at ExportToPdfTests.java:88
\`\`\`

*The comparison found three differing pages, so this is a real assertion failure rather than a crash.*

## Runner setup

\`\`\`
##[group]Run ./gradlew test
+ ./gradlew test
> Task :app:compileJava
BUILD SUCCESSFUL in 20s
##[error]Process completed with exit code 1.
\`\`\`

*Cut 412 lines of dependency downloads and compilation chatter.*

## What this log does not show
- the baseline images the comparison used`;

/**
 * The record replies for the two data tasks.
 *
 * The marks' quoted lines are real lines of `mockJobLog`, because that is the whole mechanism:
 * a finding is anchored by finding its text in the log on screen. Invent a line here and the shot
 * would show an empty stripe — correct behaviour, useless picture.
 */
const FAILURE_CAUSE = `<<<FAILURES>>>
cause: three pages differ in the PDF comparison, so ExportToPdfTests fails on a real assertion
source: JUnit XML from artifact \`test-results-exporttopdf\`
failed: 3
note: the report covers the exporttopdf shard only

- kind: assertion
  what: compareExportToPdfPdfs
  group: com.example.reporting.ExportToPdfTests
  where: testing/exporttopdf/ExportToPdfTests.java:88
  message: Expected 0 diffs but got 3

- kind: assertion
  what: exportsInvoiceWithEmbeddedFonts
  group: com.example.reporting.ExportToPdfTests
  where: testing/exporttopdf/ExportToPdfTests.java:104
  message: expected: <0> but was: <3> (page 2, page 5, page 6)

- kind: error
  what: keepsSubsetForReusedFont
  group: com.example.reporting.FontCacheTests
  where: testing/fonts/FontCacheTests.java:51
  message: NullPointerException: Cannot invoke "Subset.glyphs()" because "subset" is null`;

const LOG_MARKS = `<<<MARKS>>>
- text: ExportToPdfTests > compareExportToPdfPdfs FAILED
  line: 8
  severity: error
  label: compareExportToPdfPdfs failed
  note: The first real failure; everything below reports this same test.

- text: Expected 0 diffs but got 3
  line: 9
  severity: error
  label: The comparison found three differing pages
  note: A real assertion, so this is the code and not the runner.

- text: Task :reporting:compareExportToPdf
  line: 7
  severity: notice
  label: Start of the failing Gradle task
  note: Everything before this is setup.

- text: Process completed with exit code 1
  line: 10
  severity: warning
  label: The step exited non-zero
  note: A consequence of the assertion above, not a separate problem.`;

const ANALYSIS =
  '<<<PROBLEM>>>\n' +
  'The `compare-exporttopdf-pdfs` job failed on a **real assertion**, not infrastructure.\n' +
  '`ExportToPdfTests > exportsInvoiceWithEmbeddedFonts()` reported `Expected 0 diffs but got 3` at `ExportToPdfTests.java:88`.\n' +
  'The build compiled and every other test passed.\n' +
  '<<<SOLUTION>>>\n' +
  'Pull the diff artifacts and compare the actual PDF against the baseline.\n' +
  'If the refactor changed `visualtests/baseline/`, regenerate the three affected pages.\n';

/**
 * The quick read's reply: the same prose, plus the records it is now asked for.
 *
 * Shorter than {@link FAILURE_CAUSE} and sourced from the log, which is the honest difference
 * between the two tasks — this pass has no tools, so it lists what the log named and the third
 * failure, whose name is only in the JUnit XML, is not among them. A shot showing both lists
 * identical would imply the artifact pass buys nothing.
 */
const QUICK_ANALYSIS = `${ANALYSIS}
<<<FAILURES>>>
source: the job log
failed: 3

- kind: assertion
  what: compareExportToPdfPdfs
  group: com.example.reporting.ExportToPdfTests
  message: Expected 0 diffs but got 3

- kind: assertion
  what: exportsInvoiceWithEmbeddedFonts
  group: com.example.reporting.ExportToPdfTests
  message: expected: <0> but was: <3> (page 2, page 5, page 6)`;

/** A desktop bridge that answers instantly, so the shots never wait on a model. */
function installBridge(data) {
  window.desktop = {
    platform: 'linux',
    claude: {
      probe: async () => ({
        gh: true,
        ghVersion: 'gh version 2.62.0 (2026-05-01)',
        ghAuthenticated: true,
        claude: true,
        claudeVersion: '2.1.4 (Claude Code)',
      }),
      analyze: async (p) => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const send = (phase, extra) =>
          window.dispatchEvent(
            new MessageEvent('message', { data: { __cp: { requestId: p.requestId, phase, ...extra } } }),
          );
        send('fetching-log', {});
        send('analysing', { activity: '$ gh run list --workflow check-pull-request.yml --branch main' });
        send('analysing', { activity: '$ gh api repos/devexpress/reporting/compare/d4d4d4d...c3c3c3c' });
        send('analysing', { activity: 'read artifacts/test-results/report.trx' });
        send('analysing', { chunk: 'Listing the last 30 runs on main to find where it turned red.' });
        send('analysing', { chunk: '\nComparing the commits in the boundary range against the failing test.' });
        // Long enough for a shot of the progress strip, short enough not to slow the rest.
        if (data.slow === p.depth) await wait(20_000);
        send('done', {});
        const reply = data[p.depth] ?? data.analysis;
        return { ok: true, reply, logTruncated: false, logSource: 'gh' };
      },
      cancel: async () => true,
      onProgress: (cb) => {
        const h = (e) => e.data?.__cp && cb(e.data.__cp);
        window.addEventListener('message', h);
        return () => window.removeEventListener('message', h);
      },
      onLog: () => () => {},
      runLog: async () => ({ ok: true, text: 'x', truncated: false }),
      logs: {
        path: async () => ({
          file: '/home/you/.config/Job Monitor/logs/job-monitor.ndjson',
          dir: '/home/you/.config/Job Monitor/logs',
        }),
        reveal: async () => {},
        write: () => {},
      },
    },
  };
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

async function newPage({ width = 1400, height = 950, slow = null } = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  // Keyed by depth, so the stand-in answers each task with something that task would produce.
  await page.addInitScript(installBridge, {
    blame: BLAME,
    log: REWRITTEN_LOG,
    cause: FAILURE_CAUSE,
    marks: LOG_MARKS,
    quick: QUICK_ANALYSIS,
    analysis: ANALYSIS,
    slow,
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  return page;
}

const nav = (page) => page.getByRole('navigation', { name: 'Main navigation' });

/** Open the Failures tab and focus the one failing job the fixtures provide. */
async function focusFailure(page) {
  await nav(page).getByText('Failures', { exact: true }).click();
  await page.waitForTimeout(2200);
  const job = page.getByText('compare-exporttopdf-pdfs', { exact: true }).first();
  if (!(await job.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /#37977/ }).first().click();
    await page.waitForTimeout(900);
  }
  await job.click();
  await page.waitForTimeout(1600);
}

const shots = {
  async overview(page) {
    await nav(page).getByText('Overview', { exact: true }).click();
    await page.waitForTimeout(2000);
    return page;
  },

  async 'pull-requests'(page) {
    await nav(page).getByText('Pull requests', { exact: true }).click();
    await page.waitForTimeout(2200);
    return page;
  },

  async 'feature-branches'(page) {
    await nav(page).getByText('Feature branches', { exact: true }).click();
    // Two comparisons and a pull request per branch, each its own request.
    await page.waitForTimeout(3000);
    // The fixtures hold two branches, so the default viewport leaves half the shot empty. Shortened
    // rather than cropped to a locator, which would cut off the nav — and the nav is what shows
    // where in the app this is.
    await page.setViewportSize({ width: 1400, height: 470 });
    await page.waitForTimeout(400);
    return page;
  },

  async 'feature-branch-offer'(page) {
    await nav(page).getByText('Feature branches', { exact: true }).click();
    await page.waitForTimeout(3000);
    await page
      .getByRole('button', { name: 'Commit your feature/print-preview to the upstream' })
      .click();
    // The stand-in bridge has no `compose`, so this shot shows the template path — which is what
    // a browser gets, and what the desktop app falls back to. Faking a model-written description
    // here would put words in Claude's mouth in a picture people read as a record.
    await page.waitForTimeout(2600);
    return page.locator('[role=dialog]').first();
  },

  async flows(page) {
    await nav(page).getByText('Flows', { exact: true }).click();
    await page.waitForTimeout(2400);
    return page;
  },

  async failures(page) {
    await focusFailure(page);
    return page;
  },

  async 'failures-log'(page) {
    await focusFailure(page);
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await page.waitForTimeout(1200);
    return page;
  },

  async 'failures-claude-log'(page) {
    await focusFailure(page);
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /^Claude/ }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Rewrite with Claude/ }).click();
    await page.waitForTimeout(1600);
    return page;
  },

  async 'what-failed'(page) {
    await focusFailure(page);
    // The analysis starts itself a moment after a failure is focused; there is nothing to click.
    await page.waitForTimeout(3000);
    await page.mouse.move(700, 820);
    await page.waitForTimeout(400);
    return page;
  },

  async 'ai-progress'(page) {
    await focusFailure(page);
    // Caught mid-run: the strip is what an automatic analysis shows instead of a dialog.
    await page.waitForTimeout(3200);
    return page;
  },

  async 'log-map'(page) {
    await focusFailure(page);
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    // The scan starts on its own now — no button to press, just the wait for it to land.
    await page.waitForTimeout(2200);
    // Walk to the first finding, so the shot shows the stripe, the counter and the note together
    // rather than a stripe nobody has used yet.
    await page.getByRole('button', { name: 'Next failure in the log' }).click();
    // Away from the button, or its tooltip sits over the finding the shot is about.
    await page.mouse.move(700, 820);
    await page.waitForTimeout(700);
    return page;
  },

  async 'who-broke-it'(page) {
    await focusFailure(page);
    await page.getByRole('button', { name: /Who broke it/ }).click();
    await page.waitForTimeout(1800);
    return page.locator('[role=dialog]').first();
  },

  async 'deep-analysis'(page) {
    await focusFailure(page);
    await page.getByRole('button', { name: /Deep analysis/ }).click();
    await page.waitForTimeout(1800);
    return page.locator('[role=dialog]').first();
  },

  async 'settings-ai'(page) {
    await page.getByRole('button', { name: /settings/i }).first().click();
    await page.waitForTimeout(1200);
    await page.getByText('AI integration', { exact: true }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Check AI integration' }).click();
    await page.waitForTimeout(900);
    return page.locator('h2:has-text("AI integration")').locator('..');
  },
};

for (const [name, take] of Object.entries(shots)) {
  if (only.length && !only.includes(name)) continue;
  // One shot exists to catch a run in progress, so its bridge has to be slow on purpose.
  const page = await newPage(name === 'ai-progress' ? { slow: 'cause' } : {});
  try {
    const target = await take(page);
    await target.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`wrote docs/screenshots/${name}.png`);
  } catch (e) {
    console.log(`FAILED ${name}: ${e.message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
}

await browser.close();
