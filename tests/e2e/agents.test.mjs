import './_setup.mjs';
import { fileURLToPath } from 'node:url';
// Agents: build from example, draft with AI, run with inputs, for-each items, retry, pause/resume, files.
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8776, B = `http://localhost:${PORT}`;
const BIZ = [
  { slug: 'cool-a', name: 'Cool A HVAC', email: 'a@coola.test', perf: 34 },
  { slug: 'breeze-b', name: 'Breeze B Air', email: 'hello@breezeb.test', perf: 71 },
  { slug: 'arctic-c', name: 'Arctic C Heating', email: 'info@arcticc.test', perf: 18 },
];
const html = (t, b) => `<!doctype html><html><head><title>${t}</title></head><body>${b}</body></html>`;
function web(u) {
  const url = new URL(u, B);
  if (url.pathname === '/maps') return html('Maps', BIZ.map(b => `<a href="/maps/place/${b.slug}">${b.name}</a><br>`).join(''));
  if (url.pathname.startsWith('/site/')) { const b = BIZ.find(x => url.pathname.includes(x.slug)); return html(b.name, `<h1>${b.name}</h1><a href="mailto:${b.email}">Email</a>`); }
  if (url.pathname === '/psi') { const b = BIZ.find(x => url.searchParams.get('url').includes(x.slug)); return html('PageSpeed', `<h2>Performance ${b.perf}</h2><h2>SEO 80</h2>`); }
  return html('home', 'home');
}
let calls = 0; const trace = []; let failOnce = true; let slowItem3 = true;
const tc = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + calls + Math.random().toString(36).slice(2, 6), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function brain(msgs) {
  if (typeof msgs[0].content === 'string' && msgs[0].content.startsWith('You design multi-stage')) {
    return { role: 'assistant', content: '```json\n' + JSON.stringify({ title: 'Dentist Finder', name: 'dentist-finder', description: 'Find dentists', rules: '- be nice', inputs: [{ name: 'city', default: 'Miami' }], stages: [{ title: 'Find', instructions: 'Find dentists in {city}; save_items', forEach: false }, { title: 'Check', instructions: 'check each; record_result', forEach: true }, { title: 'Report', instructions: 'create_file report.xlsx', forEach: false }] }) + '\n```' };
  }
  const task = [...msgs].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:')).content;
  const steps = msgs.slice(msgs.findLastIndex(m => m.content === task)).filter(m => m.role === 'tool');
  const n = steps.length;
  const last = steps.length ? steps[steps.length - 1].content : '';
  const stage = +(task.match(/Stage (\d+) of/) || [])[1];
  const item = +(task.match(/item (\d+) of/) || [])[1] || 0;
  trace.push(`S${stage}${item ? '.' + item : ''}#${n}`);
  if (stage === 1) {
    if (n === 0) return tc('navigate', { url: `${B}/maps` }, 'Searching the map.');
    if (n === 1) return tc('get_links', { filter: '/maps/place/' });
    if (n === 2) { const links = JSON.parse(last).links; return tc('save_items', { items: links.map(l => ({ name: l.text, maps_url: l.url, website: `${B}/site/${l.url.split('/').pop()}` })) }); }
    return tc('done', { answer: 'Found 3 leads' });
  }
  if (stage === 2) {
    const cur = JSON.parse(task.split('CURRENT ITEM:\n')[1].split('\n\n')[0]);
    if (item === 2 && failOnce) { failOnce = false; return 'HTTP400'; }
    if (n === 0) return tc('navigate', { url: cur.website }, `Checking ${cur.name}.`);
    if (n === 1) return tc('get_page_text', {});
    if (n === 2) { cur._email = JSON.parse(last).emails[0]; stash[item] = cur._email; return tc('navigate', { url: `${B}/psi?url=${encodeURIComponent(cur.website)}` }); }
    if (n === 3) return item === 3 && slowItem3 ? tc('wait', { seconds: 6 }) : tc('get_page_text', {});
    if (n === 4 && item === 3 && slowItem3) return tc('get_page_text', {});
    const recorded = msgs.slice(msgs.findLastIndex(m => m.content === task)).some(m => m.role === 'assistant' && m.tool_calls?.some(t => t.function.name === 'record_result'));
    if (!recorded) { const perf = +(JSON.parse(last).text.match(/Performance (\d+)/) || [])[1]; return tc('record_result', { data: { name: cur.name, website: cur.website, email: stash[item], performance: perf } }); }
    return tc('done', { answer: `Audited ${cur.name}` });
  }
  if (stage === 3) {
    const res = JSON.parse(task.split('RESULTS RECORDED SO FAR (')[1].split('):\n')[1].split('\n\nFILES')[0].split('\n\n')[0]);
    trace.push('results:' + res.length);
    if (n === 0) return tc('create_file', { filename: 'hvac-leads.xlsx', content: JSON.stringify(res.map(r => ({ name: r.name, email: r.email, performance: r.performance }))) });
    if (n === 1) return tc('create_file', { filename: 'hvac-audit.pdf', content: '# Audit\n\n| Name | Perf |\n|---|---|\n' + res.map(r => `| ${r.name} | ${r.performance} |`).join('\n') });
    return tc('done', { answer: 'Files created' });
  }
  if (stage === 4) return tc('done', { answer: '**3 leads**, 3 with email. Weakest: Arctic C Heating (18).' });
  return tc('done', { answer: 'ok' });
}
const stash = {};
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    if (req.url === '/v1/chat/completions') {
      calls++;
      const m = brain(JSON.parse(b).messages);
      if (m === 'HTTP400') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"simulated bad request"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: m }], usage: { prompt_tokens: 2000, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 1000, completion_tokens: 80 } }));
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(web(req.url));
  });
});
await new Promise(r => server.listen(PORT, r));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1100, height: 760 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const webp = ctx.pages()[0]; await webp.goto(`${B}/start`);
const v = await ctx.newPage(); await v.setViewportSize({ width: 420, height: 860 });
const errors = []; v.on('pageerror', e => errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(() => chrome.storage.local.set({ apiKey: 'x', verifyDone: false, baseUrl: 'http://localhost:8776/v1', vision: false, notify: false, repeatAlarm: false }));
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);

