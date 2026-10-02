import { loadSettings, saveSettings } from './lib/settings.js';
import { chatCompletion } from './lib/llm.js';
import { loadMemories, addMemory, deleteMemory } from './lib/memory.js';
import { fmtTokens, fmtCost, isPeak } from './lib/pricing.js';
import { SOUNDS, playOnce } from './lib/sound.js';
import { createVoice, voiceSupported } from './lib/voice.js';
import { createRecorder, transcribe } from './lib/recorder.js';
import { getConversation, listConversations, toMarkdown, download } from './lib/store.js';
import * as cloud from './lib/cloud.js';
import { loadSkills, saveSkill, deleteSkill, importSkills, slugify } from './lib/skills.js';
import { parseMarkdown, downloadFile, preview, extOf } from './lib/files.js';
import { loadAgents, saveAgent, deleteAgent, importAgents, EXAMPLE_LEAD_HUNTER, DRAFT_SYSTEM_PROMPT } from './lib/agents.js';
import { injectSprite, icon, fileIconName } from './lib/icons.js';

injectSprite();

// This page is only a VIEW. Tasks run in the background engine (background.js → lib/engine.js),
// so they keep going when you switch tabs or close the panel.

const $ = id => document.getElementById(id);
const log = $('log');
const input = $('input');

let settings = await loadSettings();
cloud.configure(settings.supabaseUrl, settings.supabaseKey);

// ---------- theme ----------
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = settings.theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : (settings.theme || 'light');
  document.documentElement.dataset.theme = t;
}
applyTheme();
darkMq.addEventListener('change', applyTheme);

const PARAMS = new URLSearchParams(location.search);
const MODE = PARAMS.get('mode') === 'app' ? 'app' : 'panel'; // panel = dedicated to one tab; app = full page
const emptyTpl = $('empty').cloneNode(true);
let skills = await loadSkills();
let agents = await loadAgents();

// ---------- view state ----------
let sessionConv = null;   // the session's live conversation (from the engine)
let state = { running: false, pending: null, queue: [], queuePaused: false, light: 'idle', lightLabel: 'Ready' };
let viewed = null;        // conversation shown in the chat area
let browsingOther = false; // looking at an old chat while a task runs
let liveCtx = null;
let nodes = new Map();    // event id -> rendered node

// ---------- helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(?<![">=])(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
function renderMd(text) {
  const frag = document.createDocumentFragment();
  let list = null;
  for (const b of parseMarkdown(text)) {
    if (b.t === 'li' || b.t === 'oli') {
      const tag = b.t === 'li' ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag); frag.appendChild(list); }
      const li = el('li'); li.innerHTML = inline(b.text); list.appendChild(li);
      continue;
    }
    list = null;
    if (b.t === 'h') { const h = el(b.level <= 2 ? 'h3' : 'h4'); h.innerHTML = inline(b.text); frag.appendChild(h); }
    else if (b.t === 'p' || b.t === 'quote') { const p = el('p'); p.innerHTML = b.text.split('\n').map(inline).join('<br>'); frag.appendChild(p); }
    else if (b.t === 'code') frag.appendChild(el('pre', null, b.text));
    else if (b.t === 'hr') frag.appendChild(el('hr'));
    else if (b.t === 'table') {
      const t = el('table');
      b.rows.forEach((r, i) => { const tr = el('tr'); r.forEach(c => { const td = el(i ? 'td' : 'th'); td.innerHTML = inline(c); tr.appendChild(td); }); t.appendChild(tr); });
      frag.appendChild(t);
    }
  }
  return frag;
}
const fmtBytes = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
const scrollDown = () => { log.scrollTop = log.scrollHeight; };

// ---------- status orb, telemetry & alert bar ----------
const TEL_LABEL = { Ready: 'STANDBY', Working: 'LIVE', 'Needs you': 'NEEDS YOU', Stopped: 'STOPPED', Done: 'LANDED', Paused: 'PAUSED', Error: 'ERROR', 'Needs help': 'NEEDS HELP' };
function setLight(light, label) {
  const l = $('light');
  l.className = 'orb ' + light;
  l.setAttribute('aria-label', label);
  $('lightLabel').textContent = TEL_LABEL[label] || String(label).toUpperCase();
  const tel = $('telemetry');
  tel.classList.remove('is-running', 'is-ask', 'is-error', 'is-done');
  if (light !== 'idle') tel.classList.add('is-' + light);
}
const fmtElapsed = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
setInterval(() => {
  const t = $('telTime');
  if (state.running && state.startedAt) { t.hidden = false; t.textContent = fmtElapsed(Date.now() - state.startedAt); }
  else t.hidden = true;
}, 1000);
$('stopAlarmBtn').addEventListener('click', () => cmd('dismiss'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('alarmBar').hidden) cmd('dismiss'); });

// ---------- rendering (shared by live chat and history) ----------
function newCtx(container, files, live) { return { container, files, live, pill: null, steps: 0 }; }

function makePill(ctx) {
  const p = el('div', 'progress');
  p.appendChild(el('span', 'spin'));
  const t = el('span', 'txt', ctx.live ? 'Working…' : 'No steps');
  p.appendChild(t);
  const b = el('button', null, 'Show steps');
  b.type = 'button';
  b.onclick = () => { $('tglFlow').checked = true; $('tglFlow').dispatchEvent(new Event('change')); };
  p.appendChild(b);
  if (!ctx.live) p.classList.add('finished');
  return p;
}
function updatePill(ctx, last) {
  if (!ctx.pill) return;
  ctx.pill.querySelector('.txt').textContent = `${ctx.steps} step${ctx.steps === 1 ? '' : 's'}${last && ctx.live && !ctx.pill.classList.contains('finished') ? ` · ${last}` : ''}`;
}
function finishPill(ctx) {
  if (ctx?.pill) { ctx.pill.classList.add('finished'); updatePill(ctx); }
}

function fileCard(file) {
  const card = el('div', 'file-card');
  const head = el('div', 'file-head');
  const ext = extOf(file.name);
  const ic = el('div', 'file-icon');
  ic.appendChild(icon(fileIconName(ext)));
  ic.appendChild(el('span', 'ext', (ext || 'file').slice(0, 4)));
  head.appendChild(ic);
  const meta = el('div', 'file-meta');
  meta.appendChild(el('div', 'file-name', file.name));
  const pv = preview(file);
  const bytes = file.dataUrl ? Math.round(file.dataUrl.length * 0.75) : String(file.content ?? '').length;
  meta.appendChild(el('div', 'file-sub', file.localOnly ? 'Kept on the original computer' : pv.kind === 'table' ? `${pv.total} row${pv.total === 1 ? '' : 's'} · ${fmtBytes(bytes)}` : fmtBytes(bytes)));
  head.appendChild(meta);
  const btn = el('button', 'file-dl');
  btn.type = 'button';
  btn.title = `Download ${file.name}`;
  btn.setAttribute('aria-label', `Download ${file.name}`);
  btn.appendChild(icon('download'));
  btn.onclick = async () => {
    try { await downloadFile(file); btn.replaceChildren(icon('check')); setTimeout(() => btn.replaceChildren(icon('download')), 1600); }
    catch (e) { btn.replaceChildren(icon('alert')); console.error(e); }
  };
  head.appendChild(btn);
  card.appendChild(head);
  const prev = el('div', 'file-prev');
  if (pv.kind === 'image') {
    const img = el('img', 'file-img');
    img.src = pv.src;
    img.alt = file.name;
    prev.appendChild(img);
  } else if (pv.kind === 'table' && pv.rows.length) {
    const t = el('table');
    pv.rows.forEach((r, i) => { const tr = el('tr'); r.forEach(c => tr.appendChild(el(i ? 'td' : 'th', null, c))); t.appendChild(tr); });
    prev.appendChild(t);
  } else if (['pdf', 'docx', 'md'].includes(ext)) {
    const doc = el('div', 'doc-prev');
    doc.appendChild(renderMd(String(file.content).slice(0, 1500)));
    prev.appendChild(doc);
  } else {
    prev.appendChild(el('pre', null, pv.text));
  }
  card.appendChild(prev);
  return card;
}
const withIcon = (cls, name, text) => { const n = el('div', cls); n.appendChild(icon(name)); n.appendChild(el('span', null, text)); return n; };

function renderEvent(e, ctx) {
  let node;
  switch (e.type) {
    case 'user':
      node = el('div', 'msg user');
      if (e.agent) {
        const tags = el('span', 'tags');
        const tg = el('span', 'skill-tag'); tg.append(icon('bot'), document.createTextNode(e.agent)); tags.appendChild(tg);
        node.appendChild(tags);
      }
      if (e.skills?.length) {
        const tags = el('span', 'tags');
        e.skills.forEach(n => { const tg = el('span', 'skill-tag'); tg.append(icon('bolt'), document.createTextNode('/' + n)); tags.appendChild(tg); });
        node.appendChild(tags);
      }
      node.appendChild(document.createTextNode(e.text));
      if (e.files?.length) node.appendChild(attachChips(e.files));
      ctx.lastTask = e.text;
      ctx.inAgent = !!e.agent;
      ctx.container.appendChild(node);
      ctx.steps = 0;
      ctx.pill = makePill(ctx);
      ctx.container.appendChild(ctx.pill);
      return node;
    case 'answer': node = el('div', 'msg user', e.text); if (e.files?.length) node.appendChild(attachChips(e.files)); break;
    case 'talk': node = el('div', 'msg talk', e.text); break;
    case 'action': {
      node = el('div', 'step action' + (e.error ? ' fail' : ''));
      node.appendChild(el('span', 'name', e.name));
      node.appendChild(el('span', 'args', e.args && Object.keys(e.args).length ? JSON.stringify(e.args).slice(0, 160) : ''));
      if (e.error) node.appendChild(el('span', 'args', ' → ' + e.error.slice(0, 200)));
      ctx.steps++;
      updatePill(ctx, e.name);
      break;
    }
    case 'shot': {
      node = el('details', 'step');
      node.appendChild(el('summary', null, 'What the agent saw'));
      const img = el('img', 'shot');
      img.src = e.url;
      img.alt = 'Screenshot of the page with numbered elements';
      node.appendChild(img);
      break;
    }
    case 'final': {
      node = el('div', 'msg final');
      if (e.w) node.appendChild(wchip(e.w));
      node.appendChild(renderMd(e.text));
      finishPill(ctx);
      ctx.container.appendChild(node);
      const task = ctx.lastTask;
      if (task && !ctx.inAgent && !/^\/[\w-]+\s*$/.test(task)) {
        const row = el('div', 'final-actions');
        const b = el('button', 'link-btn');
        b.append(icon('bolt'), document.createTextNode('Save as skill'));
        b.type = 'button';
        b.title = 'Save this task so you can run it again with /name';
        b.onclick = () => openSkillForm({ name: slugify(task.split(/\s+/).slice(0, 4).join(' ')), description: task.slice(0, 120), instructions: task });
        row.appendChild(b);
        ctx.container.appendChild(row);
      }
      return node;
    }
    case 'error': node = withIcon('msg error', 'alert', e.text); finishPill(ctx); break;
    case 'stopped': node = el('div', 'msg stopped', 'STOPPED'); finishPill(ctx); break;
    case 'ask':
      node = el('div', 'card warn');
      node.appendChild(withIcon('card-head', 'question', e.text));
      if (ctx.live) node.appendChild(el('div', 'muted small', 'Type your reply below and press Reply.'));
      break;
    case 'confirm':
      node = el('div', 'card warn');
      node.appendChild(withIcon('card-head', 'alert', e.text));
      if (e.answer) node.appendChild(el('div', 'answer', e.answer));
      break;
    case 'memory': node = withIcon('memnote', 'memory', e.text); break;
    case 'agentStart': {
      node = el('div', 'agent-start');
      const hd = el('div', 'as-head'); hd.append(icon('bot'), el('span', null, `${e.name} · flight plan filed`)); node.appendChild(hd);
      const inp = Object.entries(e.inputs || {});
      if (inp.length) { const box = el('div', 'as-inputs'); inp.forEach(([k, v]) => box.appendChild(el('span', null, `${k}: ${v}`))); node.appendChild(box); }
      const ol = el('ol');
      (e.stages || []).forEach(s => ol.appendChild(el('li', null, s)));
      node.appendChild(ol);
      break;
    }
    case 'update': {
      node = el('div', 'update-card');
      const hd = el('div', 'up-head');
      hd.append(icon(e.mode === 'resume' ? 'play' : 'narrate'), el('b', null, e.n ? `UPDATE ${e.n}` : 'NOTE TO AGENT'));
      hd.appendChild(el('span', null, e.mode === 'resume' ? 'plan updated · resuming'
        : e.live ? `sent to ${e.live > 1 ? `${e.live} running tabs` : 'the running agent'}` : 'saved for the next steps'));
      node.appendChild(hd);
      node.appendChild(el('div', 'up-text', e.text));
      if (e.files?.length) node.appendChild(attachChips(e.files));
      break;
    }
    case 'stage': {
      node = el('div', 'stage-card');
      node.appendChild(el('span', 'leg-no', `LEG ${e.n}/${e.of}`));
      const tx = el('div', 'st-text');
      tx.appendChild(el('b', null, e.title));
      if (e.item) tx.appendChild(el('span', 'muted', `ITEM ${e.item}/${e.items}${e.itemName ? ` · ${e.itemName}` : ''}`));
      node.appendChild(tx);
      break;
    }
    case 'file': {
      const f = (ctx.files || []).find(x => x.id === e.fileId);
      node = f ? fileCard(f) : withIcon('memnote', 'file', `${e.name} (file not available)`);
      break;
    }
    default: return null;
  }
  if (e.w && node) node.prepend(wchip(e.w));
  ctx.container.appendChild(node);
  return node;
}
// Which parallel tab (worker) an event came from.
function wchip(n) { const c = el('span', 'wchip', `T${n}`); c.title = `Parallel tab ${n}`; return c; }

