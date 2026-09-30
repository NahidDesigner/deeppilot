import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8770;
const B = `http://localhost:${PORT}`;
const OUT = path.resolve('out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

// ---------------- fake web ----------------
const COS = [
  { slug: 'lone-star-air', name: 'Lone Star Air & Heat', phone: '(214) 555-0101', email: 'info@lonestarair.test' },
  { slug: 'austin-cool', name: 'Austin Cool Pros', phone: '(512) 555-0199', email: 'service@austincool.test' },
  { slug: 'houston-hvac', name: 'Houston HVAC, Inc.', phone: '(713) 555-0142', email: 'hello@houstonhvac.test' },
];
const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body style="font-family:sans-serif;padding:16px">${body}</body></html>`;
function web(url) {
  if (url.startsWith('/maps?')) return html('HVAC texas - Maps', `<h1>Results</h1>${COS.map(c => `<div><a href="/maps/place/${c.slug}" aria-label="${c.name}">${c.name}</a> ★4.8</div>`).join('')}`);
  let m;
  if ((m = url.match(/^\/maps\/place\/([\w-]+)/))) {
    const c = COS.find(x => x.slug === m[1]);
    return html(c.name + ' - Maps', `<h1>${c.name}</h1><p>HVAC contractor</p><button>Call ${c.phone}</button><a href="/site/${c.slug}">Website</a>`);
  }
  if ((m = url.match(/^\/site\/([\w-]+)\/contact/))) {
    const c = COS.find(x => x.slug === m[1]);
    return html('Contact ' + c.name, `<h1>Contact us</h1><a href="mailto:${c.email}">Email us</a>`);
  }
  if ((m = url.match(/^\/site\/([\w-]+)/))) {
    const c = COS.find(x => x.slug === m[1]);
    return html(c.name, `<h1>${c.name}</h1><a href="/site/${c.slug}/contact">Contact</a>`);
  }
  return null;
}

// ---------------- fake Supabase ----------------
const rows = new Map();
let authHeaderOk = true;
function supabase(req, body, res) {
  const u = new URL(req.url, B);
  if (u.pathname === '/auth/v1/token') {
    const j = JSON.parse(body || '{}');
    if (j.password !== 'secret123') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error_description: 'Invalid login credentials' })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user: { id: 'u1', email: j.email } }));
  }
  if (u.pathname === '/rest/v1/dp_conversations') {
    if (req.headers.authorization !== 'Bearer tok' || req.headers.apikey !== 'anon') authHeaderOk = false;
    if (req.method === 'POST') { for (const r of JSON.parse(body)) rows.set(r.id, { ...rows.get(r.id), ...r }); res.writeHead(201); return res.end(); }
    if (req.method === 'DELETE') { rows.delete(u.searchParams.get('id').replace('eq.', '')); res.writeHead(204); return res.end(); }
    const id = u.searchParams.get('id');
    let list = [...rows.values()];
    if (id) list = list.filter(r => r.id === id.replace('eq.', ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  return false;
}

// ---------------- fake DeepSeek ----------------
let calls = 0; let imageCalls = 0; const noImageCalls = [];
const st = {};
const call = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function lastTool(messages) { const t = [...messages].reverse().find(m => m.role === 'tool'); return t ? t.content : ''; }
function brain(messages) {
  const task = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:')).content;
  const s = st[task] ||= { step: 0, leads: [], places: [] };
  s.step++;
  const res = lastTool(messages);
  if (task.includes('leads')) {
    if (s.step === 1) return call('navigate', { url: `${B}/maps?q=hvac+texas` }, "I'll search Google Maps for HVAC companies in Texas.");
    if (s.step === 2) return call('get_links', { filter: '/maps/place/' }, 'Collecting the listing links.');
    if (s.step === 3) { s.places = JSON.parse(res).links; s.i = 0; s.phase = 0; }
    if (s.i < s.places.length) {
      const p = s.places[s.i];
      if (s.phase === 0) { s.phase = 1; return call('navigate', { url: p.url }, `Opening ${p.text}.`); }
      if (s.phase === 1) { s.phase = 2; return call('get_page_text', {}); }
      if (s.phase === 2) { const j = JSON.parse(res); s.cur = { name: p.text, maps: p.url, phone: j.phones[0] || '' }; s.phase = 3; return call('get_links', { filter: '/site/' }); }
      if (s.phase === 3) { s.cur.url = JSON.parse(res).links[0].url; s.phase = 4; return call('navigate', { url: s.cur.url + '/contact' }, 'Checking their website for an email.'); }
      if (s.phase === 4) { s.phase = 5; return call('get_page_text', {}); }
      if (s.phase === 5) { s.cur.email = JSON.parse(res).emails[0] || ''; s.leads.push(s.cur); s.i++; s.phase = 0; return call('update_notes', { notes: `collected ${s.leads.length}/${s.places.length}` }); }
    }
    const q = v => /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const csv = ['Company Name,Website,Email,Phone,Maps URL', ...s.leads.map(l => [l.name, l.url, l.email, l.phone, l.maps].map(q).join(','))].join('\n');
    const mdTable = ['# Texas HVAC Leads', '', 'Collected from **Google Maps**.', '', '| Company | Email | Phone |', '|---|---|---|', ...s.leads.map(l => `| ${l.name} | ${l.email} | ${l.phone} |`), '', '- Source: Maps', '- Count: 3'].join('\n');
    if (!s.made) s.made = 0;
    const files = [['texas-hvac-leads.csv', csv], ['texas-hvac-leads.xlsx', csv], ['texas-hvac-leads.pdf', mdTable], ['texas-hvac-leads.docx', mdTable]];
    if (s.made < files.length) { const [n, c] = files[s.made++]; return call('create_file', { filename: n, content: c }, s.made === 1 ? 'Building your files.' : ''); }
    return call('done', { answer: `Found **${s.leads.length} HVAC leads** in Texas.\n\n- ${s.leads.map(l => l.name).join('\n- ')}\n\nDownload the CSV above.` });
  }
  if (task.includes('second session')) {
    if (s.step === 1) return call('navigate', { url: `${B}/site/austin-cool` });
    if (s.step === 2) return call('get_page_text', {});
    return call('done', { answer: 'Session two read: ' + JSON.parse(res).title });
  }
  if (task.includes('ask me')) {
    if (s.step === 1) return call('ask_user', { question: 'Which city should I focus on?' });
    return call('done', { answer: `You picked ${res.replace('User replied: ', '')}.` });
  }
  return call('done', { answer: 'Third task done.' });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    if (req.url.startsWith('/auth/') || req.url.startsWith('/rest/')) { if (supabase(req, body, res) !== false) return; }
    if (req.url === '/v1/chat/completions') {
      calls++;
      const msgs = JSON.parse(body).messages;
      const lastUser = [...msgs].reverse().find(m => m.role === 'user');
      if (Array.isArray(lastUser.content) && lastUser.content.some(p => p.type === 'image_url')) imageCalls++; else noImageCalls.push((typeof lastUser.content === 'string' ? lastUser.content : '').match(/NOTE:.*/)?.[0] || 'text-only');
      const message = brain(msgs);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 6000, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 2000, completion_tokens: 150 } }));
    }
    const h = web(req.url);
    if (h) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(h); }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => server.listen(PORT, r));

// ---------------- run ----------------
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1100, height: 800 }, acceptDownloads: true,
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const webPage = ctx.pages()[0] || await ctx.newPage();
await webPage.goto(`${B}/maps?q=start`);
const panel = await ctx.newPage();
await panel.setViewportSize({ width: 400, height: 820 });
const errors = [];
panel.on('pageerror', e => errors.push(String(e)));
panel.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await panel.goto(`chrome-extension://${extId}/permission.html`);
const webTabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(t => !(t.url || '').startsWith('chrome-extension'))?.id);
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${webTabId}`);
await panel.evaluate(() => chrome.storage.local.set({ apiKey: 'x', baseUrl: 'http://localhost:8770/v1', model: 'deepseek-flash', repeatAlarm: true, notify: true }));
await panel.reload();
await panel.screenshot({ path: `${OUT}/0-empty.png` });

// cloud sign-in through the UI
await panel.click('#settingsBtn');
await panel.fill('#s_supabaseUrl', B);
await panel.fill('#s_supabaseKey', 'anon');
await panel.fill('#cloudEmail', 'nahid@test.com');
await panel.fill('#cloudPass', 'wrong');
await panel.click('#cloudSignIn');
await panel.waitForFunction(() => document.getElementById('cloudMsg').textContent.includes('Error'));
const badLogin = await panel.textContent('#cloudMsg');
await panel.fill('#cloudPass', 'secret123');
await panel.click('#cloudSignIn');
await panel.waitForSelector('#cloudLoggedIn:not([hidden])');
await panel.screenshot({ path: `${OUT}/1-settings.png` });
await panel.click('#settingsBtn');

// tasks: 1 running + 2 queued
await webPage.bringToFront();
const send = async t => { await panel.fill('#input', t); await panel.evaluate(() => document.getElementById('form').requestSubmit()); };
const tabB = await ctx.newPage();
await tabB.goto(`${B}/site/houston-hvac`);
await webPage.bringToFront();
const tabC = await ctx.newPage();
await tabC.goto(`${B}/site/lone-star-air`);
const tabCId = await panel.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u)?.id, `${B}/site/lone-star-air`);
const panel2 = await ctx.newPage();
await panel2.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabCId}`);
panel2.on('pageerror', e => errors.push('P2 ' + String(e)));
await webPage.bringToFront();
const activeUrl = () => panel.evaluate(async () => { const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); const [t] = await chrome.tabs.query({ active: true, windowId: w.id }); return t.url; });
await send('Get me 10 HVAC leads in Texas as CSV');
await panel.waitForTimeout(300);
await panel2.fill('#input', 'second session read a page');
await panel2.evaluate(() => document.getElementById('form').requestSubmit());
await panel.waitForTimeout(800);
// user moves to their own tab B and keeps working
await tabB.bringToFront();
const activeLog = [];
const poll = setInterval(async () => { try { activeLog.push(await activeUrl()); } catch (_) {} }, 500);
await send('Now ask me which city');
await send('Third quick task');
const queueShown = await panel.textContent('#queueTitle');
const lightRunning = await panel.getAttribute('#light', 'class');
await panel.waitForTimeout(1500);
await panel.screenshot({ path: `${OUT}/2-running-queue.png` });

