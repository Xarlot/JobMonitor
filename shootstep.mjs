import { chromium } from 'playwright';
const OUT = '/tmp/claude-1000/-work-JobMonitor/2e6742ab-60fe-4876-a415-1fbd300fce7b/scratchpad';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 940 }, deviceScaleFactor: 2, colorScheme: 'light' });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto('http://localhost:5191', { waitUntil: 'networkidle' });
await page.getByText('Fix fuel mixture calc').waitFor({ timeout: 15000 });
await page.getByRole('link', { name: /Flows/ }).click();
await page.getByText('Nightly').first().waitFor({ timeout: 10000 });
await page.getByText('Nightly').first().click();
await page.getByText('deploy', { exact: true }).waitFor({ timeout: 8000 });
await page.getByRole('button', { name: 'Logs / summary' }).nth(1).click(); // deploy job
await page.getByText('Deploy step failed').waitFor({ timeout: 8000 });
// expand the "Run build" step inside the dialog to load per-step logs
await page.getByText('Run build', { exact: true }).click();
await page.getByText(/aws: command not found/).waitFor({ timeout: 8000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/17-step-logs.png` });
console.log('shot 17; errors:', errs.length ? JSON.stringify(errs.slice(0, 6)) : 'none');
await browser.close();
