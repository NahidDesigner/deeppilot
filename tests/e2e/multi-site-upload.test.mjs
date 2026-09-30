import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8771;
const B = `http://localhost:${PORT}`;
const OUT = path.resolve('out13');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
const PNG = fs.readFileSync(fileURLToPath(new URL('./fixtures/generated-image.png', import.meta.url)));

const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body style="font-family:sans-serif;padding:16px">${body}</body></html>`;
const PAGES = {
  '/chatgpt': html('ChatGPT', `<div id="thread"></div><textarea id="prompt" placeholder="Message ChatGPT"></textarea><button id="go" onclick="gen()">Send prompt</button>
    <script>function gen(){const t=document.getElementById('prompt').value;document.getElementById('thread').innerHTML='<p>Creating image…</p>';setTimeout(()=>{document.getElementById('thread').innerHTML='<p>Here is your image</p><img alt="Generated image: '+t.replace(/"/g,'')+'" src="/files/gen.png?sig=abc" width="256" height="256">';},1500);}
    document.getElementById('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();gen();}});</script>`),
  '/wp-new': html('Add New Post ‹ My Site — WordPress', `<h1>Add New Post</h1><input placeholder="Add title" id="title">
    <div class="panel"><button id="feat" onclick="document.getElementById('up').click()">Set featured image</button><input type="file" id="up" accept="image/*" style="display:none"></div>
    <p id="status">No image</p>
    <script>document.getElementById('up').addEventListener('change',e=>{const f=e.target.files[0];document.getElementById('status').textContent='Uploaded: '+f.name+' ('+f.size+' bytes, '+f.type+')';});</script>`),
  '/site': html('Status page', '<h1>All systems normal</h1><p>Visitors today: 1234</p>'),
};

let calls = 0; const st = {}; const seen = {};
const call = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const lastTool = m => ([...m].reverse().find(x => x.role === 'tool') || {}).content || '';
const stateText = m => { const u = [...m].reverse().find(x => x.role === 'user'); return Array.isArray(u.content) ? u.content[0].text : u.content; };
const idOf = (state, re) => { const l = state.split('\n').find(x => re.test(x)); return l ? parseInt(l.match(/^\[(\d+)\]/)[1], 10) : -1; };

function brain(messages) {
  const task = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('TASK:')).content;
  const s = st[task] ||= { step: 0 };
  s.step++;
  const state = stateText(messages);
  if (task.includes('Run the saved skill "/daily-check"')) {
    seen.skillTask = task;
    seen.skillInSystem = messages[0].content.includes('/daily-check');
    if (s.step === 1) return call('navigate', { url: `${B}/site` });
    if (s.step === 2) return call('get_page_text', {});
    return call('done', { answer: 'Daily check: ' + JSON.parse(lastTool(messages)).text.split('\n')[0] });
  }
  if (task.includes('save a skill')) {
    if (s.step === 1) return call('save_skill', { name: 'Weekly Report', description: 'Make my weekly report', instructions: '1. Open analytics\n2. Export CSV' });
    return call('done', { answer: 'Saved /weekly-report' });
  }
  if (task.includes('featured image')) {
    if (s.step === 1) return call('navigate', { url: `${B}/chatgpt` }, 'Opening ChatGPT to make the image.');
    if (s.step === 2) return call('type', { id: idOf(state, /Message ChatGPT/), text: 'A sunny blue poster', submit: true });
    if (s.step === 3) return call('wait', { seconds: 2 });
    if (s.step === 4) { seen.imgLine = state.split('\n').find(l => /Generated image/.test(l)); return call('save_image', { id: idOf(state, /Generated image/), filename: 'hero.png' }); }
    if (s.step === 5) { seen.save = lastTool(messages); return call('navigate', { url: `${B}/wp-new` }, 'Now uploading it to your site.'); }
    if (s.step === 6) return call('click', { id: idOf(state, /Set featured image/) });
    if (s.step === 7) return call('upload_file', { file: 'hero.png', id: idOf(state, /Set featured image/) });
    if (s.step === 8) { seen.upload = lastTool(messages); return call('get_page_text', {}); }
    return call('done', { answer: 'Result: ' + JSON.parse(lastTool(messages)).text.match(/Uploaded:[^\n]*/)?.[0] });
  }
  if (task.includes('continue')) {
    seen.recap = messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('CONTEXT — earlier'));
    seen.recapText = messages.find(m => typeof m.content === 'string' && m.content.startsWith('CONTEXT'))?.content?.slice(0, 400);
    return call('done', { answer: 'Continued with context: ' + seen.recap });
  }
  return call('done', { answer: 'ok' });
}

const server = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    if (req.url === '/v1/chat/completions') {
      calls++;
      const message = brain(JSON.parse(body).messages);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 3000, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 2000, completion_tokens: 100 } }));
    }
    if (req.url.startsWith('/files/gen.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    const p = PAGES[req.url.split('?')[0]];
    if (p) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(p); }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => server.listen(PORT, r));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1200, height: 800 }, acceptDownloads: true,
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const web = ctx.pages()[0] || await ctx.newPage();
await web.goto(`${B}/site`);
const panel = await ctx.newPage();
await panel.setViewportSize({ width: 400, height: 820 });
const errors = [];
panel.on('pageerror', e => errors.push(String(e)));
panel.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await panel.goto(`chrome-extension://${extId}/permission.html`);
const webTabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(t => !(t.url || '').startsWith('chrome-extension'))?.id);
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${webTabId}`);
await panel.evaluate(() => chrome.storage.local.set({ apiKey: 'x', baseUrl: 'http://localhost:8771/v1', repeatAlarm: false, notify: false }));
await panel.reload();
const waitFinals = n => panel.waitForFunction(k => document.querySelectorAll('.msg.final, .msg.error').length >= k, n, { timeout: 90000 });
const send = async t => { await panel.fill('#input', t); await panel.evaluate(() => document.getElementById('form').requestSubmit()); };

// 1. create a skill in the Skills panel
await panel.click('#skillsBtn');
await panel.click('#skillForm > summary');
await panel.fill('#skillName', 'Daily Check');
await panel.fill('#skillDesc', 'Check my status page every morning');
await panel.fill('#skillInstr', '1. Open the status page\n2. Report the first line');
await panel.click('#skillSave');
await panel.waitForFunction(() => document.getElementById('skillMsg').textContent.includes('Saved'));
const skillMsg = await panel.textContent('#skillMsg');
await panel.screenshot({ path: `${OUT}/1-skills.png` });
await panel.click('#tabChat');

// 2. use it with "/" autocomplete
await panel.focus('#input');
await panel.keyboard.type('/dai');
await panel.waitForSelector('#slashMenu:not([hidden])');
const menuItems = await panel.$$eval('.slash-item .n', ns => ns.map(n => n.textContent));
await panel.screenshot({ path: `${OUT}/2-slash.png` });
await panel.keyboard.press('Enter');
const afterPick = await panel.inputValue('#input');
await panel.keyboard.type('quickly please');
await web.bringToFront();
await panel.evaluate(() => document.getElementById('form').requestSubmit());
await waitFinals(1);
const tags = await panel.$$eval('.skill-tag', ns => ns.map(n => n.textContent));

// 3. agent saves a skill
await send('please save a skill for my weekly report');
await waitFinals(2);
const skillsAfter = await panel.evaluate(async () => (await chrome.storage.local.get('skills')).skills.map(s => s.name));

// 4. ChatGPT image -> WordPress upload, with visible cursor
await send('Make an image on ChatGPT and set it as the featured image of a new post');
await waitFinals(3);
const cursorMid = await panel.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const t = tabs.find(x => (x.url || '').includes('/wp-new'));
  if (!t) return 'no tab';
  const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => { const c = document.getElementById('__dp_cursor'); return c ? c.style.transform : 'none'; } });
  return r.result;
});
const imgFinal = await panel.$$eval('.msg.final', ns => ns.map(n => n.textContent).pop());
const imgCard = await panel.$$eval('.file-card .file-name', ns => ns.map(n => n.textContent));
const imgPrev = await panel.$eval('.file-img', n => n.naturalWidth).catch(() => 0);
await panel.screenshot({ path: `${OUT}/3-image-flow.png` });

// 5. History tab list with times
await panel.click('#tabHistory');
await panel.waitForSelector('.hist-row');
const histRows = await panel.$$eval('#historyList .hist-row', ns => ns.map(n => n.innerText.replace(/\n/g, ' | ')));
const histGroups = await panel.$$eval('#historyList .hist-group', ns => ns.map(n => n.textContent));
await panel.screenshot({ path: `${OUT}/4-history-tab.png` });

// 6. full page app
const app = await ctx.newPage();
await app.setViewportSize({ width: 1280, height: 800 });
app.on('pageerror', e => errors.push('APP ' + String(e)));
await app.goto(`chrome-extension://${extId}/sidepanel.html?mode=app`);
await app.waitForSelector('#sideList .hist-row');
const sideRows = await app.$$eval('#sideList .hist-row', ns => ns.map(n => n.innerText.replace(/\n/g, ' | ')));
await app.click('#sideList .hist-row');
await app.waitForSelector('#log .msg.user');
const appMsgs = await app.$$eval('#log .msg', ns => ns.length);
const activeBefore = await app.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].url);
const tabsBefore = await app.evaluate(async () => (await chrome.tabs.query({})).length);
await app.fill('#input', 'continue from before');
await app.evaluate(() => document.getElementById('form').requestSubmit());
await app.waitForFunction(() => [...document.querySelectorAll('.msg.final')].some(n => n.textContent.includes('Continued')), null, { timeout: 60000 });
const activeAfter = await app.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].url);
const tabsAfter = await app.evaluate(async () => (await chrome.tabs.query({})).length);
await app.screenshot({ path: `${OUT}/5-fullpage.png` });

// downloads
const dls = await panel.evaluate(async () => (await chrome.downloads.search({})).map(d => ({ state: d.state, bytes: d.fileSize, mime: d.mime })));

console.log(JSON.stringify({
  skillMsg, menuItems, afterPick, tags, skillTaskStart: seen.skillTask?.slice(0, 160), skillInSystem: seen.skillInSystem, skillsAfter,
  imgLine: seen.imgLine, save: seen.save, upload: seen.upload, imgFinal, imgCard, imgPrev, cursorMid,
  histRows, histGroups, sideRows, appMsgs, recap: seen.recap, recapText: seen.recapText, activeBefore, activeAfter, tabsBefore, tabsAfter,
  dls, errors, calls,
}, null, 1));
await ctx.close(); server.close();