// ---------- connection to the engine ----------
async function resolveWho() {
  if (MODE === 'app') {
    let k = sessionStorage.getItem('dpKey');
    if (!k) { k = crypto.randomUUID(); sessionStorage.setItem('dpKey', k); }
    return { key: 'page:' + k, tabId: null, mode: 'app' };
  }
  let tabId = Number(PARAMS.get('tab')) || null;
  if (!tabId) { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t?.id ?? null; }
  return { key: 'tab:' + tabId, tabId, mode: 'panel' };
}
const who = await resolveWho();
let port = null;
let firstFull = true;
function connect() {
  port = chrome.runtime.connect({ name: 'dp-ui' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 400); });
  port.postMessage({ cmd: 'attach', ...who });
}
function cmd(name, extra = {}) {
  if (!port) connect();
  try { port.postMessage({ cmd: name, ...extra }); } catch (_) { setTimeout(() => cmd(name, extra), 300); }
}
setInterval(() => { try { port?.postMessage({ cmd: 'ping' }); } catch (_) { /* reconnecting */ } }, 20000);

const isLive = () => !!(viewed && sessionConv && viewed.id === sessionConv.id);

function onMessage(msg) {
  switch (msg.type) {
    case 'full':
      sessionConv = msg.conv;
      state = msg.state;
      if (!browsingOther) displayConversation(sessionConv);
      else applyState();
      if (firstFull) { firstFull = false; if (PARAMS.get('conv')) openConversation(PARAMS.get('conv')); }
      break;
    case 'state':
      state = msg.state;
      applyState();
      break;
    case 'event': {
      const e = msg.e;
      if (!sessionConv) break;
      if (msg.file) sessionConv.files.push(msg.file);
      if (!e.transient) sessionConv.events.push(e);
      if (isLive() && liveCtx) {
        $('empty')?.remove();
        const node = renderEvent(e, liveCtx);
        if (node) { nodes.set(e.id, node); node.classList.add('fresh'); }
        showConvBar(sessionConv);
        applyConfirm();
        scrollDown();
      }
      break;
    }
    case 'patch': {
      const ev = sessionConv?.events.find(x => x.id === msg.id);
      if (ev) Object.assign(ev, msg.changes);
      const node = isLive() ? nodes.get(msg.id) : null;
      if (node && msg.changes.error) { node.classList.add('fail'); node.appendChild(el('span', 'args', ' → ' + msg.changes.error.slice(0, 200))); }
      if (node && msg.changes.answer) { node.querySelector('.row')?.remove(); node.appendChild(el('div', 'answer', msg.changes.answer)); }
      break;
    }
    case 'historyChanged': loadHistory(); break;
    case 'needKey': openPanel('settings', true); $('settingsMsg').textContent = 'Add your DeepSeek API key first.'; break;
    case 'notice': if (msg.text !== 'busy') showNotice(msg.text); break;
    default: break;
  }
}
function showNotice(text) {
  const n = el('div', 'msg error', text);
  log.appendChild(n);
  scrollDown();
  setTimeout(() => n.remove(), 5000);
}

// ---------- applying engine state ----------
function applyState() {
  setLight(state.light || 'idle', state.lightLabel || 'Ready');
  $('statusText').textContent = state.status
    ? state.status.replace(/^Step (\d+):\s*/, 'STEP $1 · ').toUpperCase()
    : state.running ? 'STARTING…' : (state.pending ? 'WAITING FOR YOU' : 'READY FOR A TASK');
  const otherTab = state.workTab && state.workTab.id !== state.boundTabId;
  $('viewTabBtn').hidden = !otherTab;
  if (otherTab) $('viewTabBtn').title = `Show the tab: ${state.workTab.title || ''}`;
  // alert bar
  const bar = $('alarmBar');
  if (state.alert) {
    bar.className = 'alarm ' + state.alert.kind;
    $('alarmText').textContent = state.alert.text;
    bar.querySelector('.alarm-ic use').setAttribute('href', state.alert.kind === 'done' ? '#i-check' : state.alert.kind === 'ask' ? '#i-question' : '#i-alert');
    $('stopAlarmLabel').textContent = state.ringing ? 'Stop sound' : 'Dismiss';
    $('stopAlarmBtn').querySelector('use').setAttribute('href', state.ringing ? '#i-mute' : '#i-x');
    bar.hidden = false;
  } else bar.hidden = true;
  updateMeter();
  renderQueue();
  setComposer();
  applyConfirm();
  renderRunBar();
  renderSplitBar();
  if (!state.running && liveCtx) finishPill(liveCtx);
}

function applyConfirm() {
  const pid = state.pending?.type === 'confirm' ? state.pending.eventId : null;
  for (const [id, node] of nodes) {
    const row = node.querySelector?.(':scope > .row');
    if (id === pid && isLive()) {
      if (!row) {
        const r = el('div', 'row');
        const mk = (label, cls, choice) => { const b = el('button', 'btn ' + cls + ' small-btn', label); b.type = 'button'; b.onclick = () => { r.remove(); cmd('confirm', { choice }); }; return b; };
        r.append(mk('Deny', 'ghost', 'deny'), mk('Always on this site', 'ghost', 'site'), mk('Allow all for this task', 'ghost', 'all'), mk('Allow', 'primary', 'allow'));
        node.appendChild(r);
        scrollDown();
      }
    } else if (row) row.remove();
  }
}

// ---------- agent run bar ----------
function renderRunBar() {
  const r = state.agentRun;
  const bar = $('runBar');
  const show = !!r && isLive() && !browsingOther;
  bar.hidden = !show;
  if (!show) return;
  const statusText = { running: 'IN FLIGHT', paused: 'PAUSED', failed: 'NEEDS HELP', done: 'LANDED' }[r.status] || String(r.status).toUpperCase();
  $('runName').textContent = r.name;
  $('runMeta').textContent = `${statusText} · ${fmtCost(r.cost)}${r.maxCost ? ` / $${r.maxCost}` : ''}${r.updates ? ` · ${r.updates} UPDATE${r.updates === 1 ? '' : 'S'}` : ''}`;
  const path = $('runSteps');
  path.innerHTML = '';
  const cur = r.stage - 1;
  (r.stageTitles || []).forEach((t, i) => {
    if (i > 0) {
      const leg = el('span', 'leg');
      const fill = el('i');
      const legDone = r.status === 'done' || i <= cur;
      fill.style.width = legDone ? '100%' : '0%';
      if (i === cur && r.status === 'running') leg.classList.add('live');
      leg.appendChild(fill);
      path.appendChild(leg);
    }
    const wp = el('span', 'wp');
    wp.title = `${i + 1}. ${t}`;
    if (r.status === 'done' || i < cur) wp.classList.add('done');
    else if (i === cur) wp.classList.add(r.status === 'failed' ? 'fail' : r.status === 'paused' ? 'paused' : 'now');
    path.appendChild(wp);
  });
  const now = $('runNow');
  now.innerHTML = '';
  if (r.status === 'done') { now.appendChild(el('b', null, 'COMPLETE')); now.appendChild(el('span', null, `All ${r.stages} legs flown.`)); }
  else {
    now.appendChild(el('b', null, `LEG ${r.stage}/${r.stages}${r.items ? ` · ${r.item}/${r.items} DONE` : ''}`));
    now.appendChild(el('span', null, r.stageTitle + (r.failed ? ` · ${r.failed} skipped` : '')));
  }
  // Items progress + one lane per parallel tab.
  const prog = $('runItems');
  const showItems = r.status !== 'done' && !!r.items;
  prog.hidden = !showItems;
  if (showItems) $('runItemsFill').style.width = `${Math.round((r.item / r.items) * 100)}%`;
  renderLanes($('runLanes'), r.lanes && r.lanes.length > 1 && r.status === 'running' ? r.lanes : null);
  $('runResume').hidden = state.running || !['paused', 'failed', 'running'].includes(r.status);
  $('runStop').hidden = !state.running;
}
function renderLanes(lanes, ls) {
  lanes.innerHTML = '';
  lanes.hidden = !ls;
  if (ls) {
    for (const l of ls) {
      const row = el('div', 'lane' + (l.idle ? ' idle' : ''));
      row.appendChild(el('span', 'lane-no', `T${l.n}`));
      row.appendChild(el('span', 'lane-dot'));
      const tx = el('span', 'lane-text');
      tx.appendChild(el('b', null, l.idle ? 'Waiting' : `#${l.item} ${l.name}`));
      if (!l.idle && l.status) tx.appendChild(el('span', null, l.status.replace(/^Step (\d+): /, 'step $1 · ')));
      row.appendChild(tx);
      lanes.appendChild(row);
    }
  }
}
// Parallel tabs the agent decided to open by itself.
function renderSplitBar() {
  const sp = state.split;
  const bar = $('splitBar');
  const show = !!sp && isLive() && !browsingOther;
  bar.hidden = !show;
  if (!show) return;
  $('splitName').textContent = `Parallel tabs · ${sp.lanes.length}`;
  $('splitName').title = sp.title;
  $('splitMeta').textContent = `${sp.done}/${sp.total} DONE${sp.failed ? ` · ${sp.failed} FAILED` : ''} · ${sp.title.toUpperCase()}`;
  $('splitFill').style.width = `${Math.round((sp.done / Math.max(1, sp.total)) * 100)}%`;
  renderLanes($('splitLanes'), sp.lanes);
}
$('runResume').addEventListener('click', () => cmd('resumeAgent'));
$('runStop').addEventListener('click', () => cmd('stop'));

