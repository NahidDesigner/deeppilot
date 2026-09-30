import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8780, B = `http://localhost:${PORT}`, DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0; const seen = [];
const tc = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + calls + Math.random().toString(36).slice(2, 6), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function brain(msgs) {
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const task = msgs[tIdx].content; const n = msgs.slice(tIdx).filter(m => m.role === 'tool').length;
  const inj = msgs.slice(tIdx).filter(m => m.role === 'user' && /^UPDATE FROM THE USER/.test(m.content)).map(m => m.content);
  if (n === 0) seen.push({ task: task.slice(0, 60), csv: task.includes('Shop B,https://b.test'), xlsxLeads: task.includes('Cool Air,Dallas'), xlsxNotes: task.includes('## Sheet: Notes') && task.includes('call monday'), docx: task.includes('Mention free audit.'), png: /att-logo\.png[\s\S]*cannot look at attached images/.test(task), rows: task.includes('3 rows'), extra: task.includes('EXTRA-NOTE-42') });
  if (/slow/.test(task)) { if (n === 0) return tc('wait', { seconds: 3 }); if (n === 1) return tc('wait', { seconds: 0.5 }); return tc('done', { answer: 'slow done; injected note had file: ' + inj.some(x => x.includes('EXTRA-NOTE-42')) }); }
  return tc('done', { answer: 'read files ok' });
}
const server = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', async () => {
  if (req.url === '/v1/chat/completions') { calls++; await sleep(120); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: brain(JSON.parse(b).messages) }], usage: { prompt_tokens: 100, completion_tokens: 10 } })); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('page'); }); });
await new Promise(r => server.listen(PORT, r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1100, height: 760 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const webp = ctx.pages()[0]; await webp.goto(`${B}/start`);
const v = await ctx.newPage(); await v.setViewportSize({ width: 400, height: 860 });
const errors = []; v.on('pageerror', e => errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(() => chrome.storage.local.set({ apiKey: 'x', baseUrl: 'http://localhost:8780/v1', vision: false, notify: false, repeatAlarm: false }));
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
await v.waitForTimeout(600);
// 1. picker with 4 files
await v.setInputFiles('#fileInput', ['att-sites.csv', 'att-leads.xlsx', 'att-brief.docx', 'att-logo.png'].map(f => path.join(DIR, f)));
await v.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 4 && !document.querySelector('.attach-chip.loading'));
const chips = await v.$$eval('.attach-chip', n => n.map(x => x.textContent));
await v.screenshot({ path: 'att-1-chips.png' });
await v.fill('#input', 'work with these files');
await v.click('#sendBtn');
await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 30000 });
const bubble = await v.$$eval('.msg.user .msg-file', n => n.map(x => x.textContent));
const cleared = await v.isHidden('#attachList');
await v.screenshot({ path: 'att-2-sent.png' });
// 2. drag & drop a file while a slow task runs -> Tell it now with attachment
await v.fill('#input', 'slow job'); await v.click('#sendBtn');
await v.waitForTimeout(800);
await v.evaluate(async () => {
  const dt = new DataTransfer(); dt.items.add(new File(['EXTRA-NOTE-42'], 'att-extra.txt', { type: 'text/plain' }));
  const z = document.getElementById('chatView');
  z.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  z.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
});
await v.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 1 && !document.querySelector('.attach-chip.loading'));
await v.click('#sendModes .mode[data-value="steer"]');
await v.click('#sendBtn'); // no text, only file
await v.waitForFunction(() => [...document.querySelectorAll('.msg.final')].some(x => x.textContent.includes('slow done')), null, { timeout: 30000 });
const steerFinal = await v.$$eval('.msg.final', n => n.pop()?.textContent);
const updCard = await v.$$eval('.update-card', n => n.map(x => x.textContent));
// 3. queued message with attachment
await v.fill('#input', 'slow again'); await v.click('#sendBtn');
await v.waitForTimeout(600);
await v.setInputFiles('#fileInput', [path.join(DIR, 'att-sites.csv')]);
await v.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 1 && !document.querySelector('.attach-chip.loading'));
await v.fill('#input', 'queued with csv'); await v.click('#sendBtn');
await v.waitForFunction(() => [...document.querySelectorAll('.msg.final')].length >= 4, null, { timeout: 40000 });
await v.waitForTimeout(500);
const files = await v.evaluate(async () => { const st = await import('./lib/store.js'); const l = await st.listConversations(); const c = await st.getConversation(l[0].id); return c.files.map(f => `${f.name}:${f.attached ? 'att' : ''}:${f.dataUrl ? 'data' : 'text'}`); });
console.log(JSON.stringify({ chips, bubble, cleared, seen, steerFinal, updCard, files, calls, errors }, null, 1));
await ctx.close(); server.close();
