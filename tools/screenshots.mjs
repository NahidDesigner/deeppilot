// Regenerates the README screenshots in docs/screenshots with a realistic, fully offline demo
// (mock DeepSeek + mock websites; every business name is fictional). Headed Chromium is required:
//   Linux:  xvfb-run -a node tools/screenshots.mjs      macOS/Windows:  node tools/screenshots.mjs
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 8799, B = `http://localhost:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BIZ = [
  ['Lone Star Comfort Air', 'Dallas', 31, 'info@lonestarcomfort.example'],
  ['Bluebonnet Heating & Cooling', 'Austin', 48, 'hello@bluebonnethvac.example'],
  ['Gulf Breeze AC Repair', 'Houston', 22, 'service@gulfbreezeac.example'],
  ['Alamo City Climate Pros', 'San Antonio', 57, 'office@alamoclimate.example'],
  ['Prairie Wind Mechanical', 'Fort Worth', 39, 'contact@prairiewind.example'],
  ['Pecan Valley Air', 'Waco', 64, 'team@pecanvalleyair.example'],
  ['Red River Cooling Co.', 'Plano', 27, 'hi@redrivercooling.example'],
  ['Hill Country HVAC', 'Round Rock', 44, 'book@hillcountryhvac.example'],
].map(([name, city, perf, email], i) => ({ name, city, perf, email, slug: 'b' + i, phone: `(512) 555-01${10 + i}` }));
const slow = { value: 2.5 };

let calls = 0;
const tc = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + (++calls) + Math.random().toString(36).slice(2, 6), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function brain(msgs) {
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const task = msgs[tIdx].content;
  const steps = msgs.slice(tIdx).filter(m => m.role === 'tool');
  const n = steps.length, last = n ? steps[n - 1].content : '';
  const stage = +(task.match(/Stage (\d+) of/) || [])[1];
  if (stage === 1) {
    if (n === 0) return tc('navigate', { url: `${B}/maps?q=hvac+texas` }, 'Searching Google Maps for HVAC companies in Texas.');
    if (n === 1) return tc('get_links', { filter: '/maps/place/' }, 'Collecting the listings.');
    if (n === 2) return tc('save_items', { items: BIZ.map(b => ({ name: b.name, city: b.city, website: `${B}/site/${b.slug}`, phone: b.phone })) }, `Found ${BIZ.length} companies with a website and 4.0+ stars.`);
    return tc('done', { answer: `Found ${BIZ.length} leads` });
  }
  if (stage === 2) {
    const item = JSON.parse(task.split('CURRENT ITEM:\n')[1].split('\n\n')[0]);
    const b = BIZ.find(x => x.name === item.name);
    if (n === 0) return tc('navigate', { url: item.website }, `Opening ${b.name}.`);
    if (n === 1) return tc('get_page_text', {});
    if (n === 2) return tc('navigate', { url: `${B}/psi?u=${b.slug}` }, 'Running a mobile PageSpeed test.');
    if (n === 3) return tc('wait', { seconds: slow.value });
    if (n === 4) return tc('record_result', { data: { name: b.name, city: b.city, email: b.email, phone: b.phone, mobile_performance: b.perf, weaknesses: b.perf < 40 ? 'Slow on mobile; no clear call-to-action' : 'No reviews shown; dated design' } });
    return tc('done', { answer: `Audited ${b.name}: mobile ${b.perf}` });
  }
  if (stage === 3) {
    const rows = BIZ.slice().sort((a, b) => a.perf - b.perf);
    if (n === 0) return tc('create_file', { filename: 'hvac-texas-leads.xlsx', content: JSON.stringify(rows.map(r => ({ Company: r.name, City: r.city, Email: r.email, Phone: r.phone, 'Mobile score': r.perf }))) }, 'Building the Excel file and the PDF report.');
    if (n === 1) return tc('create_file', { filename: 'hvac-texas-audit-report.pdf', content: `# HVAC leads — Texas\n\n8 companies audited on mobile.\n\n| Company | City | Mobile |\n|---|---|---|\n${rows.map(r => `| ${r.name} | ${r.city} | ${r.perf} |`).join('\n')}` });
    return tc('done', { answer: 'Files created' });
  }
  if (stage === 4) return tc('done', { answer: '**8 leads, all with an email.** Weakest mobile sites: **Gulf Breeze AC Repair (22)**, **Red River Cooling Co. (27)** and **Lone Star Comfort Air (31)** — slow pages and no clear call-to-action. Files: `hvac-texas-leads.xlsx`, `hvac-texas-audit-report.pdf`.' });
  return tc('done', { answer: 'Done.' });
}
const page = (t, body) => `<!doctype html><html><head><title>${t}</title><style>body{font:16px system-ui;margin:40px}</style></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', async () => {
    if (req.url === '/v1/chat/completions') {
      await sleep(350);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: brain(JSON.parse(b).messages) }], usage: { prompt_tokens: 6200, prompt_cache_hit_tokens: 5200, prompt_cache_miss_tokens: 1000, completion_tokens: 90 } }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    const u = new URL(req.url, B);
    if (u.pathname === '/maps') return res.end(page('HVAC in Texas — Maps', BIZ.map(x => `<p><a href="/maps/place/${x.slug}">${x.name}</a> · ${x.city} · 4.6★</p>`).join('')));
    const s = BIZ.find(x => u.pathname.endsWith(x.slug) || u.searchParams.get('u') === x.slug);
    if (u.pathname.startsWith('/psi') && s) return res.end(page('PageSpeed Insights', `<h1>Performance ${s.perf}</h1>`));
    if (s) return res.end(page(s.name, `<h1>${s.name}</h1><p>Heating & cooling in ${s.city}. Call ${s.phone}</p><a href="mailto:${s.email}">${s.email}</a>`));
    res.end(page('Welcome', '<h1>My work</h1>'));
  });
});
await new Promise(r => server.listen(PORT, r));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-shots-')), {
  headless: false, args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`], viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2,
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const web = ctx.pages()[0]; await web.goto(`${B}/home`);
const v = await ctx.newPage(); await v.setViewportSize({ width: 420, height: 880 });
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(p => chrome.storage.local.set({ apiKey: 'demo', baseUrl: `http://localhost:${p}/v1`, vision: false, notify: false, repeatAlarm: false, soundDone: 'none', soundAsk: 'none', soundError: 'none' }), PORT);
await v.evaluate(async () => {
  const { saveAgent, EXAMPLE_LEAD_HUNTER } = await import('./lib/agents.js');
  const { saveSkill } = await import('./lib/skills.js');
  const { addMemory } = await import('./lib/memory.js');
  await saveAgent({ ...EXAMPLE_LEAD_HUNTER, parallel: 4 });
  await saveAgent({ title: 'Weekly SEO Check', description: 'Check rankings and site health for my client sites', inputs: [{ name: 'sites', default: 'my client list' }], stages: [{ title: 'Open each site', instructions: 'Open each site and record errors', forEach: true }, { title: 'Report', instructions: 'create_file seo-report.pdf' }], parallel: 4 });
  await saveAgent({ title: 'LinkedIn Thank-You', description: 'Thank every newly accepted connection', stages: [{ title: 'Find new connections', instructions: 'Open My Network and save_items new connections' }, { title: 'Send thank-you', instructions: 'Send the saved template to the CURRENT ITEM on LinkedIn', forEach: true, sequential: true }], parallel: 1 });
  await saveSkill({ name: 'daily-report', description: 'Summarise yesterday\'s analytics', instructions: 'Open analytics and summarise yesterday' });
  await addMemory('Welcome template: "Hi {first name}, thanks for connecting!"');
});
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.includes('/home'))?.id);
const panel = `chrome-extension://${extId}/sidepanel.html?tab=${tabId}`;
const shot = async (name, el) => { await sleep(350); await (el ? v.locator(el) : v).screenshot({ path: path.join(OUT, name) }); console.log('✓', name); };
const setTheme = async t => { await v.evaluate(t => chrome.storage.local.set({ theme: t }), t); await sleep(400); };