// ---------- meter ----------
function updateMeter() {
  const t = state.taskUsage || { hit: 0, miss: 0, out: 0, cost: 0 };
  const s = state.sessionUsage || { cost: 0 };
  const tokens = t.hit + t.miss + t.out;
  $('meterTask').textContent = `TASK ${fmtTokens(tokens)} TOK · ${fmtCost(t.cost)}`;
  $('meterTask').title = `Input ${fmtTokens(t.miss)} (+${fmtTokens(t.hit)} cached) · Output ${fmtTokens(t.out)}`;
  $('meterSession').textContent = `SESSION ${fmtCost(s.cost)}`;
  $('meterRate').textContent = settings.offPeak ? (isPeak() ? 'PEAK RATE' : 'OFF-PEAK · ½') : '';
  const pct = Math.min(100, (t.cost / (settings.taskBudget || 0.05)) * 100);
  const fill = $('meterFill');
  fill.style.width = pct + '%';
  fill.className = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
  $('meter').title = `Estimated DeepSeek cost. Bar = this task vs your budget of $${settings.taskBudget}.`;
}
setInterval(updateMeter, 60000);

// ---------- composer & queue ----------
function setComposer() {
  const sendBtn = $('sendBtn');
  const running = !!state.running;
  $('stopBtn').hidden = !running || browsingOther;
  const label = $('sendLabel');
  const ctxKind = composerContext();
  renderModes(ctxKind);
  const m = sendMode[ctxKind];
  if (ctxKind === 'ask') { label.textContent = 'Reply'; input.placeholder = 'Type your answer…'; $('hint').textContent = '↵ reply'; }
  else if (ctxKind === 'running' && m === 'steer') { label.textContent = 'Tell now'; input.placeholder = 'New info or a change — the agent uses it on its next step…'; $('hint').textContent = '↵ tell now'; }
  else if (ctxKind === 'running') { label.textContent = 'Queue'; input.placeholder = 'Add another task to the queue…'; $('hint').textContent = '↵ queue'; }
  else if (ctxKind === 'paused' && m === 'update') { label.textContent = 'Update & resume'; input.placeholder = 'New info or a change to the plan, e.g. "also collect the owner\'s name"…'; $('hint').textContent = '↵ update'; }
  else { label.textContent = 'Send'; input.placeholder = 'Describe a task…'; $('hint').textContent = '↵ send · / skills'; }
  $('newChatBtn').disabled = running;
  $('sideNewChat').disabled = running;
  input.disabled = browsingOther;
  sendBtn.disabled = browsingOther;
  $('otherRunning').hidden = !browsingOther;
}