// answer the ask
await panel.waitForSelector('.card.warn', { timeout: 120000 });
await panel.waitForTimeout(300);
const lightAsk = await panel.getAttribute('#light', 'class');
const alarmAsk = await panel.isVisible('#alarmBar');
const sendLabel = await panel.textContent('#sendBtn');
await panel.screenshot({ path: `${OUT}/3-ask.png` });
await send('Austin');

await panel.waitForFunction(() => document.querySelectorAll('.msg.final').length >= 3, null, { timeout: 120000 });
clearInterval(poll);
await panel2.waitForSelector('.msg.final', { timeout: 60000 });
const p2final = await panel2.textContent('.msg.final');
const tabsInfo = await panel.evaluate(async () => (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url, group: t.groupId })));
const claims = await panel.evaluate(async () => (await chrome.storage.session.get('dpClaims')).dpClaims);
await panel.waitForTimeout(1500);
const lightDone = await panel.getAttribute('#light', 'class');
const alarmText = await panel.textContent('#alarmText');
const stopLabel = await panel.textContent('#stopAlarmBtn');
const meter = [await panel.textContent('#meterTask'), await panel.textContent('#meterSession'), await panel.getAttribute('#meterFill', 'style')];
const stepsHidden = await panel.$eval('.step', n => getComputedStyle(n).display);
const pills = await panel.$$eval('.progress .txt', ns => ns.map(n => n.textContent));
await panel.screenshot({ path: `${OUT}/4-done.png`, fullPage: false });
await panel.click('#stopAlarmBtn');

