import { chromium } from 'playwright';
const OUT = '/tmp/claude-1000/-work-JobMonitor/2e6742ab-60fe-4876-a415-1fbd300fce7b/scratchpad';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: 'light' });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto('http://localhost:5191', { waitUntil: 'networkidle' });
await page.getByText('Fix fuel mixture calc').waitFor({ timeout: 15000 });
await page.getByRole('link', { name: /Flows/ }).click();
await page.getByText('Nightly').first().waitFor({ timeout: 8000 });
await page.getByRole('button', { name: 'Run summary' }).nth(2).click(); // Nightly run
await page.getByText('Needs attention').waitFor({ timeout: 8000 });
await page.getByText('Deploy step failed').waitFor({ timeout: 8000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/25-run-summary.png` });
console.log('shot 25; errors:', errs.length ? JSON.stringify(errs.slice(0, 6)) : 'none');
await browser.close();