// What a message does depends on the moment: while running it is queued or told to the agent now;
// while an agent is paused it updates the plan and resumes, or is just a chat.
const sendMode = { running: 'queue', paused: 'update' };
const MODES = {
  running: [['queue', 'Queue next', 'layers', 'Run it after this task finishes'], ['steer', 'Tell it now', 'narrate', 'Send new info or a change to the running agent — used on its next step']],
  paused: [['update', 'Update & resume', 'play', 'Add this to the agent\'s plan and continue where it stopped'], ['chat', 'Just chat', 'chat', 'Ask something without resuming the agent']],
};
function composerContext() {
  if (state.pending?.type === 'ask') return 'ask';
  if (state.running) return 'running';
  const r = state.agentRun;
  if (r && ['paused', 'failed', 'running'].includes(r.status)) return 'paused';
  return 'idle';
}
function renderModes(kind) {
  const box = $('sendModes');
  const opts = MODES[kind];
  box.hidden = !opts || browsingOther;
  if (!opts) return;
  box.querySelectorAll('.mode').forEach((b, i) => {
    const [val, text, ic, tip] = opts[i];
    b.dataset.value = val;
    b.dataset.kind = kind;
    b.title = tip;
    b.querySelector('use').setAttribute('href', '#i-' + ic);
    b.querySelector('span').textContent = text;
    const on = sendMode[kind] === val;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  const r = state.agentRun;
  $('modeNote').textContent = kind === 'paused' && sendMode.paused === 'update' && r ? `${r.name} is paused` : '';
}
$('sendModes').addEventListener('click', e => {
  const b = e.target.closest('.mode');
  if (!b) return;
  sendMode[b.dataset.kind] = b.dataset.value;
  setComposer();
  input.focus();
});

function renderQueue() {
  const queue = state.queue || [];
  const box = $('queueBox');
  box.hidden = !queue.length;
  box.classList.toggle('paused', !!state.queuePaused);
  $('queueTitle').textContent = state.queuePaused ? `Queue paused (${queue.length})` : `Up next (${queue.length})`;
  $('queueResume').hidden = !state.queuePaused || state.running;
  const ol = $('queueList');
  ol.innerHTML = '';
  queue.forEach((t, i) => {
    const li = el('li');
    const q = el('div', 'q');
    q.appendChild(el('span', null, t));
    const x = el('button');
    x.appendChild(icon('x'));
    x.type = 'button';
    x.title = 'Remove from queue';
    x.setAttribute('aria-label', 'Remove from queue');
    x.onclick = () => cmd('queueRemove', { index: i });
    q.appendChild(x);
    li.appendChild(q);
    ol.appendChild(li);
  });
}
$('queueClear').addEventListener('click', () => cmd('queueClear'));
$('queueResume').addEventListener('click', () => cmd('queueResume'));

// ---------- attachments ----------
// Files are read here in the panel: text-like files and spreadsheets/Word become text the model can read;
// everything is also kept as a file in the chat so the agent can upload it to websites.
const TEXT_EXT = new Set(['csv', 'tsv', 'txt', 'md', 'markdown', 'json', 'jsonl', 'html', 'htm', 'xml', 'yaml', 'yml', 'ini', 'log', 'sql', 'js', 'ts', 'css', 'py', 'php', 'vcf', 'ics', 'svg', 'rtf', 'srt', 'vtt']);
const SHEET_EXT = new Set(['xlsx', 'xls', 'xlsm', 'ods']);
const MAX_FILE = 15 * 1024 * 1024, MAX_FILES = 8;
let attachments = [];
const readAsDataUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
async function readAttachment(file) {
  const ext = extOf(file.name);
  const base = { name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
  if (TEXT_EXT.has(ext) || (file.type || '').startsWith('text/')) {
    const text = await file.text();
    const rows = ['csv', 'tsv'].includes(ext) ? Math.max(0, text.split(/\r?\n/).filter(l => l.trim()).length - 1) : null;
    return { ...base, text, rows };
  }
  const dataUrl = await readAsDataUrl(file);
  if (SHEET_EXT.has(ext) && globalThis.XLSX) {
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      let rows = 0;
      const text = wb.SheetNames.map(n => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false });
        rows += Math.max(0, csv.split('\n').filter(l => l.replace(/,/g, '').trim()).length - 1);
        return wb.SheetNames.length > 1 ? `## Sheet: ${n}\n${csv}` : csv;
      }).join('\n\n');
      return { ...base, text, rows, dataUrl };
    } catch (e) { return { ...base, dataUrl, note: 'This spreadsheet could not be read' }; }
  }
  if (ext === 'docx' && globalThis.JSZip) {
    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const xml = await zip.file('word/document.xml').async('string');
      const text = xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
      return { ...base, text, dataUrl };
    } catch (e) { return { ...base, dataUrl, note: 'This Word file could not be read' }; }
  }
  if (ext === 'pdf') {
    try {
      const { pdfToText } = await import('./lib/pdftext.js');
      const r = await pdfToText(await file.arrayBuffer(), { maxChars: 120000 });
      if (r.text.replace(/--- Page \d+ of \d+ ---/g, '').trim().length > 20) return { ...base, text: r.text, dataUrl, pages: r.pages };
      return { ...base, dataUrl, note: 'A scanned PDF with no text layer — the agent can upload it but not read it' };
    } catch (e) { return { ...base, dataUrl, note: 'This PDF could not be read' }; }
  }
  const note = (file.type || '').startsWith('image/') ? 'An image — DeepPilot cannot look at attached images yet' : 'A binary file';
  return { ...base, dataUrl, note };
}
async function addFiles(list) {
  const files = [...(list || [])];
  for (const f of files) {
    if (attachments.length >= MAX_FILES) { flashHint(`Up to ${MAX_FILES} files per message`); break; }
    if (f.size > MAX_FILE) { flashHint(`${f.name} is too big (max 15 MB)`); continue; }
    const slot = { name: f.name, size: f.size, loading: true };
    attachments.push(slot);
    renderAttachments();
    try { Object.assign(slot, await readAttachment(f), { loading: false }); }
    catch (e) { attachments = attachments.filter(x => x !== slot); flashHint(`Could not read ${f.name}`); }
    renderAttachments();
  }
}
function renderAttachments() {
  const box = $('attachList');
  box.innerHTML = '';
  box.hidden = !attachments.length;
  attachments.forEach((a, i) => {
    const chip = el('span', 'attach-chip' + (a.loading ? ' loading' : ''));
    chip.appendChild(icon(fileIconName(extOf(a.name))));
    const nm = el('span', 'an', a.name);
    nm.title = a.note || a.name;
    chip.appendChild(nm);
    chip.appendChild(el('span', 'as', a.loading ? 'reading…' : a.rows != null ? `${a.rows} rows` : a.pages ? `${a.pages} page${a.pages === 1 ? '' : 's'}` : fmtSize(a.size)));
    const x = el('button');
    x.type = 'button';
    x.title = `Remove ${a.name}`;
    x.setAttribute('aria-label', `Remove ${a.name}`);
    x.appendChild(icon('x'));
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); input.focus(); };
    chip.appendChild(x);
    box.appendChild(chip);
  });
}
function fmtSize(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`; }
function flashHint(t) { const h = $('hint'); const old = h.textContent; h.textContent = t; h.classList.add('warn'); setTimeout(() => { h.classList.remove('warn'); setComposer(); }, 2600); }
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
input.addEventListener('paste', e => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
{
  const zone = $('chatView');
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  zone.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('dropHint').hidden = false; $('form').classList.add('dropping'); });
  zone.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  zone.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) { $('dropHint').hidden = true; $('form').classList.remove('dropping'); } });
  zone.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('dropHint').hidden = true; $('form').classList.remove('dropping'); addFiles(e.dataTransfer.files); });
}
function attachChips(files) {
  const row = el('span', 'msg-files');
  for (const f of files) {
    const c = el('span', 'msg-file');
    c.append(icon(fileIconName(extOf(f.name))), el('span', null, f.name));
    c.title = `${f.name} · ${fmtSize(f.size || 0)}`;
    row.appendChild(c);
  }
  return row;
}

function sendText(text) {
  text = String(text || '').trim();
  if (attachments.some(a => a.loading)) { flashHint('Still reading your files…'); return; }
  if ((!text && !attachments.length) || browsingOther) return;
  if (!settings.apiKey) { openPanel('settings', true); $('settingsMsg').textContent = 'Add your DeepSeek API key first.'; return; }
  const kind = composerContext();
  const files = attachments.map(({ loading, ...a }) => a);
  attachments = [];
  renderAttachments();
  cmd('send', { text, mode: kind === 'running' || kind === 'paused' ? sendMode[kind] : '', files });
  if (kind === 'running') sendMode.running = 'queue'; // "tell now" is one-off
}
$('form').addEventListener('submit', e => {
  e.preventDefault();
  if (whisperRec || whisperBusy) { if (whisperRec) finishWhisper(true); return; } // finish speaking first, then send
  if (voice?.listening) {
    // Keep words still being recognised, then end voice input — sending always stops the mic.
    const pendingWords = $('interim').hidden ? '' : $('interim').textContent.trim();
    if (pendingWords) input.value = (input.value.trim() + ' ' + pendingWords).trim();
    voice.abort();
  }
  $('interim').hidden = true;
  if (attachments.some(a => a.loading)) { flashHint('Still reading your files…'); return; }
  const text = input.value;
  input.value = '';
  autoGrow();
  sendText(text);
});
input.addEventListener('keydown', e => {
  if (!slashMenu.hidden && slash.items.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slash.sel = (slash.sel + 1) % slash.items.length; updateSlash(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slash.sel = (slash.sel - 1 + slash.items.length) % slash.items.length; updateSlash(); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); chooseSlash(slash.sel); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(); }
});
$('stopBtn').addEventListener('click', () => cmd('stop'));

// ---------- resizable message box ----------
// Drag the handle above the box up/down (or use ↑/↓ on it); the box also grows as you type.
const grip = $('grip');
const MIN_H = 44;
const maxH = () => Math.round(window.innerHeight * 0.7);
let manualH = null;
try { const v = parseInt(localStorage.getItem('dpInputH'), 10); if (v) manualH = v; } catch (_) { /* storage unavailable */ }
function setInputHeight(h, save) {
  manualH = Math.max(MIN_H, Math.min(maxH(), Math.round(h)));
  input.style.height = manualH + 'px';
  if (save) { try { localStorage.setItem('dpInputH', String(manualH)); } catch (_) { /* ignore */ } }
}
function autoGrow() {
  input.style.height = 'auto';
  const want = Math.min(maxH(), Math.max(MIN_H, input.scrollHeight));
  input.style.height = Math.max(manualH || 0, want) + 'px';
}
if (manualH) setInputHeight(manualH, false);
input.addEventListener('input', autoGrow);
grip.addEventListener('pointerdown', e => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const startH = input.getBoundingClientRect().height;
  grip.classList.add('dragging');
  document.body.classList.add('resizing');
  const move = ev => setInputHeight(startH + (startY - ev.clientY), false);
  const up = () => {
    grip.releasePointerCapture(e.pointerId);
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    grip.classList.remove('dragging');
    document.body.classList.remove('resizing');
    setInputHeight(input.getBoundingClientRect().height, true);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});
grip.addEventListener('dblclick', () => {
  manualH = null;
  try { localStorage.removeItem('dpInputH'); } catch (_) { /* ignore */ }
  autoGrow();
});
grip.addEventListener('keydown', e => {
  const cur = input.getBoundingClientRect().height;
  if (e.key === 'ArrowUp') { e.preventDefault(); setInputHeight(cur + 24, true); }
  if (e.key === 'ArrowDown') { e.preventDefault(); setInputHeight(cur - 24, true); }
});
log.addEventListener('click', e => {
  const ex = e.target.closest('.example');
  if (ex && !state.running) sendText(ex.dataset.task || ex.textContent.trim());
});
$('viewTabBtn').addEventListener('click', () => cmd('viewTab'));

function startNewChat() {
  if (state.running) return;
  browsingOther = false;
  cmd('newChat');
  showView('chatView');
  input.focus();
}
$('newChatBtn').addEventListener('click', startNewChat);
$('sideNewChat').addEventListener('click', startNewChat);

// ---------- showing conversations ----------
function showConvBar(c) {
  $('convBar').hidden = !c || !c.events?.length;
  if (c) {
    $('convTitle').textContent = c.title;
    $('convTitle').title = `${c.title} · ${new Date(c.createdAt).toLocaleString()}`;
  }
}
function displayConversation(c) {
  viewed = c;
  nodes = new Map();
  log.innerHTML = '';
  const live = !!(c && sessionConv && c.id === sessionConv.id) || !c;
  if (!c || !c.events?.length) {
    log.appendChild(emptyTpl.cloneNode(true));
    liveCtx = live ? newCtx(log, c ? c.files : [], true) : null;
  } else {
    const ctx = newCtx(log, c.files || [], live);
    for (const e of c.events) { const n = renderEvent(e, ctx); if (n && e.id) nodes.set(e.id, n); }
    liveCtx = live ? ctx : null;
    if (live && !state.running) finishPill(ctx);
  }
  showConvBar(c);
  applyState();
  if (c && c.events?.length) scrollDown(); else log.scrollTop = 0;
  markActiveRows();
}

async function openConversation(id) {
  showView('chatView');
  if (MODE === 'app' && matchMedia('(max-width: 720px)').matches) document.body.classList.add('side-closed');
  if (sessionConv && sessionConv.id === id) { browsingOther = false; displayConversation(sessionConv); return; }
  if (state.running) {
    // A task is running in this session: show the old chat read-only.
    let c = await getConversation(id).catch(() => null);
    if (!c && cloud.isConfigured()) c = await cloud.getCloud(id).catch(() => null);
    if (!c) return;
    browsingOther = true;
    displayConversation(c);
    return;
  }
  browsingOther = false;
  cmd('openConv', { id });
}
$('goRunning').addEventListener('click', () => { browsingOther = false; displayConversation(sessionConv); });

$('convMd').addEventListener('click', () => {
  if (!viewed) return;
  download(`${viewed.title.replace(/[^\w\- ]+/g, '').slice(0, 50) || 'chat'}.md`, toMarkdown(viewed), 'text/markdown');
});
$('convDelete').addEventListener('click', async () => {
  const b = $('convDelete');
  if (!viewed) return;
  if (state.running && isLive()) { b.textContent = 'Stop the task first'; setTimeout(() => { b.textContent = 'Delete'; }, 1500); return; }
  if (b.textContent !== 'Click again to delete') { b.textContent = 'Click again to delete'; setTimeout(() => { b.textContent = 'Delete'; }, 3000); return; }
  b.textContent = 'Delete';
  const id = viewed.id;
  cmd('deleteConv', { id });
  if (browsingOther) { browsingOther = false; displayConversation(sessionConv); }
});

// ---------- view toggles ----------
function applyToggles() {
  document.body.classList.toggle('hide-talk', !settings.conversational);
  document.body.classList.toggle('hide-steps', !settings.showWorkflow);
  $('tglTalk').checked = settings.conversational;
  $('tglFlow').checked = settings.showWorkflow;
}
$('tglTalk').addEventListener('change', async e => { settings = await saveSettings({ conversational: e.target.checked }); applyToggles(); });
$('tglFlow').addEventListener('change', async e => { settings = await saveSettings({ showWorkflow: e.target.checked }); applyToggles(); scrollDown(); });

// ---------- tabs ----------
const VIEWS = ['chatView', 'historyView', 'agentsPanel', 'skillsPanel', 'memoryPanel', 'settings'];
const TAB_FOR = { chatView: 'tabChat', historyView: 'tabHistory', agentsPanel: 'agentsBtn', skillsPanel: 'skillsBtn', memoryPanel: 'memoryBtn' };
let currentView = 'chatView';
function moveInk() {
  const ink = document.querySelector('.tab-ink');
  const tab = $(TAB_FOR[currentView]);
  if (!ink) return;
  if (!tab || tab.offsetParent === null) { ink.style.width = '0'; return; }
  ink.style.width = tab.offsetWidth - 12 + 'px';
  ink.style.transform = `translateX(${tab.offsetLeft + 6}px)`;
}
function showView(id) {
  const changed = id !== currentView;
  currentView = id;
  for (const v of VIEWS) $(v).hidden = v !== id;
  for (const [view, tabId] of Object.entries(TAB_FOR)) {
    const t = $(tabId);
    t.classList.toggle('active', view === id);
    t.setAttribute('aria-selected', String(view === id));
  }
  $('settingsBtn').classList.toggle('on', id === 'settings');
  moveInk();
  if (changed) { const v = $(id); v.classList.remove('view-in'); void v.offsetWidth; v.classList.add('view-in'); }
  if (id === 'historyView') loadHistory();
  if (id === 'settings') fillSettings();
  if (id === 'memoryPanel') { renderMemories(); renderPlaybooks(); }
  if (id === 'agentsPanel') renderSchedules();
  if (id === 'skillsPanel') renderSkills();
  if (id === 'agentsPanel') renderAgents();
}
addEventListener('resize', moveInk);
$('tabChat').addEventListener('click', () => showView('chatView'));
$('tabHistory').addEventListener('click', () => showView('historyView'));

// Kept for older call sites: open a page view (or toggle back to chat).
function openPanel(which, force = false) {
  const id = { settings: 'settings', memory: 'memoryPanel', skills: 'skillsPanel', agents: 'agentsPanel' }[which];
  if (!force && currentView === id) showView('chatView');
  else showView(id);
}
$('skillsBtn').addEventListener('click', () => showView('skillsPanel'));
$('agentsBtn').addEventListener('click', () => showView('agentsPanel'));
$('memoryBtn').addEventListener('click', () => showView('memoryPanel'));
$('settingsBtn').addEventListener('click', () => openPanel('settings'));

// ---------- history (list in the panel, sidebar on the full page) ----------
let historyItems = [];
async function loadHistory() {
  const local = await listConversations().catch(() => []);
  const byId = new Map(local.map(c => [c.id, { ...c, local: true }]));
  let badge = 'local';
  if (cloud.isConfigured()) {
    const sess = await cloud.getSession().catch(() => null);
    if (sess) {
      badge = 'cloud';
      try {
        for (const c of await cloud.listCloud()) {
          const ex = byId.get(c.id);
          byId.set(c.id, ex ? { ...ex, inCloud: true } : { ...c, inCloud: true });
        }
      } catch (e) { badge = 'cloud-error'; console.warn(e); }
    }
  }
  const label = { local: 'Saved in this browser', cloud: 'Cloud sync on', 'cloud-error': 'Cloud unreachable — local copy' }[badge];
  for (const id of ['cloudBadge', 'sideCloud']) $(id).replaceChildren(icon(badge === 'local' ? 'laptop' : 'cloud'), document.createTextNode(label));
  // Include the live chat even before its first save finishes.
  const c0 = sessionConv;
  if (c0 && c0.events.length && !byId.has(c0.id)) byId.set(c0.id, { id: c0.id, title: c0.title, status: c0.status, updatedAt: c0.updatedAt, createdAt: c0.createdAt, usage: c0.usage, taskCount: 1, fileCount: c0.files.length });
  historyItems = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  renderHistory();
}

function groupLabel(ts) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  if (ts >= today) return 'Today';
  if (ts >= today - day) return 'Yesterday';
  if (ts >= today - 6 * day) return 'Previous 7 days';
  if (ts >= today - 29 * day) return 'Previous 30 days';
  return new Date(ts).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}
function timeLabel(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return ts >= today.getTime() ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${t}`;
}