// downloads (chrome.downloads)
await panel.bringToFront();
for (const b of await panel.$$('.file-card .file-dl')) { await b.evaluate(n => n.click()); await panel.waitForTimeout(700); }
await panel.waitForTimeout(1500);
const dls = await panel.evaluate(async () => (await chrome.downloads.search({})).map(d => ({ file: d.filename, state: d.state, bytes: d.fileSize, err: d.error })));
const saved = [];
for (const d of dls) { if (d.state === 'complete') { const p = path.join(OUT, path.basename(d.file)); fs.copyFileSync(d.file, p); saved.push(p); } }
// toggle steps on
await panel.click('label.tgl:has(#tglFlow)');
await panel.waitForTimeout(200);
const stepsShown = await panel.$eval('.step', n => getComputedStyle(n).display);
await panel.screenshot({ path: `${OUT}/5-steps.png` });
await panel.click('label.tgl:has(#tglTalk)');
const talkHidden = await panel.$eval('.msg.talk', n => getComputedStyle(n).display);
await panel.click('label.tgl:has(#tglTalk)');
await panel.click('label.tgl:has(#tglFlow)');

// history
await panel.click('#tabHistory');
await panel.waitForSelector('.hist-row');
const histItems = await panel.$$eval('#historyList .hist-row', ns => ns.map(n => n.innerText.replace(/\n/g, ' | ')));
const badge = await panel.textContent('#cloudBadge');
await panel.click('#historyList .hist-row:last-of-type');
await panel.waitForSelector('#chatView:not([hidden]) .msg.user');
const histFiles = await panel.$$eval('#log .file-name', ns => ns.map(n => n.textContent));
await panel.screenshot({ path: `${OUT}/6-history.png` });
const cloudRow = [...rows.values()][0];
console.log(JSON.stringify({
  badLogin, queueShown, lightRunning, lightAsk, alarmAsk, sendLabel, lightDone, alarmText, stopLabel, meter, stepsHidden, stepsShown, talkHidden, pills,
  saved: saved.map(p => path.basename(p) + ':' + fs.statSync(p).size), histItems, badge, histFiles,
  cloud: { rows: rows.size, authHeaderOk, events: cloudRow?.events?.length, files: cloudRow?.files?.map(f => f.name), status: cloudRow?.status, usage: cloudRow?.usage },
  errors, calls, imageCalls, noImageCalls: noImageCalls.slice(0, 5), p2final, activeDistinct: [...new Set(activeLog)], tabsInfo, claims, dls,
}, null, 1));
await ctx.close();
server.close();
