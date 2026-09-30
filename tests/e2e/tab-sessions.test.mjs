import './_setup.mjs';
import { fileURLToPath } from 'node:url';
// v1.4: per-tab sessions in the background engine, panel close/reopen, nudges, streaming.
import http from 'node:http';
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8772;
const B = `http://localhost:${PORT}`;
const page = (t, n) => `<!doctype html><html><head><title>${t}</title></head><body><h1>${t}</h1>${Array.from({ length: n }, (_, i) => `<p>Item ${i + 1}</p>`).join('')}<a href="/next?${t}">Next page</a></body></html>`;

let calls = 0; const st = {}; const log = [];
const call = (name, args, content = '') => ({ content, tool_calls: [{ id: 'c' + calls, name, args: JSON.stringify(args) }] });
function brain(messages) {
  const task = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:')).content;
  const s = st[task] ||= { step: 0 };
  s.step++;
  const last = messages[messages.length - 1];
  if (typeof last.content === 'string' && last.content.startsWith('SYSTEM:')) log.push(`${task.slice(6, 20)} nudged: ${last.content.slice(8, 50)}`);
  if (task.includes('alpha')) {
    // slow task in tab A: several steps with a plain-text reply in the middle and a truncated reply
    if (s.step === 1) return call('navigate', { url: `${B}/alpha` }, 'Going to alpha.');
    if (s.step === 2) return { content: 'I have looked at the page and will now continue with the next part.', finish: 'stop' }; // no tool call!
    if (s.step === 3) return { content: 'Let me write a very long expla', finish: 'length' }; // cut off
    if (s.step === 4) return call('wait', { seconds: 2 });
    if (s.step === 5) return call('wait', { seconds: 2 });
    if (s.step === 6) return call('get_page_text', {});
    return call('done', { answer: 'Alpha finished: ' + JSON.parse([...messages].reverse().find(m => m.role === 'tool').content).title });
  }
  if (task.includes('beta')) {
    if (s.step === 1) return call('navigate', { url: `${B}/beta` });
    if (s.step === 2) return call('create_file', { filename: 'beta.xlsx', content: 'a,b\n1,2' });
    return call('done', { answer: 'Beta finished' });
  }
  return call('done', { answer: 'ok' });
}

function sse(res, m) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const w = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  res.write(': keep-alive\n\n');
  const c = m.content || '';
  if (c) { w({ choices: [{ index: 0, delta: { role: 'assistant', content: c.slice(0, 10) } }] }); w({ choices: [{ index: 0, delta: { content: c.slice(10) } }] }); }
  for (const [i, tc] of (m.tool_calls || []).entries()) {
    const half = Math.floor(tc.args.length / 2);
    w({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args.slice(0, half) } }] } }] });
    w({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.args.slice(half) } }] } }] });
  }
  w({ choices: [{ index: 0, delta: {}, finish_reason: m.finish || (m.tool_calls ? 'tool_calls' : 'stop') }] });
  w({ choices: [], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, completion_tokens: 50 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

let streamed = 0;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    if (req.url === '/v1/chat/completions') {
      calls++;
      const j = JSON.parse(body);
      if (j.stream) streamed++;
      const m = brain(j.messages);
      return setTimeout(() => sse(res, m), 300);
    }
    const name = req.url.split('?')[0].slice(1) || 'home';
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(name, 5));
  });
});
await new Promise(r => server.listen(PORT, r));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1100, height: 760 },
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const errors = [];
const tabA = ctx.pages()[0] || await ctx.newPage(); await tabA.goto(`${B}/startA`);
const tabB = await ctx.newPage(); await tabB.goto(`${B}/startB`);
const tabUser = await ctx.newPage(); await tabUser.goto(`${B}/user-work`);
const helper = await ctx.newPage();
await helper.goto(`chrome-extension://${extId}/permission.html`);
await helper.evaluate(() => chrome.storage.local.set({ apiKey: 'x', verifyDone: false, baseUrl: 'http://localhost:8772/v1', repeatAlarm: false, notify: true }));
const ids = await helper.evaluate(async () => Object.fromEntries((await chrome.tabs.query({})).map(t => [t.url.split('/').pop(), t.id])));
const openView = async (tabId) => {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 400, height: 760 });
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  return p;
};
let viewA = await openView(ids.startA);
const viewB = await openView(ids.startB);
const send = async (v, t) => { await v.fill('#input', t); await v.evaluate(() => document.getElementById('form').requestSubmit()); };

await send(viewA, 'alpha task');
await send(viewB, 'beta task');
await tabUser.bringToFront();
await viewA.waitForTimeout(1500);
// close tab A's panel while its task runs
await viewA.close();
await viewB.waitForSelector('.msg.final', { timeout: 60000 });
const betaFinal = await viewB.textContent('.msg.final');
const betaFile = await viewB.$$eval('.file-card .file-name', ns => ns.map(n => n.textContent));
// wait for alpha to finish in the background, then reopen its panel
await helper.waitForTimeout(9000);
const badgeA = await helper.evaluate(t => chrome.action.getBadgeText({ tabId: t }), ids.startA);
const badgeB = await helper.evaluate(t => chrome.action.getBadgeText({ tabId: t }), ids.startB);
const badgeUser = await helper.evaluate(t => chrome.action.getBadgeText({ tabId: t }), ids['user-work']);
viewA = await openView(ids.startA);
await viewA.waitForSelector('.msg.final', { timeout: 30000 });
const alphaFinal = await viewA.textContent('.msg.final');
const alphaTalk = await viewA.$$eval('.msg.talk', ns => ns.map(n => n.textContent));
const alarmA = await viewA.isVisible('#alarmBar') ? await viewA.textContent('#alarmText') : 'hidden';
const lightA = await viewA.getAttribute('#light', 'class');
await viewA.click('#stopAlarmBtn').catch(() => {});
await viewA.waitForTimeout(300);
const alarmAfter = await viewA.isVisible('#alarmBar');
const urls = await helper.evaluate(async () => (await chrome.tabs.query({})).map(t => t.url));
const activeNow = await helper.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].url);
const meterA = await viewA.textContent('#meterTask');
await viewA.screenshot({ path: 'out14-viewA.png' });

console.log(JSON.stringify({ betaFinal, betaFile, alphaFinal, alphaTalk, alarmA, lightA, alarmAfter, badgeA, badgeB, badgeUser, urls, activeNow, meterA, streamed, calls, log, errors }, null, 1));
await ctx.close(); server.close();
