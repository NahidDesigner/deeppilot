import './_setup.mjs';
import { fileURLToPath } from 'node:url';
// Dashboards: a Cloudflare-style DNS table (row context for 30 identical "Edit" links, new-element
// markers, fill_form, batching, ALERT lines, completion check that rejects once), a cross-origin iframe
// panel (cPanel-style), and a long settings page (find / search_page / extract).
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT = 8783, B = `http://localhost:${PORT}`, FRAME = `http://127.0.0.1:${PORT}`;

const ROWS = [['A', '@', '192.0.2.1', 'Proxied'], ['A', 'www', '192.0.2.1', 'Proxied'], ['CNAME', 'blog', 'ghs.example.net', 'DNS only'], ['MX', '@', 'mail.example.net', 'DNS only'], ['TXT', '@', 'v=spf1 include:_spf.example ~all', 'DNS only']];
const DNS = `<!doctype html><html><head><title>DNS Records · example.com</title></head><body>
<h1>DNS Records</h1><div role="status" id="st"></div>
<table id="t"><tr><th>Type</th><th>Name</th><th>Content</th><th>Proxy status</th><th>Actions</th></tr>
${ROWS.map(r => `<tr data-name="${r[1]}-${r[0]}"><td>${r[0]}</td><td>${r[1]}</td><td class="c">${r[2]}</td><td class="p">${r[3]}</td><td><a href="#" onclick="edit('${r[1]}','${r[0]}');return false">Edit</a></td></tr>`).join('')}
</table>
<dialog id="dlg"><h2>Edit record</h2><label>Content <input id="content"></label><label><input type="checkbox" id="proxy"> Proxied</label><label>TTL <select id="ttl"><option>Auto</option><option>1 hour</option><option>1 day</option></select></label><button onclick="save()">Save</button></dialog>
<script>let cur;function edit(n,t){cur=document.querySelector('tr[data-name="'+n+'-'+t+'"]');document.getElementById('content').value=cur.querySelector('.c').textContent;document.getElementById('proxy').checked=cur.querySelector('.p').textContent==='Proxied';document.getElementById('dlg').showModal();}
function save(){cur.querySelector('.c').textContent=document.getElementById('content').value;cur.querySelector('.p').textContent=document.getElementById('proxy').checked?'Proxied':'DNS only';document.getElementById('dlg').close();document.getElementById('st').textContent='Record '+cur.dataset.name+' updated (TTL '+document.getElementById('ttl').value+')';}</script></body></html>`;
const PANEL = `<!doctype html><html><head><title>Hosting panel</title></head><body><h1>Hosting panel</h1><p>Email tools are below.</p><iframe src="${FRAME}/email" width="700" height="360" style="border:1px solid #ccc"></iframe></body></html>`;
const EMAIL = `<!doctype html><html><body><h2>Create email account</h2><label>Email address <input id="addr" placeholder="name@site.test"></label><button onclick="document.getElementById('out').textContent='Account '+document.getElementById('addr').value+' created'">Create account</button><p role="alert" id="out"></p></body></html>`;
const LONG = `<!doctype html><html><body><h1>Website settings</h1>${Array.from({ length: 140 }, (_, i) => `<p>Setting paragraph ${i} with some descriptive text about options.</p>${i === 60 ? '<p>Plan price: $19/month, billed yearly.</p>' : ''}`).join('')}<h2>Danger zone</h2><button onclick="this.textContent='Deleting…'">Delete website</button></body></html>`;

// An Ads-Manager-style editor: the window can't scroll (the panel does), a row's Edit pencil only shows
// after the row has been hovered for a moment, and a real button sits inside a clickable row.
const ADS = `<!doctype html><html><head><title>Ad set editor</title><style>html,body{margin:0;height:100%;overflow:hidden;font:14px sans-serif}
#panel{height:100vh;overflow-y:auto} .row{display:flex;gap:12px;align-items:center;padding:10px 16px;width:520px;border:1px solid #ddd}
.pencil{visibility:hidden} .row.on .pencil{visibility:visible} .rowc{cursor:pointer;padding:12px 16px;width:520px;border:1px solid #ddd}</style></head><body>
<div id="panel"><h2>Audience controls</h2>
<div class="row" id="loc"><span id="locv">Locations: United States</span><button class="pencil" aria-label="Edit locations" onclick="document.getElementById('locv').textContent='Locations: Bangladesh'">✎</button></div>
<div style="height:1500px"></div>
<div class="rowc" onclick="void 0">Minimum age 18 <button onclick="event.stopPropagation();this.textContent='Age editor open'">Edit age</button></div>
<div style="height:900px"></div></div>
<script>const r=document.getElementById('loc');let t;r.addEventListener('mouseenter',()=>{t=setTimeout(()=>r.classList.add('on'),150)});r.addEventListener('mouseleave',()=>{clearTimeout(t);r.classList.remove('on')});</script></body></html>`;

