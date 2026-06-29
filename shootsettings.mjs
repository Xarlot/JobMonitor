/**
 * Capture the Settings screenshots used in the README, in mock mode + dark theme.
 *
 * Usage:
 *   1. Start the mock dev server:  VITE_MOCK=1 npx vite --port 5191 --strictPort
 *   2. Run this script:            node shootsettings.mjs
 *
 * Writes docs/screenshots/{settings-polling,settings-flow,settings-browse}.png.
 */
import { chromium } from 'playwright';

const OUT = new URL('./docs/screenshots', import.meta.url).pathname;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
// scale 1 keeps output px == CSS px, so heights stay within the 1200px budget.
const page = await browser.newPage({
  viewport: { width: 1100, height: 1200 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

// Force the app's persisted theme to dark (it defaults to "auto").
await page.addInitScript(() => localStorage.setItem('job-monitor.theme', 'dark'));
await page.goto('http://localhost:5191', { waitUntil: 'networkidle' });

// Hide native scrollbars so they don't show as a light strip over the dark UI.
await page.addStyleTag({
  content: '*{scrollbar-width:none!important} *::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}',
});

// Open full-screen Settings via the gear in the header.
await page.getByRole('button', { name: 'Settings' }).click();
const tabs = page.getByRole('navigation', { name: 'Settings sections' });
await tabs.getByText('Repository', { exact: true }).waitFor({ timeout: 10000 });

// --- Repository tab: clip from the top down to just below "Save changes" ---
await tabs.getByText('Repository', { exact: true }).click();
await page.getByText('Upstream owner').waitFor({ timeout: 8000 });
await page.waitForTimeout(300);
const saveBox = await page.getByRole('button', { name: 'Save changes' }).boundingBox();
await page.screenshot({
  path: `${OUT}/settings-polling.png`,
  clip: { x: 0, y: 0, width: 1100, height: Math.ceil(saveBox.y + saveBox.height + 24) },
});

// --- Flows tab: expand the first flow and capture just that one card ---
await tabs.getByText('Flows', { exact: true }).click();
await page.getByRole('button', { name: 'Add flow' }).waitFor({ timeout: 8000 });
await page.getByText('Additional settings').first().click();
await page.getByText('Hide when empty').first().waitFor({ timeout: 8000 });
await page.waitForTimeout(300);
// Bound the clip to the first card using its corner landmarks: the "Name" label
// (top-left), the "Remove flow" button (right edge) and "Hide when empty" (bottom).
const pad = 16;
const nameLabel = await page.getByText('Name', { exact: true }).first().boundingBox();
const trash = await page.getByRole('button', { name: 'Remove flow' }).first().boundingBox();
const hideEmpty = await page.getByText('Hide when empty').first().boundingBox();
const x = Math.max(0, nameLabel.x - pad);
const y = Math.max(0, nameLabel.y - pad);
await page.screenshot({
  path: `${OUT}/settings-flow.png`,
  clip: {
    x,
    y,
    width: trash.x + trash.width + pad - x,
    height: hideEmpty.y + hideEmpty.height + pad - y,
  },
});

// --- Browse dialog (from the first flow's Browse button) — capture just the dialog ---
await page.getByRole('button', { name: /Browse/ }).first().click();
await page.getByText('Browse recent workflows').waitFor({ timeout: 10000 });
await page.getByPlaceholder(/Search name or file/).waitFor({ timeout: 10000 });
await page.getByText('WPF Tests').waitFor({ timeout: 10000 });
await page.waitForTimeout(500);
await page.getByRole('dialog').screenshot({ path: `${OUT}/settings-browse.png` });

console.log('shots done; errors:', errs.length ? JSON.stringify(errs.slice(0, 6)) : 'none');
await browser.close();