await v.goto(panel); await sleep(900);
await shot('01-home-light.png');
await setTheme('dark'); await shot('02-home-dark.png'); await setTheme('light');

await v.click('#agentsBtn'); await sleep(400); await shot('03-agents.png');
await v.click('#agentList .agent-row:has-text("Lead Hunter") button[title^="Edit"]').catch(() => {});
await sleep(400); await v.evaluate(() => document.getElementById('agentForm')?.scrollIntoView()); await shot('04-agent-builder.png');
await v.click('#agentsBtn'); await sleep(300);
await v.click('#agentList .agent-row:has-text("Lead Hunter") button[title^="Run "]');
await v.fill('#runFormInputs input[data-name="city"]', 'Texas');
await v.fill('#runFormInputs input[data-name="count"]', '8');
await v.click('#runGo');
await v.waitForFunction(() => document.querySelectorAll('#runLanes .lane:not(.idle)').length >= 4, null, { timeout: 60000 });
await sleep(1200);
await shot('05-parallel-tabs.png');
await setTheme('dark'); await shot('06-parallel-tabs-dark.png'); await setTheme('light');
await v.click('#sendModes .mode[data-value="steer"]'); await v.fill('#input', 'Also note if the site has an online booking form');
await shot('07-tell-it-now.png');
await v.fill('#input', ''); await v.click('#sendModes .mode[data-value="queue"]');
slow.value = 0.5;
await v.waitForFunction(() => /LANDED/.test(document.getElementById('runMeta').textContent), null, { timeout: 120000 });
await sleep(900);
await v.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
await shot('08-landed-files.png');

// full-page app view
const app = await ctx.newPage(); await app.setViewportSize({ width: 1440, height: 900 });
await app.goto(`chrome-extension://${extId}/sidepanel.html?mode=app`); await sleep(900);
await app.click('#sideList .hist-row', { timeout: 5000 }).catch(() => {});
await sleep(1200);
await app.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
await sleep(300);
await app.screenshot({ path: path.join(OUT, '09-full-page.png') }); console.log('✓ 09-full-page.png');
await app.close();

await v.click('#tabHistory'); await sleep(500); await shot('10-history.png');
await v.click('#settingsBtn'); await sleep(400);
await v.evaluate(() => document.getElementById('syncSection').scrollIntoView({ block: 'start' }));
await shot('11-settings-sync.png');

// attachments composer
await v.click('#tabChat'); await sleep(200); await v.click('#newChatBtn'); await sleep(400);
const FX = path.join(ROOT, 'tests', 'e2e', 'fixtures');
await v.setInputFiles('#fileInput', [path.join(FX, 'att-sites.csv'), path.join(FX, 'att-leads.xlsx')]);
await v.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 2 && !document.querySelector('.attach-chip.loading'));
await v.fill('#input', 'Audit every website in this CSV and add a mobile score column');
await shot('12-attachments.png');

await ctx.close(); server.close();

// README banner: tools/hero.html composes three of the screenshots above.
const b = await chromium.launch();
const hp = await b.newPage({ viewport: { width: 1280, height: 680 }, deviceScaleFactor: 2 });
await hp.goto('file://' + path.join(ROOT, 'tools', 'hero.html')); await sleep(800);
await hp.screenshot({ path: path.join(ROOT, 'docs', 'hero.png') }); await b.close();
console.log('✓ docs/hero.png');
console.log(`Screenshots saved to ${path.relative(ROOT, OUT)}`);