// 1. Draft with AI
await v.click('#agentsBtn');
await v.click('#agentForm > summary');
await v.fill('#agDraftText', 'find dentists in miami and check them');
await v.click('#agDraft');
await v.waitForFunction(() => document.getElementById('agMsg').textContent.includes('Draft ready') || document.getElementById('agMsg').textContent.includes('❌'));
const draft = { msg: await v.textContent('#agMsg'), title: await v.inputValue('#agTitle'), stages: await v.$$eval('#agStages .st-title', n => n.map(x => x.value)), each: await v.$$eval('#agStages .st-each', n => n.map(x => x.checked)), inputs: await v.$$eval('#agInputs .input-row', r => r.map(x => x.querySelector('.in-name').value + '=' + x.querySelector('.in-def').value)) };
await v.click('#agSave');
await v.waitForFunction(() => document.getElementById('agMsg').textContent.includes('Saved'));
// 2. Lead Hunter example
await v.waitForTimeout(1300);
await v.click('#agentForm > summary');
await v.click('#agExample');
await v.fill('#agParallel', '1');
await v.click('#agSave');
await v.waitForFunction(() => document.getElementById('agMsg').textContent.includes('Saved'));
await v.waitForTimeout(1300);
const agentRows = await v.$$eval('#agentList .agent-row b', n => n.map(x => x.textContent));
await v.screenshot({ path: 'ag-1-panel.png' });
// 3. Run Lead Hunter with inputs
await v.click('#agentList .agent-row:has-text("Lead Hunter") button[title^="Run "]');
const runInputs = await v.$$eval('#runFormInputs input', n => n.map(x => x.dataset.name + '=' + x.value));
await v.fill('#runFormInputs input[data-name="count"]', '3');
await v.fill('#runFormInputs input[data-name="city"]', 'Dallas, TX');
await v.click('#runGo');
// pause during item 3 (slow wait), then resume
await v.waitForFunction(() => /2\/3 DONE/.test(document.getElementById('runNow')?.textContent || ''), null, { timeout: 90000 });
await v.waitForTimeout(1500);
const barRunning = { now: await v.textContent('#runNow'), meta: await v.textContent('#runMeta'), steps: await v.$$eval('#runSteps span', n => n.map(x => x.className)) };
await v.screenshot({ path: 'ag-2-running.png' });
await v.click('#runStop');
await v.waitForFunction(() => !document.getElementById('runResume').hidden, null, { timeout: 20000 });
const paused = { meta: await v.textContent('#runMeta'), light: await v.getAttribute('#light', 'class') };
slowItem3 = false;
await v.click('#runResume');
await v.waitForFunction(() => /LANDED/.test(document.getElementById('runMeta').textContent), null, { timeout: 90000 });
await v.waitForTimeout(800);
const done = {
  meta: await v.textContent('#runMeta'), now: await v.textContent('#runNow'), steps: await v.$$eval('#runSteps span', n => n.map(x => x.className)),
  alarm: await v.textContent('#alarmText'), files: await v.$$eval('.file-card .file-name', n => n.map(x => x.textContent)),
  stageCards: await v.$$eval('.stage-card b', n => n.map(x => x.textContent)), notes: await v.$$eval('.memnote', n => n.map(x => x.textContent)),
  finalLast: await v.$$eval('.msg.final', n => n.pop()?.textContent), saveSkillLinks: await v.$$eval('.final-actions', n => n.length),
  userTag: await v.$$eval('.msg.user .skill-tag', n => n.map(x => x.textContent)),
};
await v.screenshot({ path: 'ag-3-done.png', fullPage: false });
const xlsxRows = await v.evaluate(async () => {
  const { getConversation } = await import('./lib/store.js');
  const port = null;
  const list = await (await import('./lib/store.js')).listConversations();
  const c = await getConversation(list[0].id);
  return { title: c.title, results: c.agentRun.results.length, status: c.agentRun.status, files: c.files.map(f => f.name), xlsx: c.files.find(f => f.name.endsWith('xlsx'))?.content };
});
// 4. slash-run the drafted agent (just start and stop)
await v.click('#newChatBtn');
await v.waitForTimeout(300);
await v.focus('#input'); await v.keyboard.type('/dent');
await v.waitForSelector('#slashMenu:not([hidden])');
const slashItems = await v.$$eval('.slash-item .n', n => n.map(x => x.textContent));
await v.keyboard.press('Escape');
console.log(JSON.stringify({ draft, agentRows, runInputs, barRunning, paused, done, xlsxRows, slashItems, trace: trace.join(' '), calls, errors }, null, 1));
await ctx.close(); server.close();
