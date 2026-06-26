import { chromium } from 'playwright';
const OUT='/tmp/claude-1000/-work-JobMonitor/2e6742ab-60fe-4876-a415-1fbd300fce7b/scratchpad';
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const p=await b.newPage({viewport:{width:980,height:900},deviceScaleFactor:1,colorScheme:'light'});
await p.goto('http://localhost:5191',{waitUntil:'networkidle'});
await p.getByText('Fix fuel mixture calc').waitFor({timeout:15000});
await p.getByRole('link',{name:/Settings/}).click();
await p.getByText('Hide when empty').first().waitFor({timeout:8000});
await p.locator('#root').evaluate(()=>{}); // noop
// scroll to Flows section
await p.getByText('Add flow').scrollIntoViewIfNeeded();
await p.waitForTimeout(300);
await p.screenshot({path:`${OUT}/29-settings-aligned.png`, fullPage:true});
console.log('ok');
await b.close();