function renderHistoryInto(container, query) {
  const q = (query || '').trim().toLowerCase();
  container.innerHTML = '';
  const items = historyItems.filter(c => !q || (c.title || '').toLowerCase().includes(q) || (c.fileNames || []).join(' ').toLowerCase().includes(q));
  if (!items.length) {
    const box = el('div', 'empty-list');
    box.appendChild(icon(q ? 'search' : 'history'));
    box.appendChild(el('span', null, q ? 'Nothing matches that search.' : 'No flights logged yet. Finished tasks land here.'));
    container.appendChild(box);
    return;
  }
  let group = null;
  for (const c of items) {
    const g = groupLabel(c.updatedAt);
    if (g !== group) { group = g; container.appendChild(el('div', 'hist-group', g)); }
    const b = el('button', 'hist-row');
    b.type = 'button';
    b.dataset.id = c.id;
    const t = el('div', 't');
    t.appendChild(el('span', 'sdot ' + (c.status || '')));
    if (c.agentRun) t.appendChild(icon('bot'));
    t.appendChild(el('span', 'title', c.title || 'Untitled'));
    if (c.inCloud) t.appendChild(icon('cloud'));
    b.appendChild(t);
    const m = el('div', 'm');
    const time = el('time', null, timeLabel(c.updatedAt));
    time.dateTime = new Date(c.updatedAt).toISOString();
    time.title = new Date(c.updatedAt).toLocaleString();
    m.appendChild(time);
    if (c.taskCount > 1) m.appendChild(el('span', null, `${c.taskCount} tasks`));
    if (c.usage?.cost) m.appendChild(el('span', null, fmtCost(c.usage.cost)));
    if (c.fileCount) m.appendChild(el('span', null, `${c.fileCount} FILE${c.fileCount > 1 ? 'S' : ''}`));
    b.appendChild(m);
    b.onclick = () => openConversation(c.id);
    container.appendChild(b);
  }
  markActiveRows();
}
function renderHistory() {
  renderHistoryInto($('historyList'), $('historySearch').value);
  if (MODE === 'app') renderHistoryInto($('sideList'), $('sideSearch').value);
}
function markActiveRows() {
  for (const r of document.querySelectorAll('.hist-row')) r.classList.toggle('active', r.dataset.id === viewed?.id);
}
$('historySearch').addEventListener('input', renderHistory);
$('sideSearch').addEventListener('input', renderHistory);

async function openFullPage() {
  const base = chrome.runtime.getURL('sidepanel.html?mode=app');
  const convParam = (!state.running && viewed) ? `&conv=${viewed.id}` : '';
  const existing = (await chrome.tabs.query({})).find(t => t.url?.startsWith(base));
  if (existing && !convParam) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: base + convParam });
  }
}
$('fullPageBtn').addEventListener('click', openFullPage);
$('histFullPage').addEventListener('click', openFullPage);
$('sideToggle').addEventListener('click', () => document.body.classList.toggle('side-closed'));

// ---------- skills ----------
async function refreshSkills() { skills = await loadSkills(); renderSkills(); }
function actBtn(iconName, label, title, fn, cls = 'ghost') {
  const b = el('button', 'btn small-btn ' + cls);
  b.type = 'button';
  b.title = title;
  if (iconName) b.appendChild(icon(iconName));
  b.appendChild(el('span', null, label));
  b.onclick = fn;
  return b;
}
function confirmDelete(btn, fn) {
  if (btn.dataset.confirm) return fn();
  btn.dataset.confirm = '1';
  btn.classList.add('danger');
  btn.lastChild.textContent = 'Confirm';
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.classList.remove('danger'); btn.lastChild.textContent = 'Delete'; } }, 3000);
}
function emptyCard(text) {
  const li = el('li', 'muted');
  li.textContent = text;
  return li;
}
function renderSkills() {
  const ul = $('skillList');
  ul.innerHTML = '';
  if (!skills.length) { ul.appendChild(emptyCard('No skills yet. Create one below, or finish a task and choose "Save as skill".')); return; }
  for (const sk of skills) {
    const li = el('li');
    const top = el('div', 'card-top');
    const ci = el('div', 'card-ic'); ci.appendChild(icon('bolt')); top.appendChild(ci);
    const main = el('div', 'card-main');
    main.appendChild(el('b', 'card-title', '/' + sk.name));
    if (sk.description) main.appendChild(el('div', 'card-desc', sk.description));
    top.appendChild(main);
    li.appendChild(top);
    const acts = el('div', 'acts');
    acts.appendChild(actBtn('play', 'Run', `Run /${sk.name}`, () => { input.value = `/${sk.name} `; showView('chatView'); input.focus(); }, 'primary'));
    acts.appendChild(actBtn('pencil', 'Edit', `Edit /${sk.name}`, () => openSkillForm(sk)));
    acts.appendChild(actBtn('clock', 'Schedule', `Run /${sk.name} automatically`, () => openScheduleForm({ text: `/${sk.name}`, name: sk.description || sk.name })));
    acts.appendChild(el('span', 'spacer'));
    acts.appendChild(actBtn('trash', 'Delete', `Delete /${sk.name}`, e => confirmDelete(e.currentTarget, async () => { await deleteSkill(sk.id); refreshSkills(); })));
    li.appendChild(acts);
    ul.appendChild(li);
  }
}
function openSkillForm(sk = {}) {
  if ($('skillsPanel').hidden) openPanel('skills');
  $('skillId').value = sk.id || '';
  $('skillName').value = sk.name || '';
  $('skillDesc').value = sk.description || '';
  $('skillInstr').value = sk.instructions || '';
  $('skillFormTitle').textContent = sk.id ? `Edit /${sk.name}` : 'New skill';
  $('skillMsg').textContent = '';
  $('skillForm').open = true;
  $('skillName').focus();
}
$('skillCancel').addEventListener('click', () => { $('skillForm').open = false; $('skillFormTitle').textContent = 'New skill'; $('skillId').value = ''; });
$('skillSave').addEventListener('click', async () => {
  try {
    const name = await saveSkill({ id: $('skillId').value || undefined, name: $('skillName').value, description: $('skillDesc').value, instructions: $('skillInstr').value });
    $('skillMsg').textContent = `Saved. Type /${name} in the chat to run it.`;
    $('skillId').value = '';
    await refreshSkills();
    setTimeout(() => { $('skillForm').open = false; $('skillFormTitle').textContent = 'New skill'; }, 900);
  } catch (e) { $('skillMsg').textContent = 'Error: ' + e.message; }
});
$('skillExport').addEventListener('click', () => download('deeppilot-skills.json', JSON.stringify({ skills: skills.map(({ name, description, instructions }) => ({ name, description, instructions })) }, null, 2), 'application/json'));
$('skillImport').addEventListener('click', () => $('skillImportFile').click());
$('skillImportFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try { const n = await importSkills(await f.text()); $('skillMsg').textContent = `Imported ${n} skill${n === 1 ? '' : 's'}.`; $('skillForm').open = true; }
  catch (err) { $('skillMsg').textContent = 'Error: ' + err.message; $('skillForm').open = true; }
  e.target.value = '';
  refreshSkills();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.skills) refreshSkills();
  if (changes.agents) loadAgents().then(a => { agents = a; if (!$('agentsPanel').hidden) renderAgents(); });
  if (changes.memories && !$('memoryPanel').hidden) renderMemories();
  if (changes.playbooks && !$('memoryPanel').hidden) renderPlaybooks();
});

// ---------- agents panel ----------
function renderAgents() {
  const ul = $('agentList');
  ul.innerHTML = '';
  if (!agents.length) ul.appendChild(emptyCard('No agents yet. Create one below — or start from the Lead Hunter example.'));
  for (const ag of agents) {
    const li = el('li', 'agent-row');
    const top = el('div', 'card-top');
    const ci = el('div', 'card-ic'); ci.appendChild(icon('bot')); top.appendChild(ci);
    const main = el('div', 'card-main');
    main.appendChild(el('b', 'card-title', ag.title || ag.name));
    main.appendChild(el('div', 'card-cmd', `/${ag.name} · ${ag.stages.length} LEG${ag.stages.length === 1 ? '' : 'S'}${ag.stages.some(x => x.forEach && !x.sequential) && (ag.parallel ?? 4) > 1 ? ` · ×${ag.parallel ?? 4} TABS` : ''}${ag.inputs.length ? ' · ' + ag.inputs.map(i => i.name).join(', ') : ''}`));
    if (ag.description) main.appendChild(el('div', 'card-desc', ag.description));
    top.appendChild(main);
    li.appendChild(top);
    const stages = el('div', 'card-stages');
    ag.stages.forEach((st, i) => stages.appendChild(el('span', null, `${String(i + 1).padStart(2, '0')} ${st.title}${st.forEach ? ' ↻' : ''}`)));
    li.appendChild(stages);
    const acts = el('div', 'acts');
    acts.appendChild(actBtn('play', 'Run', `Run ${ag.title}`, () => openRunForm(ag), 'primary'));
    acts.appendChild(actBtn('pencil', 'Edit', `Edit ${ag.title}`, () => openAgentForm(ag)));
    acts.appendChild(actBtn('clock', 'Schedule', `Run ${ag.title} automatically`, () => openScheduleForm({ text: `/${ag.name}${(ag.inputs || []).map(i => i.default ? ` ${i.name}="${i.default}"` : '').join('')}`, name: ag.title })));
    acts.appendChild(actBtn('copy', 'Duplicate', `Duplicate ${ag.title}`, async () => { try { await saveAgent({ ...ag, id: undefined, name: ag.name + '-copy', title: ag.title + ' (copy)' }); } catch (e) { alert(e.message); } }));
    acts.appendChild(el('span', 'spacer'));
    acts.appendChild(actBtn('trash', 'Delete', `Delete ${ag.title}`, e => confirmDelete(e.currentTarget, () => deleteAgent(ag.id))));
    li.appendChild(acts);
    ul.appendChild(li);
  }
}

// run form
let runAgentDef = null;
function openRunForm(ag) {
  runAgentDef = ag;
  $('agentForm').open = false;
  $('runFormTitle').textContent = ag.title;
  const box = $('runFormInputs');
  box.innerHTML = '';
  for (const i of ag.inputs) {
    const l = el('label', null, i.name.replace(/_/g, ' '));
    const inp = el('input');
    inp.type = 'text';
    inp.value = i.default || '';
    inp.dataset.name = i.name;
    l.appendChild(inp);
    box.appendChild(l);
  }
  if (!ag.inputs.length) box.appendChild(el('p', 'muted small', 'This agent has no inputs.'));
  $('runExtra').value = '';
  $('agentRunForm').hidden = false;
  (box.querySelector('input') || $('runExtra')).focus();
}
$('runCancel').addEventListener('click', () => { $('agentRunForm').hidden = true; });
$('runGo').addEventListener('click', () => {
  if (!runAgentDef) return;
  if (!settings.apiKey) { openPanel('settings', true); $('settingsMsg').textContent = 'Add your DeepSeek API key first.'; return; }
  if (state.running) { alert('A task is already running in this tab. Stop it or use another tab.'); return; }
  const inputs = {};
  for (const inp of $('runFormInputs').querySelectorAll('input')) inputs[inp.dataset.name] = inp.value.trim();
  browsingOther = false;
  cmd('runAgent', { agentId: runAgentDef.id, inputs, extra: $('runExtra').value.trim() });
  $('agentRunForm').hidden = true;
  openPanel('agents');
  showView('chatView');
});

