import { chromium } from 'playwright';
const OUT = '/tmp/claude-1000/-work-JobMonitor/2e6742ab-60fe-4876-a415-1fbd300fce7b/scratchpad';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto('http://localhost:5191', { waitUntil: 'networkidle' });
await page.getByText('Fix fuel mixture calc').waitFor({ timeout: 15000 });

// PR check timeline (from Overview -> PRs tab)
await page.getByRole('link', { name: /Pull requests/ }).click();
await page.getByText('Fix fuel mixture calc').first().waitFor({ timeout: 8000 });
await page.getByRole('button', { name: 'PR check timeline' }).first().click();
await page.getByText(/Bars show each item/).waitFor({ timeout: 8000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/21-pr-timeline.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Flow run timeline
await page.getByRole('link', { name: /Flows/ }).click();
await page.getByText('Nightly').first().waitFor({ timeout: 8000 });
await page.getByRole('button', { name: 'Run timeline' }).nth(2).click(); // Nightly run (#1003)
await page.getByText(/job timeline/).waitFor({ timeout: 8000 });
await page.getByText(/deploy/).first().waitFor({ timeout: 8000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/22-flow-timeline.png` });
console.log('shots done; errors:', errs.length ? JSON.stringify(errs.slice(0, 6)) : 'none');
await browser.close();
