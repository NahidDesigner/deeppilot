import './_setup.mjs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8766;
const PEOPLE = ['Aisha Rahman', 'Tanvir Hasan', 'Maria Lopez'];

const PAGE = `<!doctype html><html><head><title>Connections | FakedIn</title>
<style>body{font-family:sans-serif;margin:0} .card{display:flex;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #ddd}
#overlay{position:fixed;right:20px;bottom:0;width:340px;background:#fff;border:1px solid #999;box-shadow:0 0 10px #0003}
.ed{min-height:60px;border:1px solid #ccc;margin:8px;padding:6px}</style></head><body>
<header style="padding:12px 20px;background:#0a66c2;color:#fff">FakedIn — My Network</header>
<h2 style="padding:0 20px">Connections</h2>
<div id="list">${PEOPLE.map(p => `<div class="card"><div><b>${p}</b><div>Connected recently</div></div>
<button aria-label="Send message to ${p}" onclick="openChat('${p}')">Message</button></div>`).join('')}</div>
<div id="log" style="padding:20px"></div>
<script>
window.sent=[];
function openChat(name){
  document.getElementById('overlay')?.remove();
  const o=document.createElement('div'); o.id='overlay';
  o.innerHTML='<div style="padding:8px;background:#eee"><b>'+name+'</b> <button aria-label="Close your conversation with '+name+'" id="cl">✕</button></div><div id="thread" style="padding:8px"></div><div class="ed" contenteditable="true" role="textbox" aria-label="Write a message…"></div><button id="send" disabled>Send</button>';
  document.body.appendChild(o);
  const ed=o.querySelector('.ed'), send=o.querySelector('#send');
  ed.addEventListener('input',()=>{send.disabled=!ed.innerText.trim();});
  send.onclick=()=>{const t=ed.innerText.trim(); if(!t) return; sent.push({name,t}); o.querySelector('#thread').innerHTML+='<p>You: '+t+'</p>'; ed.innerHTML=''; send.disabled=true; document.getElementById('log').innerHTML+='<p>Sent to '+name+': '+t+'</p>';};
  o.querySelector('#cl').onclick=()=>o.remove();
}
</script></body></html>`;

let calls = 0, phase = 0, person = 0;
let systemHadTemplate = false;
const trace = [];
function stateOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return Array.isArray(m.content) ? m.content[0].text : m.content;
  }
  return '';
}
const idOf = (state, re) => { const l = state.split('\n').find(x => re.test(x)); return l ? parseInt(l.match(/^\*?\[(\d+)\]/)[1], 10) : -1; };
const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

function brain(messages) {
  const state = stateOf(messages);
  const task = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:'))?.content || '';
  trace.push({ calls, phase, person, head: state.split('\n').slice(0, 3).join(' | ') });
  if (task.includes('remember')) {
    const ti = messages.findLastIndex(m => m.role === 'user' && m.content === task);
    if (!messages.slice(ti).some(m => m.role === 'tool'))
      return call('remember', { text: "LinkedIn welcome message template: 'Hi {first name}, welcome to my network!'" });
    return call('done', { answer: 'Saved your template.' });
  }
  // task 2
  if (phase === 0) { systemHadTemplate = messages[0].content.includes('welcome to my network'); phase = 1; return call('navigate', { url: `http://localhost:${PORT}/connections` }); }
  if (phase === 1) { phase = 2; return call('update_notes', { notes: PEOPLE.map(p => `[ ] ${p}`).join('\n') }); }
  if (person >= PEOPLE.length) return call('done', { answer: `Sent ${PEOPLE.length} messages` });
  const p = PEOPLE[person], first = p.split(' ')[0];
  if (phase === 2) { phase = 3; return call('click', { id: idOf(state, new RegExp(`Send message to ${p}`)) }); }
  if (phase === 3) { phase = 4; return call('type', { id: idOf(state, /Write a message/), text: `Hi ${first}, welcome to my network!` }); }
  if (phase === 4) { phase = 5; return call('click', { id: idOf(state, /<button> "Send"/) }); }
  if (phase === 5) { phase = 6; return call('click', { id: idOf(state, /Close your conversation/) }); }
  if (phase === 6) {
    phase = 2; person++;
    return call('update_notes', { notes: PEOPLE.map((x, i) => `[${i < person ? 'x' : ' '}] ${x}`).join('\n') });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/connections') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  if (req.url === '/v1/chat/completions') {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      calls++;
      const j = JSON.parse(b);
      const message = brain(j.messages);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(PORT, r));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1200, height: 800 },
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const web = ctx.pages()[0] || await ctx.newPage();
await web.goto('https://example.com').catch(() => {});
const panel = await ctx.newPage();
const errors = [];
panel.on('pageerror', e => errors.push(String(e)));
await panel.goto(`chrome-extension://${extId}/permission.html`);
const webTabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(t => !(t.url || '').startsWith('chrome-extension'))?.id);
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${webTabId}`);
await panel.evaluate(() => chrome.storage.local.set({ apiKey: 'x', verifyDone: false, baseUrl: 'http://localhost:8766/v1', model: 'deepseek-flash', vision: true, confirmRisky: true, maxSteps: 100 }));
await panel.reload();
await web.bringToFront();

async function task(text) {
  const before = await panel.$$eval('.msg.final, .msg.error', n => n.length);
  await panel.fill('#input', text);
  await panel.evaluate(() => document.getElementById('form').requestSubmit());
  await panel.waitForFunction(b => document.querySelectorAll('.msg.final, .msg.error').length > b, before, { timeout: 120000 });
}

await task('remember my LinkedIn welcome template');
const mems = await panel.evaluate(() => chrome.storage.local.get('memories'));
console.log('MEMORIES', JSON.stringify(mems.memories));

// Auto-click "Allow all" the first time a confirm card appears.
const allowAllClicker = panel.waitForSelector('.card.warn button:has-text("Allow all")', { timeout: 60000 }).then(b => b.click()).then(() => 'clicked').catch(e => 'none: ' + e.message);
await task('Go to my recent connections and send them a welcome message');
console.log('allow-all', await allowAllClicker);

const sent = await web.evaluate(() => window.sent).catch(e => 'ERR ' + e.message);
console.log('SENT', JSON.stringify(sent));
console.log('system prompt had template:', systemHadTemplate);
console.log('confirm cards:', await panel.$$eval('.card.warn', n => n.length));
console.log('finals', await panel.$$eval('.msg.final, .msg.error', n => n.map(x => x.textContent)));
console.log('memory panel items:', await panel.evaluate(async () => { document.getElementById('memoryBtn').click(); await new Promise(r => setTimeout(r, 300)); return [...document.querySelectorAll('#memoryList li .t')].map(x => x.textContent); }));
console.log('errors', errors, 'calls', calls);
fs.writeFileSync('li-trace.json', JSON.stringify(trace, null, 1));
await panel.screenshot({ path: 'li-panel.png' });
await ctx.close(); server.close();