// builder
function stageEditor(st = {}) {
  const li = el('li', 'stage-ed');
  const top = el('div', 'stage-top');
  const title = el('input');
  title.type = 'text';
  title.placeholder = 'Stage title, e.g. Find leads on Google Maps';
  title.value = st.title || '';
  title.className = 'st-title';
  title.setAttribute('aria-label', 'Stage title');
  top.appendChild(title);
  const mk = (label, t, fn) => { const b = el('button', null, label); b.type = 'button'; b.title = t; b.setAttribute('aria-label', t); b.onclick = fn; return b; };
  const ib = (name, t, fn) => { const b = mk('', t, fn); b.appendChild(icon(name)); return b; };
  top.appendChild(ib('chevron-up', 'Move up', () => li.previousElementSibling && li.parentNode.insertBefore(li, li.previousElementSibling)));
  top.appendChild(ib('chevron-down', 'Move down', () => li.nextElementSibling && li.parentNode.insertBefore(li.nextElementSibling, li)));
  top.appendChild(ib('x', 'Remove stage', () => li.remove()));
  li.appendChild(top);
  const ins = el('textarea');
  ins.rows = 4;
  ins.placeholder = 'Exactly what to do in this stage: which site to open, what to collect, what to save…';
  ins.value = st.instructions || '';
  ins.className = 'st-ins';
  ins.setAttribute('aria-label', 'Stage instructions');
  li.appendChild(ins);
  const fe = el('label', 'check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = !!st.forEach;
  cb.className = 'st-each';
  fe.appendChild(cb);
  fe.appendChild(el('span', null, 'Repeat for each item saved by earlier stages'));
  li.appendChild(fe);
  const sq = el('label', 'check sub-check');
  const sqb = el('input');
  sqb.type = 'checkbox';
  sqb.checked = !!st.sequential;
  sqb.className = 'st-seq';
  sq.appendChild(sqb);
  sq.appendChild(el('span', null, 'One item at a time (no parallel tabs) — for messaging or posting'));
  sq.hidden = !cb.checked;
  cb.addEventListener('change', () => { sq.hidden = !cb.checked; });
  li.appendChild(sq);
  const dw = el('input');
  dw.type = 'text';
  dw.placeholder = 'Done when… (optional)';
  dw.value = st.doneWhen || '';
  dw.className = 'st-done';
  dw.setAttribute('aria-label', 'Done when');
  li.appendChild(dw);
  return li;
}
function inputRow(i = {}) {
  const row = el('div', 'input-row');
  const n = el('input'); n.type = 'text'; n.className = 'in-name'; n.placeholder = 'name, e.g. city'; n.value = i.name || ''; n.setAttribute('aria-label', 'Input name');
  const d = el('input'); d.type = 'text'; d.className = 'in-def'; d.placeholder = 'default, e.g. Houston, TX'; d.value = i.default || ''; d.setAttribute('aria-label', 'Default value');
  const x = el('button'); x.appendChild(icon('x')); x.type = 'button'; x.title = 'Remove input'; x.setAttribute('aria-label', 'Remove input'); x.onclick = () => row.remove();
  row.append(n, d, x);
  return row;
}
$('agAddInput').addEventListener('click', () => { const r = inputRow(); $('agInputs').appendChild(r); r.querySelector('input').focus(); });
function fillAgentForm(ag = {}) {
  $('agId').value = ag.id || '';
  $('agTitle').value = ag.title || '';
  $('agDesc').value = ag.description || '';
  $('agRules').value = ag.rules || '';
  const ib = $('agInputs');
  ib.innerHTML = '';
  (ag.inputs || []).forEach(i => ib.appendChild(inputRow(i)));
  $('agMaxCost').value = ag.maxCost ?? 0.5;
  $('agMaxSteps').value = ag.maxStepsPerStage ?? 60;
  $('agParallel').value = ag.parallel ?? 4;
  const ol = $('agStages');
  ol.innerHTML = '';
  (ag.stages?.length ? ag.stages : [{}]).forEach(s => ol.appendChild(stageEditor(s)));
}
function openAgentForm(ag = null) {
  if ($('agentsPanel').hidden) openPanel('agents');
  $('agentRunForm').hidden = true;
  fillAgentForm(ag || {});
  $('agentFormTitle').textContent = ag?.id ? `Edit ${ag.title}` : 'New agent';
  $('agMsg').textContent = '';
  $('agentForm').open = true;
  $('agTitle').focus();
}
function readAgentForm() {
  const inputs = [...$('agInputs').children].map(r => ({ name: r.querySelector('.in-name').value.trim(), default: r.querySelector('.in-def').value.trim() })).filter(i => i.name);
  const stages = [...$('agStages').children].map(li => ({
    title: li.querySelector('.st-title').value, instructions: li.querySelector('.st-ins').value,
    forEach: li.querySelector('.st-each').checked, sequential: li.querySelector('.st-seq').checked, doneWhen: li.querySelector('.st-done').value,
  }));
  const title = $('agTitle').value.trim();
  return { id: $('agId').value || undefined, title, name: title, description: $('agDesc').value, rules: $('agRules').value, inputs, stages, maxCost: $('agMaxCost').value, maxStepsPerStage: $('agMaxSteps').value, parallel: $('agParallel').value };
}
$('agentForm').addEventListener('toggle', () => {
  if (!$('agentForm').open || $('agStages').children.length) return;
  // Opening an empty form: fill in the defaults — unless a title was already typed, then only add the first stage.
  if ($('agTitle').value.trim()) $('agStages').appendChild(stageEditor({})); else fillAgentForm({});
});
$('agAddStage').addEventListener('click', () => { const li = stageEditor({}); $('agStages').appendChild(li); li.querySelector('input').focus(); });
$('agCancel').addEventListener('click', () => { $('agentForm').open = false; $('agentFormTitle').textContent = 'New agent'; $('agId').value = ''; });
$('agSave').addEventListener('click', async () => {
  try {
    const ag = await saveAgent(readAgentForm());
    $('agMsg').textContent = `Saved. Run it from the list or type /${ag.name} in the chat.`;
    agents = await loadAgents();
    renderAgents();
    setTimeout(() => { $('agentForm').open = false; $('agentFormTitle').textContent = 'New agent'; $('agId').value = ''; }, 1200);
  } catch (e) { $('agMsg').textContent = 'Error: ' + e.message; }
});
$('agExample').addEventListener('click', () => { fillAgentForm({ ...EXAMPLE_LEAD_HUNTER, id: '' }); $('agMsg').textContent = 'Example loaded — adjust anything, then Save agent.'; });
$('agDraft').addEventListener('click', async () => {
  const desc = $('agDraftText').value.trim();
  if (!desc) { $('agMsg').textContent = 'Describe what the agent should do first.'; $('agDraftText').focus(); return; }
  if (!settings.apiKey) { openPanel('settings', true); $('settingsMsg').textContent = 'Add your DeepSeek API key first.'; return; }
  const btn = $('agDraft');
  btn.disabled = true;
  $('agDraftLabel').textContent = 'Drafting…';
  $('agMsg').textContent = '';
  try {
    const { message } = await chatCompletion({
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, maxTokens: 4000,
      messages: [{ role: 'system', content: DRAFT_SYSTEM_PROMPT }, { role: 'user', content: desc }],
    });
    const txt = String(message.content || '').replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
    const j = JSON.parse(txt);
    fillAgentForm({ ...j, id: $('agId').value || '', inputs: (j.inputs || []).map(i => (typeof i === 'string' ? { name: i, default: '' } : i)) });
    $('agMsg').textContent = 'Draft ready — review each stage, then save.';
  } catch (e) {
    $('agMsg').textContent = 'Could not draft the agent: ' + e.message;
  } finally {
    btn.disabled = false;
    $('agDraftLabel').textContent = 'Draft with AI';
  }
});
$('agExport').addEventListener('click', () => download('deeppilot-agents.json', JSON.stringify({ agents: agents.map(({ id, createdAt, updatedAt, ...a }) => a) }, null, 2), 'application/json'));
$('agImport').addEventListener('click', () => $('agImportFile').click());
$('agImportFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try { const n = await importAgents(await f.text()); agents = await loadAgents(); renderAgents(); alert(`Imported ${n} agent${n === 1 ? '' : 's'}.`); }
  catch (err) { alert('Import failed: ' + err.message); }
  e.target.value = '';
});

// "/" menu in the message box
const slash = { items: [], sel: 0, start: -1 };
const slashMenu = $('slashMenu');
function slashQuery() {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const m = before.match(/(^|\s)\/([\wঀ-৿-]*)$/);
  return m ? { q: m[2].toLowerCase(), start: pos - m[2].length - 1 } : null;
}
function closeSlash() { slashMenu.hidden = true; slash.items = []; }
function updateSlash() {
  const sq = input.disabled ? null : slashQuery();
  if (!sq) { closeSlash(); return; }
  slash.start = sq.start;
  const hits = [
    ...agents.filter(a => a.name.includes(sq.q) || (a.title || '').toLowerCase().includes(sq.q)).map(a => ({ name: a.name, description: a.description, kind: 'agent' })),
    ...skills.filter(k => k.name.includes(sq.q) || (k.description || '').toLowerCase().includes(sq.q)),
  ];
  slash.items = [...hits, { create: true }];
  slash.sel = Math.min(slash.sel, slash.items.length - 1);
  slashMenu.innerHTML = '';
  if (!hits.length) slashMenu.appendChild(el('div', 'slash-empty', skills.length || agents.length ? 'No match.' : 'No skills or agents yet.'));
  slash.items.forEach((it, i) => {
    const b = el('button', 'slash-item' + (i === slash.sel ? ' sel' : ''));
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === slash.sel));
    if (it.create) { const n = el('span', 'n'); n.append(icon('plus'), document.createTextNode('Create a new skill')); b.appendChild(n); }
    else {
      const n = el('span', 'n');
      n.append(icon(it.kind === 'agent' ? 'bot' : 'bolt'), document.createTextNode('/' + it.name));
      n.appendChild(el('span', 'kind', it.kind === 'agent' ? 'agent' : 'skill'));
      b.appendChild(n);
      if (it.description) b.appendChild(el('span', 'd', it.description));
    }
    b.addEventListener('mousedown', e => { e.preventDefault(); chooseSlash(i); });
    slashMenu.appendChild(b);
  });
  slashMenu.hidden = false;
  slashMenu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function chooseSlash(i) {
  const it = slash.items[i];
  if (!it) return;
  closeSlash();
  if (it.create) { openSkillForm({}); return; }
  const pos = input.selectionStart;
  input.value = input.value.slice(0, slash.start) + '/' + it.name + ' ' + input.value.slice(pos);
  const caret = slash.start + it.name.length + 2;
  input.setSelectionRange(caret, caret);
  input.focus();
}
input.addEventListener('input', () => { slash.sel = 0; updateSlash(); });
input.addEventListener('click', updateSlash);
input.addEventListener('blur', () => setTimeout(closeSlash, 150));

