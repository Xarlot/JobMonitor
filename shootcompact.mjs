import { chromium } from 'playwright';
const OUT = '/tmp/claude-1000/-work-JobMonitor/2e6742ab-60fe-4876-a415-1fbd300fce7b/scratchpad';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: 'light' });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto('http://localhost:5191', { waitUntil: 'networkidle' });
await page.getByText('Fix fuel mixture calc').waitFor({ timeout: 15000 });
await page.getByRole('link', { name: /Flows/ }).click();
await page.getByText('Nightly').first().waitFor({ timeout: 8000 });
// turn on Compact, then expand the Nightly run (build success hidden, deploy failure shown)
await page.getByRole('button', { name: 'Compact' }).first().click();
await page.getByText('Nightly').first().click();
await page.getByText(/hidden \(Compact\)/).waitFor({ timeout: 8000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/24-compact.png` });
console.log('shot 24; errors:', errs.length ? JSON.stringify(errs.slice(0, 6)) : 'none');
await browser.close();
