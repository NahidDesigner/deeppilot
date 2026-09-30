import { fileURLToPath } from 'node:url';
// Auto-split: a plain chat task; the model calls run_in_parallel itself; helpers run concurrently; results come back.
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8779, B = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITES = Array.from({ length: 8 }, (_, i) => ({ slug: 'x' + (i + 1), name: `Shop ${i + 1}`, email: `hi@shop${i + 1}.test` }));
let calls = 0, inflight = new Set(), maxIn = 0, toolOffered = [], sawPrompt = false, helperPrompts = 0, mainGotResults = null;
const tc = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + calls + Math.random().toString(36).slice(2, 6), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function brain(body) {
  const msgs = body.messages;
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const task = msgs[tIdx].content; const after = msgs.slice(tIdx);
  const steps = after.filter(m => m.role === 'tool'); const n = steps.length; const last = n ? steps[n - 1].content : '';
  const offered = body.tools.some(t => t.function.name === 'run_in_parallel');
  if (task.includes('parallel helper tab')) {
    helperPrompts++;
    if (offered) toolOffered.push('helper-had-tool');
    const item = JSON.parse(task.split(/ITEM \d+ of \d+:\n/)[1].split('\n\n')[0]);
    const id = item.url;
    if (n === 0) { inflight.add(id); maxIn = Math.max(maxIn, inflight.size); return tc('navigate', { url: item.url }); }
    if (n === 1) return tc('wait', { seconds: 2 });
    if (n === 2) return tc('get_page_text', {});
    if (n === 3) return tc('record_result', { data: { name: item.name, email: JSON.parse(last).emails[0] || '' } });
    inflight.delete(id); return tc('done', { answer: 'got it' });
  }
  if (/linkedin/i.test(task)) {
    if (n === 0) return tc('run_in_parallel', { instructions: 'Send a LinkedIn message to this person', items: ['a', 'b', 'c'] });
    return tc('done', { answer: 'linkedin tool said: ' + JSON.parse(last).error });
  }
  sawPrompt = sawPrompt || msgs[0].content.includes('Parallel tabs (run_in_parallel)');
  if (!offered) return tc('done', { answer: 'tool not offered' });
  if (n === 0) return tc('navigate', { url: `${B}/list` });
  if (n === 1) return tc('get_links', { filter: '/shop/' });
  if (n === 2) { const links = JSON.parse(last).links; return tc('run_in_parallel', { instructions: 'Open the shop website and find its email. Return: name, email', items: links.map(l => ({ name: l.text, url: l.url })), max_tabs: 6 }, 'Checking all shops in parallel.'); }
  if (n === 3) { mainGotResults = JSON.parse(last); return tc('create_file', { filename: 'shops.csv', content: 'name,email\n' + mainGotResults.results.map(r => `${r.result.name},${r.result.email}`).join('\n') }); }
  return tc('done', { answer: `Found ${mainGotResults.done} emails.` });
}
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', async () => {
    if (req.url === '/v1/chat/completions') {
      calls++; await sleep(200);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: brain(JSON.parse(b)) }], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 500, prompt_cache_miss_tokens: 500, completion_tokens: 50 } }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/list') return res.end(SITES.map(s => `<a href="/shop/${s.slug}">${s.name}</a><br>`).join(''));
    const s = SITES.find(x => req.url === '/shop/' + x.slug);
    res.end(s ? `<h1>${s.name}</h1><a href="mailto:${s.email}">mail</a>` : 'home');
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
await v.evaluate(() => chrome.storage.local.set({ apiKey: 'x', baseUrl: 'http://localhost:8779/v1', vision: false, notify: false, repeatAlarm: false }));
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
await v.waitForTimeout(600);
const send = async t => { await v.fill('#input', t); await v.keyboard.press('Escape'); await v.click('#sendBtn'); };
await send('find the email of every shop listed and give me a csv');
await v.waitForFunction(() => !document.getElementById('splitBar').hidden && document.querySelectorAll('#splitLanes .lane:not(.idle)').length >= 3, null, { timeout: 30000 });
const during = { name: await v.textContent('#splitName'), meta: await v.textContent('#splitMeta'), lanes: await v.$$eval('#splitLanes .lane', n => n.map(x => x.textContent)), status: await v.textContent('#statusText'), groupTabs: await v.evaluate(async () => (await chrome.tabs.query({})).filter(t => t.groupId !== -1).length) };
await v.screenshot({ path: 'split-1.png' });
await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 60000 });
await v.waitForTimeout(500);
const after = { hidden: await v.isHidden('#splitBar'), final: await v.$$eval('.msg.final', n => n.pop()?.textContent), notes: await v.$$eval('.memnote', n => n.map(x => x.textContent).filter(t => /parallel|Split/i.test(t))), files: await v.$$eval('.file-card .file-name', n => n.map(x => x.textContent)), tabs: await v.evaluate(async () => (await chrome.tabs.query({})).length) };
// sensitive
await v.click('#newChatBtn'); await v.waitForTimeout(300);
await send('message my linkedin people');
await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 30000 });
const liFinal = await v.$$eval('.msg.final', n => n.pop()?.textContent);
// disabled setting
await v.evaluate(() => chrome.storage.local.set({ autoParallel: false }));
await v.waitForTimeout(400);
await v.click('#newChatBtn'); await v.waitForTimeout(300);
await send('find emails again');
await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 30000 });
const offFinal = await v.$$eval('.msg.final', n => n.pop()?.textContent);
const conv = mainGotResults && { done: mainGotResults.done, total: mainGotResults.total, first: mainGotResults.results[0] };
console.log(JSON.stringify({ sawPrompt, during, after, conv, maxIn, helperPrompts, toolOffered, liFinal, offFinal, calls, errors }, null, 1));
await ctx.close(); server.close();
