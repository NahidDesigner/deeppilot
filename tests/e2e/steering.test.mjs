import { fileURLToPath } from 'node:url';
// Steering: "Tell it now" while running (agent + normal task), "Just chat" while paused, "Update & resume".
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8778, B = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0; const log = []; let slow = 3;
const tc = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + calls + Math.random().toString(36).slice(2, 6), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function brain(msgs) {
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const task = msgs[tIdx].content;
  const after = msgs.slice(tIdx);
  const steps = after.filter(m => m.role === 'tool'); const n = steps.length;
  const injected = after.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('UPDATE FROM THE USER')).map(m => m.content.split('working): ')[1].split('\n')[0]);
  const planUpd = (task.split('UPDATES FROM THE USER DURING THIS RUN')[1] || '').split('\nApply')[0];
  const stage = +(task.match(/Stage (\d+) of/) || [])[1];
  const item = +(task.match(/item (\d+) of/) || [])[1] || 0;
  if (!stage) { // normal chat task
    if (/slow chat/.test(task)) { if (n === 0) return tc('wait', { seconds: 3 }); if (n === 1) return tc('wait', { seconds: 0.5 }); return tc('done', { answer: 'chat done; heard: ' + (injected.join('|') || 'nothing') }); }
    return tc('done', { answer: 'Just a chat answer' });
  }
  if (stage === 1) { if (n === 0) return tc('save_items', { items: [1, 2, 3, 4, 5].map(i => ({ name: 'Biz ' + i })) }); return tc('done', { answer: 'saved' }); }
  if (stage === 2) {
    if (n === 0) return tc('navigate', { url: `${B}/p` });
    if (n === 1) return tc('wait', { seconds: slow });
    const all = injected.join(' ') + ' ' + planUpd;
    if (n === 2) { log.push({ item, injected: injected.length, plan: /color/.test(planUpd) ? 'color' : '', vip: /vip/.test(planUpd) }); return tc('record_result', { data: { item, color: /color/.test(all) ? 'blue' : null, tag: /vip/.test(all) ? 'vip' : null } }); }
    return tc('done', { answer: 'ok ' + item });
  }
  if (stage === 3) return tc('done', { answer: 'Summary. Updates applied: ' + (planUpd.match(/\d\. [^\n]+/g) || []).join(' / ') });
}
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', async () => {
    if (req.url === '/v1/chat/completions') {
      calls++; await sleep(150);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: brain(JSON.parse(b).messages) }], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 500, prompt_cache_miss_tokens: 500, completion_tokens: 50 } }));
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>page</h1>');
  });
});
await new Promise(r => server.listen(PORT, r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1100, height: 760 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const webp = ctx.pages()[0]; await webp.goto(`${B}/start`);
const v = await ctx.newPage(); await v.setViewportSize({ width: 400, height: 860 });
const errors = []; v.on('pageerror', e => errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(() => chrome.storage.local.set({ apiKey: 'x', baseUrl: 'http://localhost:8778/v1', vision: false, notify: false, repeatAlarm: false }));
await v.evaluate(async () => { const { saveAgent } = await import('./lib/agents.js'); await saveAgent({ title: 'Biz Checker', parallel: 2, stages: [{ title: 'Find', instructions: 'save_items' }, { title: 'Check', instructions: 'check CURRENT ITEM; record_result', forEach: true }, { title: 'Summary', instructions: 'done with summary' }] }); });
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
await v.waitForTimeout(600);
const idleModes = await v.isHidden('#sendModes');
const send = async t => { await v.fill('#input', t); await v.keyboard.press('Escape'); await v.click('#sendBtn'); };

// A. normal task steer
await send('slow chat task');
await v.waitForFunction(() => !document.getElementById('sendModes').hidden);
const runModes = await v.$$eval('#sendModes .mode', n => n.map(x => x.textContent + (x.classList.contains('on') ? '*' : '')));
await v.click('#sendModes .mode[data-value="steer"]');
const steerLabel = await v.textContent('#sendLabel');
await send('use the blue theme');
const labelAfter = await v.textContent('#sendLabel');
await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 30000 });
const chatFinal = await v.$$eval('.msg.final', n => n.pop()?.textContent);
const noteCard = await v.$$eval('.update-card', n => n.map(x => x.textContent));

// B. agent: steer mid-run
await v.click('#newChatBtn'); await v.waitForTimeout(300);
await send('/biz-checker');
await v.waitForFunction(() => document.querySelectorAll('#runLanes .lane:not(.idle)').length >= 2, null, { timeout: 30000 });
await v.waitForTimeout(700);
await v.click('#sendModes .mode[data-value="steer"]');
await send('also record the color');
await v.waitForFunction(() => /[2-4]\/5 DONE/.test(document.getElementById('runNow').textContent), null, { timeout: 60000 });
await v.click('#runStop');
await v.waitForFunction(() => !document.getElementById('runResume').hidden, null, { timeout: 20000 });
await v.waitForTimeout(500);
const pausedModes = await v.$$eval('#sendModes .mode', n => n.map(x => x.textContent + (x.classList.contains('on') ? '*' : '')));
const pausedLabel = await v.textContent('#sendLabel');
const modeNote = await v.textContent('#modeNote');
await v.screenshot({ path: 'steer-1-paused.png' });
// C. just chat while paused
await v.click('#sendModes .mode[data-value="chat"]');
await send('quick question');
await v.waitForFunction(() => [...document.querySelectorAll('.msg.final')].some(x => x.textContent.includes('Just a chat answer')), null, { timeout: 30000 });
await v.waitForTimeout(500);
const stillPaused = { meta: await v.textContent('#runMeta'), label: await v.textContent('#sendLabel'), modesOn: await v.$$eval('#sendModes .mode.on', n => n.map(x => x.textContent)) };
// D. update & resume
await v.click('#sendModes .mode[data-value="update"]');
slow = 0.5;
await send('tag them vip');
await v.waitForFunction(() => /LANDED/.test(document.getElementById('runMeta').textContent), null, { timeout: 90000 });
await v.waitForTimeout(600);
const done = {
  meta: await v.textContent('#runMeta'), final: await v.$$eval('.msg.final', n => n.pop()?.textContent),
  cards: await v.$$eval('.update-card', n => n.map(x => x.textContent)), modesHidden: await v.isHidden('#sendModes'), label: await v.textContent('#sendLabel'),
};
await v.screenshot({ path: 'steer-2-done.png' });
const results = await v.evaluate(async () => { const st = await import('./lib/store.js'); const l = await st.listConversations(); const c = await st.getConversation(l[0].id); return { updates: c.agentRun.updates.map(u => u.text), res: c.agentRun.results.filter(r => r.item).map(r => r.data) }; });
console.log(JSON.stringify({ idleModes, runModes, steerLabel, labelAfter, chatFinal, noteCard, pausedModes, pausedLabel, modeNote, stillPaused, done, results, log, calls, errors }, null, 1));
await ctx.close(); server.close();
