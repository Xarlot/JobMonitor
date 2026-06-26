import { chromium } from 'playwright';

const OUT = '/tmp/claude-1000/-work-JobMonitor/2e6742ab-60fe-4876-a415-1fbd300fce7b/scratchpad';
const BASE = 'http://localhost:5191';
const token = process.env.GH_TOKEN;
if (!token || token.length < 20) throw new Error('GH_TOKEN missing/short');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

const log = [];
page.on('response', (res) => {
  const u = res.url();
  if (u.includes('api.github.com') && (u.includes('/runs') || u.includes('/actions/workflows'))) {
    log.push(`${res.status()} ${u.replace('https://api.github.com', '')}`);
  }
});
page.on('console', (m) => { if (m.type() === 'error') log.push('CONSOLE_ERR ' + m.text()); });
page.on('pageerror', (e) => log.push('PAGEERR ' + String(e)));
page.on('dialog', (d) => d.accept());

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

await page.getByPlaceholder(/github_pat/).fill(token);
const pw = page.locator('input[type="password"]');
await pw.nth(1).fill('test1234');
await pw.nth(2).fill('test1234');
await page.getByRole('button', { name: /Encrypt|store token/ }).click();
await page.waitForTimeout(800);

// Token stored -> app shows Overview; go back to Settings to configure.
await page.getByRole('link', { name: /Settings/ }).click();
await page.getByLabel('Upstream owner').fill('DevExpress');
await page.getByLabel('Upstream repo').fill('dxvcs');
await page.getByLabel('Fork owner').fill('DevExpress');

await page.getByRole('button', { name: 'Add flow' }).click();
await page.getByLabel('Name', { exact: true }).fill('java-cron');
await page.getByLabel('Workflow name, file, or id').fill('check-pull-request-java');
await page.getByLabel('Branches').fill('2026.1');
await page.getByLabel('workflow_dispatch').check();
await page.getByRole('button', { name: 'Save changes' }).click();
await page.waitForTimeout(1500);

await page.getByRole('link', { name: /Flows/ }).click();
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/diag-flows.png`, fullPage: true });

await page.getByRole('link', { name: /Settings/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Forget token' }).click().catch(() => {});
await page.waitForTimeout(300);

console.log('--- api requests ---');
console.log(log.join('\n') || '(none)');
await browser.close();
