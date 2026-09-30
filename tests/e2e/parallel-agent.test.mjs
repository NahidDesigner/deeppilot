import { fileURLToPath } from 'node:url';
// Parallel workers: 7 items, 4 tabs, one always-failing item, pause/resume, lanes UI, LinkedIn cap, light default.
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8777, B = `http://localhost:${PORT}`;
const SITES = Array.from({ length: 7 }, (_, i) => ({ slug: 's' + (i + 1), name: `Site ${i + 1}`, perf: 20 + i * 9 }));
const html = (t, b) => `<!doctype html><html><head><title>${t}</title></head><body>${b}</body></html>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0, inflight = new Set(), maxInflight = 0, liMax = 0, liSet = new Set(), slow = true;
const tc = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + (calls) + Math.random().toString(36).slice(2, 6), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function brain(msgs) {
  const task = [...msgs].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:')).content;
  const steps = msgs.slice(msgs.findLastIndex(m => m.content === task)).filter(m => m.role === 'tool');
  const n = steps.length, last = n ? steps[n - 1].content : '';
  const stage = +(task.match(/Stage (\d+) of/) || [])[1];
  const item = +(task.match(/item (\d+) of/) || [])[1] || 0;
  const li = /LinkedIn/.test(task);
  if (stage === 1) {
    if (n === 0) return tc('save_items', { items: (li ? SITES.slice(0, 3) : SITES).map(s => ({ name: s.name, website: `${B}/site/${s.slug}` })) });
    return tc('done', { answer: 'saved' });
  }
  if (stage === 2) {
    const cur = JSON.parse(task.split('CURRENT ITEM:\n')[1].split('\n\n')[0]);
    if (li) { if (n === 0) { liSet.add(item); liMax = Math.max(liMax, liSet.size); return tc('wait', { seconds: 1 }); } liSet.delete(item); return tc('done', { answer: 'ok' }); }
    if (item === 5) return 'HTTP400';
    if (n === 0) { inflight.add(item); maxInflight = Math.max(maxInflight, inflight.size); return tc('navigate', { url: cur.website }, `Checking ${cur.name}.`); }
    if (n === 1) return tc('wait', { seconds: slow ? 3 : 0.5 });
    if (n === 2) return tc('get_page_text', {});
    if (n === 3) { const perf = +(JSON.parse(last).text.match(/Perf (\d+)/) || [])[1]; return tc('record_result', { data: { name: cur.name, perf } }); }
    inflight.delete(item);
    return tc('done', { answer: `Audited ${cur.name}` });
  }
  if (stage === 3) {
    const res = JSON.parse(task.split('RESULTS RECORDED SO FAR (')[1].split('):\n')[1].split('\n\n')[0]);
    if (n === 0) return tc('create_file', { filename: 'audit.csv', content: 'item,name,perf\n' + res.map(r => `${r.item},${r.name},${r.perf}`).join('\n') });
    return tc('done', { answer: 'report ' + res.map(r => r.item).join(',') });
  }
  return tc('done', { answer: 'ok' });
}
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', async () => {
    if (req.url === '/v1/chat/completions') {
      calls++;
      await sleep(250);
      const m = brain(JSON.parse(b).messages);
      if (m === 'HTTP400') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"simulated bad request"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: m }], usage: { prompt_tokens: 2000, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 1000, completion_tokens: 80 } }));
    }
    const s = SITES.find(x => req.url.includes('/site/' + x.slug + ''));
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(s ? html(s.name, `<h1>${s.name}</h1><p>Perf ${s.perf}</p>`) : html('home', 'home'));
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
await v.evaluate(() => chrome.storage.local.set({ apiKey: 'x', baseUrl: 'http://localhost:8777/v1', vision: false, notify: false, repeatAlarm: false }));
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
await v.waitForTimeout(600);
const theme = await v.evaluate(() => document.documentElement.dataset.theme);
// Build via the form to exercise the new fields
await v.click('#agentsBtn');
await v.click('#agentForm > summary');
await v.fill('#agTitle', 'Site Auditor');
const parallelDefault = await v.inputValue('#agParallel');
await v.fill('#agParallel', '4');
await v.fill('#agStages .st-title', 'Collect');
await v.fill('#agStages .st-ins', 'save_items the sites');
await v.click('#agAddStage'); 
await v.fill('#agStages li:nth-child(2) .st-title', 'Audit');
await v.fill('#agStages li:nth-child(2) .st-ins', 'audit the CURRENT ITEM; record_result');
const seqHiddenBefore = await v.isHidden('#agStages li:nth-child(2) .st-seq');
await v.check('#agStages li:nth-child(2) .st-each');
const seqVisibleAfter = await v.isVisible('#agStages li:nth-child(2) .st-seq');
await v.click('#agAddStage');
await v.fill('#agStages li:nth-child(3) .st-title', 'Report');
await v.fill('#agStages li:nth-child(3) .st-ins', 'create_file audit.csv');
await v.click('#agSave');
await v.waitForFunction(() => document.getElementById('agMsg').textContent.includes('Saved'));
const saved = await v.evaluate(async () => (await chrome.storage.local.get('agents')).agents.map(a => ({ name: a.name, parallel: a.parallel, seq: a.stages.map(s => s.sequential) })));
await v.waitForTimeout(1300);
const cardCmd = await v.textContent('#agentList .card-cmd');
await v.screenshot({ path: 'par-0-agents.png' });
await v.click('#agentList .agent-row:has-text("Site Auditor") button[title^="Run "]');
await v.click('#runGo');
// lanes visible while running
await v.waitForFunction(() => !document.getElementById('runLanes').hidden && document.querySelectorAll('#runLanes .lane:not(.idle)').length >= 3, null, { timeout: 30000 });
const lanes = await v.$$eval('#runLanes .lane', n => n.map(x => x.textContent));
const tabsDuring = await v.evaluate(async () => (await chrome.tabs.query({})).filter(t => t.groupId !== -1).length);
const statusDuring = await v.textContent('#statusText').catch(() => '');
await v.screenshot({ path: 'par-1-running.png' });
// pause once 2 items done
await v.waitForFunction(() => /[2-6]\/7 DONE/.test(document.getElementById('runNow').textContent), null, { timeout: 60000 });
await v.click('#runStop');
await v.waitForFunction(() => !document.getElementById('runResume').hidden, null, { timeout: 20000 });
const paused = { now: await v.textContent('#runNow'), meta: await v.textContent('#runMeta'), lanesHidden: await v.isHidden('#runLanes') };
await v.waitForTimeout(800);
const tabsPaused = await v.evaluate(async () => (await chrome.tabs.query({})).length);
slow = false;
await v.click('#runResume');
await v.waitForFunction(() => /LANDED/.test(document.getElementById('runMeta').textContent), null, { timeout: 90000 });
await v.waitForTimeout(800);
const done = {
  final: await v.$$eval('.msg.final', n => n.pop()?.textContent), chips: await v.$$eval('.wchip', n => [...new Set(n.map(x => x.textContent))]),
  skipped: await v.$$eval('.memnote', n => n.map(x => x.textContent).filter(t => /skipped|parallel|Resuming/.test(t))),
  tabsAfter: await v.evaluate(async () => (await chrome.tabs.query({})).length),
};
await v.screenshot({ path: 'par-2-done.png' });
const conv = await v.evaluate(async () => { const st = await import('./lib/store.js'); const l = await st.listConversations(); const c = await st.getConversation(l[0].id); return { results: c.agentRun.results.map(r => r.item), csv: c.files[0]?.content }; });
// LinkedIn agent: capped to 1
await v.evaluate(async () => { const { saveAgent } = await import('./lib/agents.js'); await saveAgent({ title: 'Li Thanks', parallel: 8, stages: [{ title: 'Find', instructions: 'save_items people' }, { title: 'Message', instructions: 'Send a LinkedIn message to the CURRENT ITEM', forEach: true }] }); });
await v.click('#newChatBtn'); await v.waitForTimeout(300);
await v.fill('#input', '/li-thanks'); await v.keyboard.press('Escape'); await v.click('#sendBtn');
// wait for THIS agent (the card still holds the previous run's text until the new one starts)
await v.waitForFunction(() => /Li Thanks/.test(document.getElementById('runName').textContent) && /LANDED/.test(document.getElementById('runMeta').textContent), null, { timeout: 90000 });
const liNote = await v.$$eval('.memnote', n => n.map(x => x.textContent).filter(t => /one at a time/.test(t)));
console.log(JSON.stringify({ theme, parallelDefault, seqHiddenBefore, seqVisibleAfter, saved, cardCmd, lanes, tabsDuring, statusDuring, paused, tabsPaused, done, conv, maxInflight, liMax, liNote, calls, errors }, null, 1));
await ctx.close(); server.close();
