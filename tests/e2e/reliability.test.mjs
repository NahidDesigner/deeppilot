import { fileURLToPath } from 'node:url';
// Reliability: (1) after a search on a single-page app the next page state shows the results that load
// late (no stale reads); (2) a busy page never makes a step hang; (3) going in circles triggers a nudge.
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8781, B = `http://localhost:${PORT}`;
const INBOX = `<!doctype html><html><body><h1>Messaging</h1><input id="q" placeholder="Search messages"><div id="res">Type a name</div>
<script>document.getElementById('q').addEventListener('keydown', e => { if (e.key !== 'Enter') return;
 const v = e.target.value; document.getElementById('res').textContent = 'Searching…'; document.getElementById('res').setAttribute('aria-busy','true');
 setTimeout(() => { const r = document.getElementById('res'); r.removeAttribute('aria-busy'); r.innerHTML = '<button>Open conversation with ' + v + ' — you: Hi ' + v + ', thanks for connecting!</button>'; }, 1200); });</script></body></html>`;
const TICKER = `<!doctype html><html><body><h1>Live prices</h1><div id="t"></div><button>Buy nothing</button><script>setInterval(() => { document.getElementById('t').textContent = 'BTC ' + Math.random(); }, 40);</script></body></html>`;
let calls = 0; const out = { staleFree: null, tickerStepMs: null, warned: false, warnText: '' };
let t0 = 0;
const tc = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + (++calls), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const idOf = (state, re) => +((state.split('\n').find(l => re.test(l)) || '').match(/\[(\d+)\]/) || [])[1];
function brain(msgs) {
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const after = msgs.slice(tIdx); const n = after.filter(m => m.role === 'tool').length;
  const lastObs = [...msgs].reverse().find(m => m.role === 'user' && (typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '').startsWith('PAGE STATE'));
  const state = typeof lastObs?.content === 'string' ? lastObs.content : lastObs?.content?.[0]?.text || '';
  const warn = after.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('SYSTEM: You are going in circles'));
  if (warn && !out.warned) { out.warned = true; out.warnText = warn.content.slice(0, 120); return tc('done', { answer: 'Stopped circling after the nudge.' }); }
  if (n === 0) return tc('navigate', { url: `${B}/inbox` });
  if (n === 1) return tc('type', { id: idOf(state, /Search messages/), text: 'Patrick Ryan', submit: true });
  if (n === 2) { out.staleFree = /Open conversation with Patrick Ryan/.test(state); t0 = Date.now(); return tc('navigate', { url: `${B}/ticker` }); }
  if (n === 3) { out.tickerStepMs = Date.now() - t0; return tc('navigate', { url: `${B}/list` }); }
  // now go in circles: list → inbox → list → inbox …
  return tc('navigate', { url: n % 2 ? `${B}/inbox` : `${B}/list` });
}
const server = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: brain(JSON.parse(b).messages) }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url.startsWith('/inbox') ? INBOX : req.url.startsWith('/ticker') ? TICKER : '<h1>Connections</h1><a href="/p/1">Patrick Ryan</a>');
}); });
await new Promise(r => server.listen(PORT, r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-rel-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const web = ctx.pages()[0]; await web.goto(`${B}/list`);
const v = await ctx.newPage();
const errors = []; v.on('pageerror', e => errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(p => chrome.storage.local.set({ apiKey: 'x', baseUrl: `http://localhost:${p}/v1`, vision: false, notify: false, repeatAlarm: false }), PORT);
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.includes('/list'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`); await v.waitForTimeout(500);
await v.fill('#input', 'check who I already messaged'); await v.click('#sendBtn');
await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 90000 });
out.final = await v.$$eval('.msg.final', n => n.pop()?.textContent);
out.calls = calls; out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await ctx.close(); server.close();
