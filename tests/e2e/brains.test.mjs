import './_setup.mjs';
import { fileURLToPath } from 'node:url';
// Brains & guard-rails: planner model, site playbooks (built-in match + learned notes injected next time),
// blocked domains, "Always on this site", reading PDFs (link + attachment) and scheduled runs.
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8785, B = `http://localhost:${PORT}`;
const PDF = fs.readFileSync(fileURLToPath(new URL('./fixtures/invoice.pdf', import.meta.url)));
let calls = 0, plannerCalls = 0;
const out = { plannerSeen: false, plannerModelUsed: false, playbookSaved: false, playbookInjected: false, builtin: [], blocked: false, trustedAsked: 0, pdfUrlText: false, pdfAttachText: false, scheduledRan: false };
const tc = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + (++calls), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const idOf = (state, re) => { const l = state.split('\n').find(x => re.test(x) && /^\*?\[\d+\]/.test(x)); return l ? +l.match(/^\*?\[(\d+)\]/)[1] : -1; };
function brain(body) {
  const msgs = body.messages;
  const sys = typeof msgs[0].content === 'string' ? msgs[0].content : '';
  if (sys.startsWith('You are the planner')) { plannerCalls++; out.plannerModelUsed = body.model === 'strong-planner'; return { role: 'assistant', content: 'Progress: starting. Next: 1) open the settings page 2) click Save. Pitfall: none.' }; }
  if (sys.startsWith('You check whether')) return { role: 'assistant', content: '{"complete": true}' };
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const task = msgs[tIdx].content, after = msgs.slice(tIdx);
  const tools = after.filter(m => m.role === 'tool'); const n = tools.length; const last = n ? tools[n - 1].content : '';
  const obs = [...after].reverse().find(m => m.role === 'user' && (typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '').startsWith('PAGE STATE'));
  const state = obs ? (typeof obs.content === 'string' ? obs.content : obs.content[0].text) : '';
  if (/planner test/.test(task)) {
    out.plannerSeen ||= after.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('PLANNER (start of the task)'));
    if (n === 0) return tc('navigate', { url: `${B}/settings` });
    if (n === 1) return tc('save_playbook', { domain: `localhost:${PORT}`, notes: '- The Save button is at the bottom of Settings.' });
    if (n === 2) { out.playbookSaved = /"ok":true/.test(last); return tc('done', { answer: 'planned' }); }
  }
  if (/playbook check/.test(task)) {
    if (n === 0) return tc('navigate', { url: `${B}/settings` });
    out.playbookInjected = after.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(`SITE PLAYBOOK for localhost:${PORT}`) && m.content.includes('Save button is at the bottom'));
    return tc('done', { answer: 'checked' });
  }
  if (/blocked test/.test(task)) {
    if (n === 0) return tc('navigate', { url: 'http://blocked.test/' });
    out.blocked = /blocked/.test(last); return tc('done', { answer: 'blocked ok' });
  }
  if (/trusted test/.test(task)) {
    if (n === 0) return tc('navigate', { url: `${B}/settings` });
    if (n === 1 || n === 2) { const all = after.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '').join('\n'); return tc('click', { id: idOf(all, /Delete old backups/) }); }
    return tc('done', { answer: 'trusted ok' });
  }
  if (/read the invoice link/.test(task)) {
    if (n === 0) return tc('read_pdf', { url: `${B}/invoice.pdf` });
    out.pdfUrlText = /Invoice total 1,234\.00 USD/.test(last) && /"pages":2/.test(last); return tc('done', { answer: 'pdf ok' });
  }
  if (/attached invoice/.test(task)) { out.pdfAttachText = /Invoice total 1,234\.00 USD/.test(task) && /2 pages/.test(task); return tc('done', { answer: 'attachment ok' }); }
  if (/scheduled hello/.test(task)) { out.scheduledRan = true; return tc('done', { answer: 'hello from the schedule' }); }
  return tc('done', { answer: 'ok' });
}
const server = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: brain(JSON.parse(b)) }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }
  if (req.url.startsWith('/invoice.pdf')) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PDF); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/settings') ? '<h1>Settings</h1><button onclick="this.textContent=\'Deleted\'">Delete old backups</button><button>Save</button>' : '<h1>Start</h1>');
}); });
await new Promise(r => server.listen(PORT, r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-brains-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1200, height: 800 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const web = ctx.pages()[0]; await web.goto(`${B}/start`);
const v = await ctx.newPage();
const errors = []; v.on('pageerror', e => errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(p => chrome.storage.local.set({ apiKey: 'x', baseUrl: `http://localhost:${p}/v1`, vision: false, notify: false, repeatAlarm: false, plannerModel: 'strong-planner', blockedDomains: 'blocked.test' }), PORT);
out.builtin = await v.evaluate(async () => { const { playbooksFor } = await import('./lib/playbooks.js'); return [...await playbooksFor('https://dash.cloudflare.com/abc/example.com/dns/records'), ...await playbooksFor('https://adsmanager.facebook.com/adsmanager/manage/campaigns'), ...await playbooksFor('https://example.com:2083/cpsess1/frontend/jupiter/index.html')].map(p => p.name); });
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.includes('/start'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`); await v.waitForTimeout(500);
const run = async (text, newChat = true) => {
  if (newChat) { await v.click('#newChatBtn'); await v.waitForTimeout(250); }
  const before = await v.$$eval('.msg.final', n => n.length);
  await v.fill('#input', text); await v.click('#sendBtn');
  await v.waitForFunction(b => document.querySelectorAll('.msg.final').length > b && document.getElementById('light').className.includes('done'), before, { timeout: 60000 });
};
await run('planner test', false);
out.plannerCalls = plannerCalls;
await v.evaluate(() => chrome.storage.local.set({ plannerModel: '' }));
await run('playbook check');
out.playbookUi = await v.evaluate(async () => { document.getElementById('memoryBtn').click(); await new Promise(r => setTimeout(r, 500)); const t = [...document.querySelectorAll('#playbookList .mem-id')].map(x => x.textContent); document.getElementById('tabChat').click(); return t; });
await run('blocked test');
// "Always on this site": the first risky click asks, the second doesn't
await v.click('#newChatBtn'); await v.waitForTimeout(250);
await v.fill('#input', 'trusted test'); await v.click('#sendBtn');
await v.waitForSelector('.card.warn .btn:has-text("Always on this site")', { timeout: 30000 });
out.trustedAsked++;
await v.click('.card.warn .btn:has-text("Always on this site")');
await v.waitForFunction(() => document.getElementById('light').className.includes('done'), null, { timeout: 30000 });
out.trustedPrompts = await v.$$eval('.card.warn', n => n.length);
out.trustedStored = await v.evaluate(async () => (await chrome.storage.local.get('trustedSites')).trustedSites);
await run('read the invoice link');
// PDF attachment
await v.click('#newChatBtn'); await v.waitForTimeout(250);
await v.setInputFiles('#fileInput', fileURLToPath(new URL('./fixtures/invoice.pdf', import.meta.url)));
await v.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 1 && !document.querySelector('.attach-chip.loading'), null, { timeout: 20000 });
out.pdfChip = await v.textContent('.attach-chip');
await v.fill('#input', 'what is the total on the attached invoice'); await v.click('#sendBtn');
await v.waitForFunction(() => [...document.querySelectorAll('.msg.final')].some(x => /attachment ok/.test(x.textContent)), null, { timeout: 30000 });
// Scheduled run (once, in 3 s)
await v.evaluate(async () => { const { saveSchedule } = await import('./lib/schedule.js'); await saveSchedule({ text: 'scheduled hello', name: 'Hello run', repeat: 'once', onceAt: new Date(Date.now() + 3000).toISOString() }); });
out.scheduleUi = await v.evaluate(async () => { document.getElementById('agentsBtn').click(); await new Promise(r => setTimeout(r, 600)); return [...document.querySelectorAll('#scheduleList .card b')].map(x => x.textContent); });
for (let i = 0; i < 40 && !out.scheduledRan; i++) await v.waitForTimeout(500);
await v.waitForTimeout(4000);
out.scheduleHistory = await v.evaluate(async () => { const st = await import('./lib/store.js'); return (await st.listConversations()).map(c => c.title).filter(t => /Hello run/.test(t)); });
out.scheduleAfter = await v.evaluate(async () => { const { loadSchedules } = await import('./lib/schedule.js'); const s = (await loadSchedules())[0]; return { enabled: s.enabled, lastRun: !!s.lastRun, lastConv: !!s.lastConv }; });
out.errors = errors; out.calls = calls;
console.log(JSON.stringify(out, null, 1));
await ctx.close(); server.close();
