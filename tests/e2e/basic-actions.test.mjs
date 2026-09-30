import './_setup.mjs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8765;
const log = [];
let calls = 0;
let sawImage = false;
let sawTools = false;

const TEST_PAGE = `<!doctype html><html><head><title>DP Test Form</title></head><body style="font-family:sans-serif;padding:20px">
<h1>Profile</h1>
<label>Your name <input id="n" placeholder="Your name"></label><br><br>
<label>Colour <select id="c"><option>Red</option><option>Blue</option><option>Green</option></select></label><br><br>
<div id="react-like" contenteditable="true" aria-label="Bio" style="border:1px solid #ccc;min-height:30px;width:300px"></div><br>
<button id="s" onclick="document.getElementById('out').textContent='Saved: '+document.getElementById('n').value+' / '+document.getElementById('c').value+' / '+document.getElementById('react-like').innerText">Send profile</button>
<p id="out"></p>
<div style="height:2000px"></div><button>Bottom button</button>
</body></html>`;

function lastState(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      if (Array.isArray(m.content)) { sawImage ||= m.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg')); return m.content[0].text; }
      return m.content;
    }
  }
  return '';
}
function idOf(state, re) {
  const line = state.split('\n').find(l => re.test(l));
  return line ? parseInt(line.match(/^\*?\[(\d+)\]/)[1], 10) : null;
}
const call = (name, args) => ({ role: 'assistant', content: `Doing ${name}`, tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

let lastToolResult = ''; let pageTextResult='';
function script(messages) {
  const state = lastState(messages);
  const tools = messages.filter(m => m.role === 'tool');
  lastToolResult = tools.length ? tools[tools.length - 1].content : '';
  log.push({ step: calls, state: state.slice(0, 1500), lastToolResult: lastToolResult.slice(0, 300) });
  switch (calls) {
    case 1: return call('navigate', { url: `http://localhost:${PORT}/test.html` });
    case 2: return call('type', { id: idOf(state, /Your name/), text: 'Nahid' });
    case 3: return call('select_option', { id: idOf(state, /<select/), option: 'Blue' });
    case 4: return call('type', { id: idOf(state, /"Bio"/), text: 'Hello bio' });
    case 5: return call('click', { id: idOf(state, /Send profile/) });
    case 6: return call('get_page_text', {});
    case 7: pageTextResult = lastToolResult; return call('scroll', { direction: 'down', amount: 3 });
    case 8: {
      const ok = /Bottom button/.test(state);
      return call('done', { answer: `RESULT ${ok ? 'scroll-ok' : 'scroll-FAIL'} :: ${pageTextResult.match(/Saved:[^"\\]*/)?.[0] || 'NO SAVE'}` });
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/test.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(TEST_PAGE); }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const j = JSON.parse(body);
      calls++;
      sawTools ||= Array.isArray(j.tools) && j.tools.length > 10;
      const message = script(j.messages) || { role: 'assistant', content: 'fallback end' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(PORT, r));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1200, height: 800 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
console.log('ext id', extId);

const start = ctx.pages()[0] || await ctx.newPage();
await start.goto('about:blank');
await start.goto(`http://localhost:${PORT}/test.html`).catch(() => {});
await start.goto('https://example.com').catch(() => {});

const panel = await ctx.newPage();
const errors = [];
panel.on('pageerror', e => errors.push(String(e)));
panel.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await panel.goto(`chrome-extension://${extId}/permission.html`);
const webTabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(t => !(t.url || '').startsWith('chrome-extension'))?.id);
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${webTabId}`);
await panel.evaluate(() => chrome.storage.local.set({ apiKey: 'test', verifyDone: false, baseUrl: 'http://localhost:8765/v1', model: 'deepseek-flash', vision: true, confirmRisky: true, maxSteps: 20 }));
await panel.reload();
await start.bringToFront();
// type task into the panel without focusing it visually
await panel.fill('#input', 'Fill the profile form');
await panel.evaluate(() => document.getElementById('form').requestSubmit());
await panel.waitForSelector('.card.warn .btn.primary',{timeout:60000}).then(b=>{console.log('CONFIRM CARD SHOWN'); return b.click();}).catch(e=>console.log('no confirm',e.message));
await panel.waitForSelector('.msg.final, .msg.error', { timeout: 90000 }).catch(() => {});
const finals = await panel.$$eval('.msg.final, .msg.error', ns => ns.map(n => n.className + ': ' + n.textContent));
const actions = await panel.$$eval('.action', ns => ns.map(n => n.textContent));
console.log('ACTIONS', actions);
console.log('FINAL', finals);
console.log('calls', calls, 'sawImage', sawImage, 'sawTools', sawTools);
console.log('panel errors', errors); console.log('status hidden', await panel.$eval('#statusBar', n=>getComputedStyle(n).display), 'settings', await panel.$eval('#settings', n=>getComputedStyle(n).display));
fs.writeFileSync('log.json', JSON.stringify(log, null, 2));
await panel.screenshot({ path: 'panel.png' });
await ctx.close();
server.close();
