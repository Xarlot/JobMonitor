import { chromium } from 'playwright';
const token = process.env.GH_TOKEN;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const cspViol = [];
page.on('console', (m) => { if (/Content Security|refused|blocked/i.test(m.text())) cspViol.push(m.text()); });
await page.goto('http://localhost:5191/', { waitUntil: 'domcontentloaded' });

// Exactly what ghGetText does: GET with only Authorization, follow redirect, read text.
const result = await page.evaluate(async (tok) => {
  try {
    const r = await fetch(
      'https://api.github.com/repos/DevExpress/dxvcs/actions/jobs/83710574103/logs',
      { headers: { Authorization: 'Bearer ' + tok }, redirect: 'follow', referrerPolicy: 'no-referrer' },
    );
    const text = await r.text();
    return { status: r.status, ok: r.ok, type: r.type, finalUrlHost: 'n/a', length: text.length, head: text.slice(0, 80) };
  } catch (e) {
    return { error: String(e) };
  }
}, token);

console.log('RESULT:', JSON.stringify(result, null, 2));
console.log('CSP/blocked console msgs:', cspViol.length ? cspViol.join(' | ') : 'none');
await browser.close();
