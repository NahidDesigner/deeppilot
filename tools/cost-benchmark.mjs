// Token/cost meter: same scripted 24-step task, run against a given extension build.
// Simulates DeepSeek's prefix cache: the part of a request that matches the start of an earlier request is "hit".
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = process.argv[2], PORT = 8790 + (+process.argv[3] || 0), B = `http://localhost:${PORT}`;
const TASKS = +process.argv[4] || 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = () => `<!doctype html><html><body><h1>Directory</h1>${Array.from({ length: 180 }, (_, i) => i % 3 ? `<a href="/p/${i}">Company number ${i} — HVAC services and more</a><br>` : `<button>Contact company ${i}</button>`).join('')}<p>${'Lorem ipsum dolor sit amet consectetur. '.repeat(400)}</p><input placeholder="Search"></body></html>`;
const SCRIPT = [
  ['navigate', () => ({ url: `${B}/dir` })], ['get_page_text', () => ({})], ['scroll', () => ({ direction: 'down' })], ['click', () => ({ id: 3 })],
  ['go_back', () => ({})], ['type', () => ({ id: 1, text: 'hvac' })], ['get_links', () => ({ filter: '/p/' })], ['navigate', () => ({ url: `${B}/p/1` })],
  ['get_page_text', () => ({})], ['update_notes', () => ({ notes: '[x] 1 [ ] 2 [ ] 3' })], ['navigate', () => ({ url: `${B}/p/2` })], ['get_page_text', () => ({})],
  ['scroll', () => ({ direction: 'down' })], ['click', () => ({ id: 5 })], ['navigate', () => ({ url: `${B}/p/3` })], ['get_page_text', () => ({})],
  ['scroll', () => ({ direction: 'up' })], ['click', () => ({ id: 2 })], ['navigate', () => ({ url: `${B}/dir` })], ['scroll', () => ({ direction: 'down' })],
  ['click', () => ({ id: 7 })], ['go_back', () => ({})], ['create_file', () => ({ filename: 'x.csv', content: 'a,b\n1,2' })],
];
let calls = 0; const reqs = [];
const tc = (name, args) => ({ role: 'assistant', content: 'Next step.', reasoning_content: 'I should think about this carefully. '.repeat(40), tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function brain(msgs) {
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const n = msgs.slice(tIdx).filter(m => m.role === 'tool').length;
  if (n < SCRIPT.length) { const [name, a] = SCRIPT[n]; return tc(name, a()); }
  return tc('done', { answer: 'done' });
}
function measure(body) {
  let images = 0;
  const text = JSON.stringify({ tools: body.tools, messages: body.messages.map(m => Array.isArray(m.content) ? { ...m, content: m.content.map(p => (p.type === 'image_url' ? (images++, { img: p.image_url.url.length }) : p)) } : m) });
  let best = 0;
  for (const prev of reqs) { let i = 0; const L = Math.min(prev.length, text.length); while (i < L && prev.charCodeAt(i) === text.charCodeAt(i)) i++; if (i > best) best = i; }
  reqs.push(text);
  const last = body.messages[body.messages.length - 1];
  const fresh = Array.isArray(last.content) && last.content.some(p => p.type === 'image_url') ? 1 : 0;
  return { chars: text.length, hit: best, images: fresh };
}
const stats = [];
const server = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', async () => {
  if (req.url === '/v1/chat/completions') { calls++; const body = JSON.parse(b); stats.push(measure(body)); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: brain(body.messages) }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page()); }); });
await new Promise(r => server.listen(PORT, r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dpc-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1280, height: 800 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const webp = ctx.pages()[0]; await webp.goto(`${B}/start`);
const v = await ctx.newPage();
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(p => chrome.storage.local.set({ apiKey: 'x', baseUrl: `http://localhost:${p}/v1`, vision: true, notify: false, repeatAlarm: false, confirmRisky: false }), PORT);
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`); await sleep(600);
for (let t = 0; t < TASKS; t++) {
  await v.fill('#input', `task number ${t + 1}`); await v.click('#sendBtn');
  await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 120000 });
  await sleep(300);
}
// tokens ≈ chars/3.6; image ≈ 1100 tokens (never cached when new)
const tok = c => c / 3.6;
let hit = 0, miss = 0, imgs = 0, maxReq = 0;
for (const s of stats) { hit += tok(s.hit); miss += tok(s.chars - s.hit); imgs += s.images; maxReq = Math.max(maxReq, tok(s.chars)); }
const imgTok = imgs * 1100;   // images inside the uncached part are billed as misses
const cost = (hit * 0.006 + miss * 0.30 + imgTok * 0.30) / 1e6; // each new screenshot is billed once as fresh input
console.log(JSON.stringify({ build: path.basename(EXT), requests: stats.length, avgTokens: Math.round((hit + miss) / stats.length), maxRequest: Math.round(maxReq), hitTokens: Math.round(hit), missTokens: Math.round(miss), imagesSent: imgs, estCostUSD: +cost.toFixed(5) }));
await ctx.close(); server.close();