let calls = 0; const out = { ctxLine: '', ctxOK: false, starOK: false, alertOK: false, rejected: 0, reviewerCalls: 0, batchSkipped: false, frameIds: false, frameAlert: false, frameText: false, findOK: false, foundInView: false, searchCount: -1, extractSawPrice: false, extractAnswer: '' };
const tc = (...calls_) => ({ role: 'assistant', content: '', tool_calls: calls_.map(([name, args]) => ({ id: 'c' + (++calls) + Math.random().toString(36).slice(2, 5), type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
const idOf = (state, re) => { const l = state.split('\n').find(x => re.test(x) && /^\*?\[\d+\]/.test(x)); return l ? +l.match(/^\*?\[(\d+)\]/)[1] : -1; };
function brain(body) {
  const msgs = body.messages;
  const sys = typeof msgs[0].content === 'string' ? msgs[0].content : '';
  if (sys.startsWith('You check whether a browser agent')) {
    out.reviewerCalls++;
    return { role: 'assistant', content: out.reviewerCalls === 1 ? '{"complete": false, "missing": "the TTL was not confirmed on the page"}' : '{"complete": true}' };
  }
  if (sys.startsWith('You extract information')) {
    const u = msgs[1].content; out.extractSawPrice = u.includes('Plan price: $19/month');
    return { role: 'assistant', content: 'The plan costs $19/month, billed yearly.' };
  }
  const tIdx = msgs.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'));
  const task = msgs[tIdx].content, after = msgs.slice(tIdx);
  const tools = after.filter(m => m.role === 'tool'); const n = tools.length; const last = n ? tools[n - 1].content : '';
  const obs = [...after].reverse().find(m => m.role === 'user' && (typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '').startsWith('PAGE STATE'));
  const state = obs ? (typeof obs.content === 'string' ? obs.content : obs.content[0].text) : '';
  if (/www A record/.test(task)) {
    if (n === 0) return tc(['navigate', { url: `${B}/dns` }]);
    if (n === 1) { const line = state.split('\n').find(l => /"Edit".* — in: "A www/.test(l)) || ''; out.ctxLine = line; out.ctxOK = /in: "A www 192\.0\.2\.1 Proxied"/.test(line); return tc(['click', { id: +line.match(/\[(\d+)\]/)[1] }]); }
    if (n === 2) {
      out.starOK = /\*\[\d+\] <input> "Content"/.test(state);
      return tc(['fill_form', { fields: [{ id: idOf(state, /"Content"/), value: '203.0.113.9' }, { id: idOf(state, /"Proxied"/), value: 'false' }, { id: idOf(state, /"TTL"/), value: '1 hour' }] }], ['click', { id: idOf(state, /"Save"/) }]);
    }
    if (/NOT DONE YET/.test(last)) return tc(['done', { answer: 'Updated www: 203.0.113.9, DNS only, TTL 1 hour (confirmed by the page).' }]);
    out.alertOK = /ALERT: Record www-A updated \(TTL 1 hour\)/.test(state);
    return tc(['done', { answer: 'Updated the www A record.' }]);
  }
  if (/email account/.test(task)) {
    if (n === 0) return tc(['navigate', { url: `${B}/dns` }]);
    if (n === 1) return tc(['navigate', { url: `${B}/panel` }], ['click', { id: 3 }]); // 2nd call must be skipped
    if (n === 3) { out.batchSkipped = /Skipped: the page changed/.test(last); out.frameIds = /INSIDE FRAME 1/.test(state) && idOf(state, /Email address/) >= 1001; return tc(['type', { id: idOf(state, /Email address/), text: 'info@site.test' }], ['click', { id: idOf(state, /Create account/) }]); }
    if (n === 5) { out.frameAlert = /ALERT: Account info@site\.test created/.test(state); return tc(['get_page_text', {}]); }
    if (n === 6) { out.frameText = /Account info@site\.test created/.test(last); return tc(['done', { answer: 'Created info@site.test' }]); }
  }
  if (/ad set editor/.test(task)) {
    if (n === 0) return tc(['navigate', { url: `${B}/ads` }]);
    if (n === 1) { const line = state.split('\n').find(l => /"Edit locations"/.test(l)) || ''; out.hoverLine = line; out.hoverListed = /\(shows on hover\)/.test(line) && /in: "Locations: United States"/.test(line); return tc(['click', { id: idOf(state, /"Edit locations"/) }]); }
    if (n === 2) { out.hoverClickOK = /Locations: Bangladesh/.test(state); return tc(['scroll', { direction: 'down', amount: 2 }]); }
    if (n === 3) { const r = JSON.parse(last); out.panelScrolled = !!r.scrolledPanel && r.moved > 0; out.nestedOK = idOf(state, /<button> "Edit age"/) > 0; return tc(['click', { id: idOf(state, /"Minimum age 18/) }]); }
    if (n === 4) { out.noChangeNote = /Nothing on the page changed/.test(last); return tc(['click', { id: idOf(state, /<button> "Edit age"/) }]); }
    if (n === 5) { out.realClickQuiet = !/Nothing on the page changed/.test(last) && /Age editor open/.test(state); return tc(['done', { answer: 'Editor checked.' }]); }
  }
  if (/plan price/.test(task)) {
    if (n === 0) return tc(['navigate', { url: `${B}/long` }]);
    if (n === 1) return tc(['find', { query: 'Delete website button in the danger zone' }]);
    if (n === 2) { out.findOK = /Delete website/.test(last); out.foundInView = /\*\[\d+\] <button> "Delete website"/.test(state); return tc(['search_page', { text: 'Danger zone' }]); }
    if (n === 3) { out.searchCount = JSON.parse(last).count; return tc(['extract', { question: 'What is the plan price?' }]); }
    if (n === 4) { out.extractAnswer = JSON.parse(last).answer; return tc(['done', { answer: out.extractAnswer }]); }
  }
  return tc(['done', { answer: 'ok' }]);
}
const server = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: brain(JSON.parse(b)) }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/dns') ? DNS : req.url.startsWith('/panel') ? PANEL : req.url.startsWith('/email') ? EMAIL : req.url.startsWith('/long') ? LONG : req.url.startsWith('/ads') ? ADS : '<h1>Start</h1>');
}); });
await new Promise(r => server.listen(PORT, r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-dash-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1200, height: 800 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const web = ctx.pages()[0]; await web.goto(`${B}/start`);
const v = await ctx.newPage();
const errors = []; v.on('pageerror', e => errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(p => chrome.storage.local.set({ apiKey: 'x', baseUrl: `http://localhost:${p}/v1`, vision: false, notify: false, repeatAlarm: false, confirmRisky: false }), PORT);
const tabId = await v.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.includes('/start'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`); await v.waitForTimeout(500);
const run = async text => {
  const before = await v.$$eval('.msg.final', n => n.length);
  await v.fill('#input', text); await v.click('#sendBtn');
  await v.waitForFunction(b => document.querySelectorAll('.msg.final').length > b && document.getElementById('light').className.includes('done'), before, { timeout: 90000 });
  return v.$$eval('.msg.final', n => n.pop()?.textContent);
};
out.final1 = await run('Change the www A record to 203.0.113.9, DNS only, TTL 1 hour');
out.checkNote = await v.$$eval('.memnote', n => n.map(x => x.textContent).find(t => /Check before finishing/.test(t)) || '');
await v.evaluate(() => chrome.storage.local.set({ verifyDone: false }));
out.final2 = await run('Create the email account info@site.test in the hosting panel');
out.final3 = await run('Find the plan price and the delete button');
out.final4 = await run('Open the ad set editor and change the location');
out.errors = errors; out.calls = calls;
console.log(JSON.stringify(out, null, 1));
await ctx.close(); server.close();