// ---------- memory panel ----------
async function renderMemories() {
  const list = await loadMemories();
  const ul = $('memoryList');
  ul.innerHTML = '';
  if (!list.length) { ul.appendChild(emptyCard('Nothing on board yet. Add a fact above, or say "remember …" in the chat.')); return; }
  for (const m of list) {
    const li = el('li');
    li.appendChild(el('span', 'mem-id', `M${m.id}`));
    li.appendChild(el('span', 't mem-t', m.text));
    const del = el('button', 'icon-btn sm danger-hover');
    del.appendChild(icon('trash'));
    del.type = 'button';
    del.title = 'Delete memory';
    del.setAttribute('aria-label', `Delete memory m${m.id}`);
    del.onclick = async () => { await deleteMemory(m.id); renderMemories(); };
    li.appendChild(del);
    ul.appendChild(li);
  }
}
// ---------- scheduled runs ----------
async function renderSchedules() {
  const { loadSchedules, deleteSchedule, saveSchedule, describe, nextRun } = await import('./lib/schedule.js');
  const ul = $('scheduleList');
  ul.innerHTML = '';
  const list = await loadSchedules();
  if (!list.length) { ul.appendChild(emptyCard('Nothing scheduled. Use ⏱ Schedule on an agent or skill, or New schedule below.')); return; }
  for (const sc of list.sort((a, b) => (nextRun(a) || 9e15) - (nextRun(b) || 9e15))) {
    const li = el('li', 'card sched-card' + (sc.enabled ? '' : ' off'));
    const top = el('div', 'card-top');
    const ic = el('span', 'card-ic'); ic.appendChild(icon('clock')); top.appendChild(ic);
    const main = el('div', 'card-main');
    main.appendChild(el('b', null, sc.name));
    const nx = nextRun(sc);
    main.appendChild(el('div', 'card-cmd', `${describe(sc).toUpperCase()}${nx ? ` · NEXT ${new Date(nx).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase()}` : ' · PAUSED'}`));
    main.appendChild(el('p', 'card-desc', sc.text.slice(0, 140)));
    if (sc.lastRun) main.appendChild(el('div', 'card-cmd muted', `LAST RUN ${new Date(sc.lastRun).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }).toUpperCase()}`));
    top.appendChild(main);
    li.appendChild(top);
    const acts = el('div', 'card-acts');
    acts.appendChild(actBtn('play', 'Run now', `Run ${sc.name} now`, () => { cmd('send', { text: sc.text }); showView('chatView'); }, 'primary'));
    acts.appendChild(actBtn(sc.enabled ? 'pause' : 'play', sc.enabled ? 'Pause' : 'Resume', sc.enabled ? 'Pause this schedule' : 'Resume this schedule', async () => { try { await saveSchedule({ ...sc, enabled: !sc.enabled, onceAt: sc.onceAt }); } catch (e) { alert(e.message); } renderSchedules(); }));
    acts.appendChild(actBtn('pencil', 'Edit', `Edit ${sc.name}`, () => openScheduleForm(sc)));
    if (sc.lastConv) acts.appendChild(actBtn('history', 'Last result', 'Open the chat of the last run', () => { cmd('openConv', { id: sc.lastConv }); showView('chatView'); }));
    acts.appendChild(actBtn('trash', 'Delete', `Delete ${sc.name}`, e => confirmDelete(e.currentTarget, async () => { await deleteSchedule(sc.id); renderSchedules(); })));
    li.appendChild(acts);
    ul.appendChild(li);
  }
}
function syncScheduleFields() {
  const r = $('scRepeat').value;
  $('scTimeWrap').hidden = r === 'hourly' || r === 'once';
  $('scMinuteWrap').hidden = r !== 'hourly';
  $('scOnceWrap').hidden = r !== 'once';
  $('scDayWrap').hidden = r !== 'weekly';
}
function openScheduleForm(sc = {}) {
  if ($('agentsPanel').hidden) openPanel('agents');
  $('scId').value = sc.id || '';
  $('scText').value = sc.text || '';
  $('scName').value = sc.name && sc.name !== sc.text ? sc.name : '';
  $('scRepeat').value = sc.repeat || 'daily';
  $('scTime').value = sc.time || '09:00';
  $('scMinute').value = sc.minute ?? 0;
  $('scDay').value = String(sc.day ?? 1);
  const soon = new Date(Date.now() + 3600e3); soon.setMinutes(0, 0, 0);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $('scOnce').value = sc.onceAt ? local(new Date(sc.onceAt)) : local(soon);
  $('scheduleFormTitle').textContent = sc.id ? `Edit ${sc.name}` : 'New schedule';
  $('scMsg').textContent = '';
  syncScheduleFields();
  $('scheduleForm').open = true;
  $('scheduleForm').scrollIntoView({ block: 'nearest' });
  $('scText').focus();
}
$('scRepeat').addEventListener('change', syncScheduleFields);
$('scCancel').addEventListener('click', () => { $('scheduleForm').open = false; });
$('scSave').addEventListener('click', async () => {
  const { saveSchedule, describe } = await import('./lib/schedule.js');
  try {
    const sc = await saveSchedule({
      id: $('scId').value || undefined, text: $('scText').value, name: $('scName').value, repeat: $('scRepeat').value,
      time: $('scTime').value, minute: $('scMinute').value, day: $('scDay').value,
      onceAt: $('scRepeat').value === 'once' ? new Date($('scOnce').value).toISOString() : null,
    });
    $('scMsg').textContent = `Saved — runs ${describe(sc)}.`;
    renderSchedules();
    setTimeout(() => { $('scheduleForm').open = false; }, 1200);
  } catch (e) { $('scMsg').textContent = 'Error: ' + e.message; }
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.schedules && !$('agentsPanel').hidden) renderSchedules(); });

async function renderPlaybooks() {
  const { loadUserPlaybooks, deleteUserPlaybook, BUILTIN } = await import('./lib/playbooks.js');
  $('builtinPlaybooks').textContent = BUILTIN.map(b => b.name).join(' · ');
  const ul = $('playbookList');
  ul.innerHTML = '';
  const list = await loadUserPlaybooks();
  if (!list.length) { ul.appendChild(emptyCard('No learned notes yet. After a task on a site, DeepPilot saves what it learned here.')); return; }
  for (const p of list.sort((a, b) => b.updatedAt - a.updatedAt)) {
    const li = el('li');
    li.appendChild(el('span', 'mem-id', p.domain));
    li.appendChild(el('span', 't mem-t', p.text));
    const del = el('button', 'icon-btn sm danger-hover');
    del.appendChild(icon('trash'));
    del.type = 'button';
    del.title = `Delete notes for ${p.domain}`;
    del.setAttribute('aria-label', `Delete notes for ${p.domain}`);
    del.onclick = async () => { await deleteUserPlaybook(p.id); renderPlaybooks(); };
    li.appendChild(del);
    ul.appendChild(li);
  }
}
$('addMemoryBtn').addEventListener('click', async () => {
  const t = $('memoryInput').value.trim();
  if (!t) return;
  try { await addMemory(t); $('memoryInput').value = ''; } catch (e) { alert(e.message); }
  renderMemories();
});

// ---------- settings ----------
const FIELDS = ['blockedDomains', 'apiKey', 'model', 'baseUrl', 'plannerModel', 'plannerBaseUrl', 'plannerKey', 'verifyDone', 'maxSteps', 'vision', 'smartVision', 'confirmRisky', 'showCursor', 'autoParallel', 'maxParallel', 'chromeSync', 'syncKeys', 'soundDone', 'soundAsk', 'soundError', 'volume',
  'repeatAlarm', 'notify', 'voiceLang', 'voiceEngine', 'whisperKey', 'whisperUrl', 'whisperModel', 'voiceWords', 'priceHit', 'priceMiss', 'priceOut', 'offPeak', 'taskBudget', 'supabaseUrl', 'supabaseKey'];
for (const sel of document.querySelectorAll('.sound-select')) {
  for (const [v, label] of Object.entries(SOUNDS)) { const o = el('option', null, label); o.value = v; sel.appendChild(o); }
}
async function renderTrusted() {
  const { trustedSites = [] } = await chrome.storage.local.get('trustedSites');
  const line = $('trustedSitesLine');
  line.innerHTML = '';
  if (!trustedSites.length) { line.textContent = 'Sites where you chose "Always on this site" will be listed here.'; return; }
  line.append(document.createTextNode(`Always allowed without asking: ${trustedSites.join(', ')} `));
  const b = el('button', 'link-btn', 'Reset');
  b.type = 'button';
  b.onclick = async () => { await chrome.storage.local.set({ trustedSites: [] }); renderTrusted(); };
  line.appendChild(b);
}
function fillSettings() {
  renderTrusted();
  for (const k of FIELDS) {
    const f = $('s_' + k);
    if (!f) continue;
    if (f.type === 'checkbox') f.checked = !!settings[k]; else f.value = settings[k];
  }
  refreshCloudUi();
  toggleWhisperFields();
  for (const r of document.querySelectorAll('input[name=theme]')) r.checked = r.value === (settings.theme || 'light');
}
function readSettings() {
  const out = {};
  const th = document.querySelector('input[name=theme]:checked');
  if (th) out.theme = th.value;
  for (const k of FIELDS) {
    const f = $('s_' + k);
    if (!f) continue;
    out[k] = f.type === 'checkbox' ? f.checked : f.value;
  }
  return out;
}
async function applySettings(values) {
  settings = await saveSettings(values);
  cloud.configure(settings.supabaseUrl, settings.supabaseKey);
  voice?.setLang(chromeLang());
  applyTheme();
  applyToggles();
  updateMeter();
}
$('saveSettingsBtn').addEventListener('click', async () => {
  await applySettings(readSettings());
  $('settingsMsg').textContent = 'Saved.';
  setTimeout(() => { $('settingsMsg').textContent = ''; }, 1500);
});
for (const b of document.querySelectorAll('.play')) {
  b.addEventListener('click', () => playOnce($(b.dataset.for).value, parseFloat($('s_volume').value)));
}
$('testKeyBtn').addEventListener('click', async () => {
  const s = readSettings();
  const msg = $('settingsMsg');
  msg.textContent = 'Testing…';
  try {
    const { message } = await chatCompletion({
      baseUrl: (s.baseUrl || '').trim(), apiKey: s.apiKey.trim(), model: s.model.trim(),
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 50,
    });
    msg.textContent = `Connected — model replied: ${(message.content || '').slice(0, 40) || '(empty)'}`;
  } catch (e) { msg.textContent = `Connection failed: ${e.message}`; }
});

// cloud account
async function refreshCloudUi() {
  const s = cloud.isConfigured() ? await cloud.getSession().catch(() => null) : null;
  $('cloudLoggedIn').hidden = !s;
  $('cloudLoggedOut').hidden = !!s;
  if (s) $('cloudUser').textContent = s.user?.email || 'your account';
}
async function cloudAction(fn) {
  const msg = $('cloudMsg');
  await applySettings(readSettings());
  if (!cloud.isConfigured()) { msg.textContent = 'Enter the Supabase URL and anon key first.'; return; }
  msg.textContent = 'Working…';
  try { msg.textContent = (await fn()) || ''; } catch (e) { msg.textContent = 'Error: ' + e.message; }
  refreshCloudUi();
  toggleWhisperFields();
}
$('cloudSignIn').addEventListener('click', () => cloudAction(async () => {
  await cloud.signIn($('cloudEmail').value.trim(), $('cloudPass').value);
  $('cloudPass').value = '';
  return 'Signed in. New tasks will sync to the cloud.';
}));
$('cloudSignUp').addEventListener('click', () => cloudAction(async () => {
  const r = await cloud.signUp($('cloudEmail').value.trim(), $('cloudPass').value);
  $('cloudPass').value = '';
  return r.needsConfirm ? 'Account created. Confirm the email Supabase sent you, then sign in.' : 'Account created and signed in.';
}));
$('cloudSignOut').addEventListener('click', () => cloudAction(async () => { await cloud.signOut(); return 'Signed out.'; }));
$('cloudSyncAll').addEventListener('click', () => cloudAction(async () => {
  const items = await listConversations();
  let n = 0;
  for (const m of items) {
    const c = await getConversation(m.id);
    if (!c) continue;
    await cloud.upsertConversation(c);
    c.synced = true;
    await saveConversation(c);
    n++;
  }
  return `Uploaded ${n} conversation${n === 1 ? '' : 's'}.`;
}));
fetch(chrome.runtime.getURL('supabase.sql')).then(r => r.text()).then(t => { $('sqlText').textContent = t; }).catch(() => {});
$('copySql').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('sqlText').textContent);
  $('copySql').lastChild.textContent = 'Copied';
  setTimeout(() => { $('copySql').lastChild.textContent = 'Copy SQL'; }, 1500);
});

// ---------- voice ----------
// Two engines: Whisper (record → accurate transcription, default) and Chrome's built-in live recognition.
const micBtn = $('micBtn');
const interimBox = $('interim');
const langCode = () => (settings.voiceLang && settings.voiceLang !== 'auto' ? settings.voiceLang.split('-')[0] : '');
const chromeLang = () => (settings.voiceLang && settings.voiceLang !== 'auto' ? settings.voiceLang : navigator.language || 'en-US');
function voiceMsg(text, ms = 6000) {
  interimBox.hidden = false;
  interimBox.textContent = text;
  clearTimeout(voiceMsg.t);
  if (ms) voiceMsg.t = setTimeout(() => { interimBox.hidden = true; }, ms);
}
function setMic(on, title) {
  micBtn.setAttribute('aria-pressed', String(on));
  micBtn.title = title || (on ? 'Stop and insert text' : 'Voice input');
}
function askMicPermission() {
  voiceMsg('Allow the microphone in the tab that just opened, then press the mic again.');
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}
function insertText(t) {
  if (!t) return;
  input.value = (input.value.trim() ? input.value.replace(/\s*$/, ' ') : '') + t;
  input.dispatchEvent(new Event('input'));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// Whisper engine
let whisperRec = null, whisperBusy = false, recStart = 0, recTick = null;
const useWhisper = () => settings.voiceEngine === 'whisper' && !!settings.whisperKey;
function vocabPrompt() {
  const base = 'DeepPilot, LinkedIn, Facebook, WordPress, Elementor, Google Maps, ChatGPT, HVAC, CSV, Excel, PDF.';
  const sk = skills.map(s => s.name.replace(/-/g, ' ')).join(', ');
  return [settings.voiceWords, sk, base].filter(Boolean).join(' ');
}
function renderRecording(level = 0) {
  const secs = Math.floor((Date.now() - recStart) / 1000);
  interimBox.hidden = false;
  interimBox.innerHTML = '';
  interimBox.appendChild(el('span', 'rec-dot'));
  interimBox.appendChild(document.createTextNode(` LISTENING ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} `));
  const lvl = el('span', 'lvl');
  const bar = el('i');
  bar.style.width = Math.round(level * 100) + '%';
  lvl.appendChild(bar);
  interimBox.appendChild(lvl);
  interimBox.appendChild(document.createTextNode(' MIC OR SEND TO FINISH · ESC CANCELS'));
}
let lastLevel = 0;
async function startWhisper() {
  whisperRec = createRecorder({
    onLevel: lv => { lastLevel = lv; const b = interimBox.querySelector('.lvl i'); if (b) b.style.width = Math.round(lv * 100) + '%'; },
    onAutoStop: () => finishWhisper(false),
  });
  try { await whisperRec.start(); }
  catch (e) {
    whisperRec = null;
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') askMicPermission();
    else voiceMsg('Microphone error: ' + e.message);
    return;
  }
  recStart = Date.now();
  setMic(true);
  renderRecording(0);
  recTick = setInterval(() => renderRecording(lastLevel), 1000);
}
async function finishWhisper(sendAfter) {
  if (!whisperRec) return;
  const r = whisperRec;
  whisperRec = null;
  clearInterval(recTick);
  setMic(false);
  whisperBusy = true;
  micBtn.disabled = true;
  voiceMsg('Transcribing…', 0);
  try {
    const blob = await r.stop();
    if (!blob) { voiceMsg('No audio was recorded.'); return; }
    const text = await transcribe(blob, { url: settings.whisperUrl, key: settings.whisperKey, model: settings.whisperModel, language: langCode(), prompt: vocabPrompt() });
    interimBox.hidden = true;
    if (!text) { voiceMsg("Didn't catch that — try again a bit closer to the mic."); return; }
    insertText(text);
    if (sendAfter) setTimeout(() => $('form').requestSubmit(), 0);
  } catch (e) {
    voiceMsg(e.message, 9000);
  } finally {
    whisperBusy = false;
    micBtn.disabled = false;
  }
}
function cancelWhisper() {
  if (!whisperRec) return;
  whisperRec.cancel();
  whisperRec = null;
  clearInterval(recTick);
  setMic(false);
  voiceMsg('Recording cancelled.', 2000);
}

// Chrome engine (live, instant)
let voice = null;
if (voiceSupported()) {
  voice = createVoice({
    lang: chromeLang(),
    onText: t => insertText(t),
    onInterim: t => { if (!whisperRec) { interimBox.hidden = !t; interimBox.textContent = t; } },
    onState: on => setMic(on, on ? 'Stop listening' : 'Voice input'),
    onError: err => { if (err === 'mic-permission') askMicPermission(); else voiceMsg(err); },
  });
}

micBtn.addEventListener('click', () => {
  if (whisperRec) return finishWhisper(false);
  if (whisperBusy) return;
  if (voice?.listening) return voice.stop();
  if (useWhisper()) return startWhisper();
  if (settings.voiceEngine === 'whisper' && !settings.whisperKey) voiceMsg('Tip: add a free Whisper key in Settings → Voice input for much better accuracy.', 5000);
  if (voice) { voice.setLang(chromeLang()); voice.toggle(); } else voiceMsg('Voice input is not supported in this browser.');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && whisperRec) { e.preventDefault(); cancelWhisper(); } });
function toggleWhisperFields() { $('whisperFields').hidden = $('s_voiceEngine').value !== 'whisper'; }
$('s_voiceEngine').addEventListener('change', toggleWhisperFields);

// ---------- init ----------
if (MODE === 'app') {
  document.body.classList.add('app');
  $('sidebar').hidden = false;
  document.title = 'DeepPilot';
  if (matchMedia('(max-width: 720px)').matches) document.body.classList.add('side-closed');
}
loadHistory();
applyToggles();
applyState();
connect();
// One orchestrated entry: header, nav, telemetry, then the empty-state content.
requestAnimationFrame(() => {
  document.body.classList.remove('booting');
  $('main').classList.add('enter');
  $('empty')?.classList.add('enter');
  moveInk();
  setTimeout(() => $('main').classList.remove('enter'), 900);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(k => k in settings)) loadSettings().then(s => { settings = s; applyToggles(); updateMeter(); applyTheme(); });
});
if (!settings.apiKey) openPanel('settings', true);


// ---------- sync between computers (Chrome Sync) + backup ----------
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
}
async function renderSyncStatus() {
  const { syncStatus: st, chromeSync = true } = await chrome.storage.local.get(['syncStatus', 'chromeSync']);
  const box = $('syncStatus');
  box.className = 'sync-status ' + (!chromeSync ? 'off' : st?.error ? 'err' : st?.at ? 'ok' : '');
  if (!chromeSync) $('syncText').textContent = 'Sync is off on this computer';
  else if (!st?.at) $('syncText').textContent = 'Not synced yet';
  else {
    const c = st.counts || {};
    $('syncText').textContent = st.error || `Synced ${c.memories ?? 0} memories · ${c.skills ?? 0} skills · ${c.agents ?? 0} agents · ${ago(st.at)}`;
  }
  const pct = st?.quota ? Math.min(100, Math.round((st.used / st.quota) * 100)) : 0;
  $('syncFill').style.width = pct + '%';
  $('syncFill').parentElement.title = st?.quota ? `Chrome Sync space used: ${Math.round(st.used / 1024)} KB of ${Math.round(st.quota / 1024)} KB` : '';
  $('syncFill').className = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : '';
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ('syncStatus' in ch || 'chromeSync' in ch)) renderSyncStatus();
});
setInterval(() => { if (!$('settings').hidden) renderSyncStatus(); }, 30000);
renderSyncStatus();
$('syncNow').addEventListener('click', async () => {
  $('syncMsg').textContent = 'Syncing…';
  const r = await chrome.runtime.sendMessage({ target: 'sync', cmd: 'now' }).catch(e => ({ error: e.message }));
  $('syncMsg').textContent = r?.error ? 'Error: ' + r.error : 'Up to date.';
  renderSyncStatus();
});
$('syncClear').addEventListener('click', async () => {
  const b = $('syncClear');
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to remove'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Remove from Chrome Sync'; }, 3500); return; }
  b.dataset.armed = '';
  b.textContent = 'Remove from Chrome Sync';
  await chrome.storage.local.set({ chromeSync: false });
  const r = await chrome.runtime.sendMessage({ target: 'sync', cmd: 'clear' }).catch(e => ({ error: e.message }));
  $('s_chromeSync').checked = false;
  $('syncMsg').textContent = r?.error ? 'Error: ' + r.error : 'Removed from Chrome Sync and turned sync off here. Your data on this computer is kept.';
});
$('backupExport').addEventListener('click', async () => {
  const d = await chrome.storage.local.get(['memories', 'skills', 'agents']);
  const cfg = { ...settings };
  for (const k of ['apiKey', 'whisperKey', 'supabaseKey', 'plannerKey']) delete cfg[k];
  const data = { app: 'DeepPilot', kind: 'backup', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), memories: d.memories || [], skills: d.skills || [], agents: d.agents || [], settings: cfg };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `deeppilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('syncMsg').textContent = 'Backup downloaded (API keys are not included).';
});
$('backupRestore').addEventListener('click', () => $('backupFile').click());
$('backupFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const b = JSON.parse(await f.text());
    if (b.app !== 'DeepPilot' || b.kind !== 'backup') throw new Error('This is not a DeepPilot backup file.');
    const cur = await chrome.storage.local.get(['memories', 'skills', 'agents']);
    // Merge: items with the same name (skills/agents) or text (memories) are replaced by the backup's copy.
    const mem = [...(cur.memories || [])];
    let next = mem.reduce((mx, m) => Math.max(mx, m.id || 0), 0);
    for (const m of b.memories || []) {
      if (!m?.text) continue;
      const hit = mem.find(x => (m.uid && x.uid === m.uid) || x.text.toLowerCase() === m.text.toLowerCase());
      if (hit) Object.assign(hit, { text: m.text });
      else mem.push({ id: ++next, uid: m.uid || crypto.randomUUID(), text: m.text, created: m.created || Date.now() });
    }
    const byName = (a, bb) => { const map = new Map((a || []).map(x => [x.name, x])); for (const x of bb || []) if (x?.name) map.set(x.name, x); return [...map.values()]; };
    const cfg = { ...(b.settings || {}) };
    for (const k of ['apiKey', 'whisperKey', 'supabaseKey', 'plannerKey']) delete cfg[k];
    await chrome.storage.local.set({ memories: mem, skills: byName(cur.skills, b.skills), agents: byName(cur.agents, b.agents) });
    if (Object.keys(cfg).length) await saveSettings(cfg);
    $('syncMsg').textContent = `Restored ${(b.memories || []).length} memories, ${(b.skills || []).length} skills, ${(b.agents || []).length} agents and your settings.`;
  } catch (err) { $('syncMsg').textContent = 'Error: ' + err.message; }
});
