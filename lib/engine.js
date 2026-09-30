// DeepPilot engine — runs in the background service worker.
// Every session (one per browser tab's side panel, or per full-page window) owns its own agent,
// conversation, queue and status. Sessions keep running when you switch tabs or close the panel;
// the side panel / full page are just views that connect over a port and render what happens.
import { Agent } from './agent.js';
import * as B from './browser.js';
import { loadSettings, DEFAULTS } from './settings.js';
import { costOf, addUsage } from './pricing.js';
import { newConversation, saveConversation, getConversation, deleteConversation } from './store.js';
import * as cloud from './cloud.js';
import { loadSkills, expandSkills } from './skills.js';
import { loadAgents, parseInputs, clampParallel } from './agents.js';
import { isBinary, mimeOf, extOf } from './files.js';
import { startSync } from './sync.js';
import { loadSchedules, markRun, rearmAll, alarmId, arm } from './schedule.js';

// ---------- settings ----------
let settings = { ...DEFAULTS };
const ready = loadSettings().then(s => { settings = s; applySettings(); startSync(); });
function applySettings() {
  cloud.configure(settings.supabaseUrl, settings.supabaseKey);
  B.setCursorEnabled(settings.showCursor);
  for (const s of sessions.values()) if (s.agent) { s.agent.settings = settings; }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some(k => k in DEFAULTS)) loadSettings().then(s => { settings = s; applySettings(); });
});

// ---------- offscreen helper (sounds + binary files) ----------
let offscreenCreating = null;
async function ensureOffscreen() {
  const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument()
    : (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
  if (has) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification: 'Play task alert sounds and build Excel/PDF/Word files for the user.',
    }).catch(e => { if (!/single offscreen/i.test(e.message)) throw e; }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}
async function offscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

function textToDataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};charset=utf-8;base64,${btoa(bin)}`;
}
// Read a PDF's text in the offscreen document (PDF.js needs a page context).
async function readPdf({ url, dataUrl, fromPage, maxChars }) {
  const r = await offscreen({ cmd: 'pdftext', url, dataUrl, fromPage, maxChars });
  if (!r?.ok) throw new Error(r?.error || 'PDF reader unavailable');
  return r;
}

export async function buildDataUrl(file) {
  if (file.dataUrl) return file.dataUrl;
  if (isBinary(file.name)) {
    const r = await offscreen({ cmd: 'build', file: { name: file.name, content: file.content } });
    if (!r?.ok) throw new Error(r?.error || 'file builder unavailable');
    return r.dataUrl;
  }
  const bom = ['csv', 'tsv'].includes(extOf(file.name)) ? '﻿' : '';
  return textToDataUrl(bom + String(file.content ?? ''), mimeOf(file.name));
}

// ---------- alarms ----------
let ringing = false;
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.target === 'engine' && msg.cmd === 'ringing') {
    ringing = !!msg.on;
    for (const s of sessions.values()) s.pushState();
  }
});
async function ringSound(kind) {
  const sound = { done: settings.soundDone, ask: settings.soundAsk, error: settings.soundError }[kind];
  if (!sound || sound === 'none') return;
  try { await offscreen({ cmd: 'ring', sound, volume: settings.volume, repeat: settings.repeatAlarm }); ringing = !!settings.repeatAlarm; } catch (e) { console.warn('sound failed', e); }
}
async function stopSound() {
  ringing = false;
  try { if (await chrome.offscreen.hasDocument?.()) await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'stop' }); } catch (_) { /* none */ }
}
async function playShort(kind) {
  const sound = { done: settings.soundDone }[kind];
  if (sound && sound !== 'none') try { await offscreen({ cmd: 'play', sound, volume: settings.volume }); } catch (_) { /* ignore */ }
}

// Keep the service worker alive while any session is running (extension API calls reset the idle timer).
let keepAlive = null;
function updateKeepAlive() {
  const any = [...sessions.values()].some(s => s.running);
  if (any && !keepAlive) keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  if (!any && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

// ---------- sessions ----------
const sessions = new Map(); // key -> Session
const sleep = ms => new Promise(r => setTimeout(r, ms));
function labelOf(it, i) {
  const v = it && typeof it === 'object' ? (it.name || it.title || it.company || it.company_name || it.website || it.url || Object.values(it)[0]) : it;
  return String(v ?? `item ${i + 1}`).slice(0, 80);
}
// ---------- attachments (files the user adds to a message) ----------
const MAX_ATTACH = 8, MAX_ATTACH_BYTES = 15 * 1024 * 1024;
function cleanAttachments(files) {
  return (Array.isArray(files) ? files : []).slice(0, MAX_ATTACH).filter(f => f && f.name && (f.text != null || f.dataUrl)).map(f => ({
    id: crypto.randomUUID(), name: String(f.name).slice(0, 180), mime: String(f.mime || 'application/octet-stream'), size: Number(f.size) || 0,
    text: f.text != null ? String(f.text) : null, dataUrl: f.dataUrl && String(f.dataUrl).length < MAX_ATTACH_BYTES * 1.4 ? String(f.dataUrl) : null,
    rows: f.rows ?? null, pages: f.pages ?? null, note: f.note ? String(f.note).slice(0, 200) : '',
  }));
}
// The part of the prompt that shows the model what the user attached (text is inlined, trimmed to a budget).
function attachBlock(files, budget = 60000) {
  if (!files?.length) return '';
  const per = Math.floor(budget / files.length);
  return files.map(f => {
    const head = `--- ATTACHED FILE: ${f.name} (${fmtBytes(f.size)}${f.rows != null ? `, ${f.rows} rows` : ''}${f.pages ? `, ${f.pages} pages` : ''}) ---`;
    const reuse = `It is saved in this chat as "${f.name}", so you can upload it to a website with upload_file.`;
    if (f.text != null) {
      const t = f.text.length > per ? `${f.text.slice(0, per)}\n[… trimmed: showing ${per.toLocaleString()} of ${f.text.length.toLocaleString()} characters]` : f.text;
      return `${head}\n${t}\n${f.dataUrl ? reuse : ''}`.trim();
    }
    return `${head}\n(${f.note || 'This file type cannot be read as text.'}) ${reuse}`;
  }).join('\n\n');
}
function fmtBytes(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`; }

function parseLoose(text) {
  const t = String(text || '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* not json */ } }
  return t;
}
// [pattern, max parallel tabs, reason] — sites that restrict automated activity.
const SENSITIVE = [
  [/linkedin/, 1, 'LinkedIn limits automated activity'],
  [/facebook|instagram|\bfb\b|messenger/, 1, 'Facebook/Instagram limit automated activity'],
  [/\bx\.com|twitter|tiktok|reddit/, 1, 'social sites limit automated activity'],
  [/gmail|outlook|send (an )?e-?mail|send (a )?message|\bdm\b/, 1, 'sending messages is done one at a time'],
  [/google maps|maps\.google|google\.com\/maps/, 2, 'Google Maps limits rapid searches'],
];
const LIGHT_LABEL = { idle: 'Ready', running: 'Working', ask: 'Needs you', error: 'Stopped', done: 'Done' };
const BADGE = { idle: ['', '#5b6478'], running: ['•••', '#b8e04a'], ask: ['!', '#f0b43c'], error: ['×', '#e5534b'], done: ['✓', '#5fd0a8'] };

class Session {
  constructor(key, { tabId = null, mode = 'panel' } = {}) {
    this.key = key;
    this.id = crypto.randomUUID();
    this.boundTabId = tabId;
    this.mode = mode;
    this.ports = new Set();
    this.conv = null;
    this.agent = null;
    this.running = false;
    this.pending = null;
    this.queue = [];
    this.queuePaused = false;
    this.taskUsage = null;
    this.sessionUsage = null;
    this.status = null;
    this.light = 'idle';
    this.lightLabel = LIGHT_LABEL.idle;
    this.alert = null;
    this.workTab = null;
    this.seq = 0;
    this.saveTimer = null;
    this.cloudTimer = null;
    this.workers = new Set(); // every Agent currently running for this session (parallel workers)
    this.lanes = null;        // live worker lanes of a parallel agent stage
    this.queueFiles = [];     // attachments of queued messages (same order as this.queue)
  }

  post(msg) { for (const p of this.ports) { try { p.postMessage(msg); } catch (_) { /* closed */ } } }
  state() {
    return {
      running: this.running,
      pending: this.pending ? { type: this.pending.type, eventId: this.pending.eventId || null } : null,
      queue: this.queue, queuePaused: this.queuePaused,
      taskUsage: this.taskUsage, sessionUsage: this.sessionUsage,
      status: this.laneStatus() || this.status, light: this.light, lightLabel: this.lightLabel,
      alert: this.alert, ringing,
      workTab: this.workTab, boundTabId: this.boundTabId, mode: this.mode,
      convId: this.conv?.id || null,
      agentRun: this.runSummary(),
      split: this.split ? { title: this.split.title, done: this.split.done, total: this.split.total, failed: this.split.failed.length, lanes: this.split.lanes.map(l => ({ n: l.n, item: l.item != null ? l.item + 1 : null, name: l.itemName || '', status: l.status || '', idle: l.item == null })) } : null,
      startedAt: this.running ? this.startedAt : null,
    };
  }
  laneStatus() {
    if (this.running && this.split) {
      const busy = this.split.lanes.filter(l => l.item != null).length;
      return `${busy}/${this.split.lanes.length} tabs · ${this.split.done}/${this.split.total} done`;
    }
    if (!this.running || !this.lanes || this.lanes.length < 2) return null;
    const busy = this.lanes.filter(l => l.item != null).length;
    const r = this.conv?.agentRun;
    return `${busy}/${this.lanes.length} tabs · ${r?.doneItems?.length || 0}/${r?.items?.length || 0} done`;
  }
  runSummary() {
    const r = this.conv?.agentRun;
    if (!r) return null;
    const st = r.def.stages[Math.min(r.stage, r.def.stages.length - 1)];
    const doneN = Array.isArray(r.doneItems) ? r.doneItems.length : (r.item || 0);
    return {
      name: r.def.title || r.def.name, status: r.status, stage: Math.min(r.stage + 1, r.def.stages.length), stages: r.def.stages.length,
      stageTitle: st?.title || '', item: st?.forEach ? doneN : null, items: st?.forEach ? r.items.length : null,
      failed: st?.forEach ? (r.failedItems || []).length : 0,
      updates: (r.updates || []).length,
      lanes: this.running && this.lanes ? this.lanes.map(l => ({ n: l.n, item: l.item != null ? l.item + 1 : null, name: l.itemName || '', status: l.status || '', idle: l.item == null })) : null,
      cost: this.conv.usage?.cost ? this.conv.usage.cost - (r.costAtStart || 0) : 0, maxCost: r.def.maxCost || 0,
      stageTitles: r.def.stages.map(x => x.title),
    };
  }

  pushState() { this.post({ type: 'state', state: this.state() }); }
  pushFull() { this.post({ type: 'full', conv: this.conv, state: this.state() }); }

  badgeTab() { return this.boundTabId ?? this.agent?.tabId ?? null; }
  setLight(light, label) {
    this.light = light;
    this.lightLabel = label || LIGHT_LABEL[light];
    const tabId = this.badgeTab();
    if (tabId != null) {
      const [text, color] = BADGE[light] || BADGE.idle;
      chrome.action.setBadgeText({ tabId, text }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
      chrome.action.setTitle({ tabId, title: `DeepPilot — ${this.lightLabel}` }).catch(() => {});
    }
    this.pushState();
  }

  alertUser(kind, text) {
    this.alert = { kind, text };
    ringSound(kind);
    if (settings.notify) {
      chrome.notifications.create('dp:' + this.key, {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'DeepPilot', message: text, priority: 2, requireInteraction: kind !== 'done',
      }).catch(() => {});
    }
    this.pushState();
  }
  dismiss() {
    if (this.alert) { this.alert = null; chrome.notifications.clear('dp:' + this.key).catch(() => {}); }
    stopSound();
    this.pushState();
  }

  emit(e, extra = {}) {
    e.t = Date.now();
    e.id = `${e.t.toString(36)}-${(this.seq++).toString(36)}`;
    if (!e.transient) this.conv.events.push(e);
    this.post({ type: 'event', e, ...extra });
    if (!e.transient) this.scheduleSave();
    return e;
  }
  patch(e, changes) {
    Object.assign(e, changes);
    this.post({ type: 'patch', id: e.id, changes });
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(false), 800);
  }
  async persist(now) {
    const conv = this.conv;
    if (!conv) return;
    clearTimeout(this.saveTimer);
    conv.updatedAt = Date.now();
    try { await saveConversation(conv); } catch (e) { console.warn('local save failed', e); }
    if (now) broadcast({ type: 'historyChanged' });
    const sess = await cloud.getSession().catch(() => null);
    if (!sess) return;
    const push = async () => {
      try { await cloud.upsertConversation(conv); conv.synced = true; await saveConversation(conv); }
      catch (e) { conv.synced = false; console.warn('cloud sync failed', e); }
    };
    clearTimeout(this.cloudTimer);
    if (now) await push(); else this.cloudTimer = setTimeout(push, 4000);
  }

  // The bridge the agent talks to. `lane` is set for agent-run workers: parallel workers tag their
  // events with their number (W2…) and report status/tab to their own lane instead of the session.
  bridge(lane = null) {
    const s = this;
    const tag = lane?.parallel ? { w: lane.n } : {};
    const own = !lane || (!lane.parallel) || (lane.n === 1 && !lane.helper); // drives the session-level status/tab
    return {
      status(text) {
        if (lane) lane.status = text || null;
        if (own && !lane?.parallel) s.status = text || null;
        s.pushState();
      },
      tab(tab) {
        if (lane) lane.tabId = tab?.id ?? null;
        if (own) s.workTab = tab ? { id: tab.id, title: tab.title || '' } : null;
        s.pushState();
      },
      thought(text) { s.emit({ type: 'talk', text, ...tag }); },
      action(name, args) { return name === 'done' ? null : s.emit({ type: 'action', name, args, ...tag }); },
      actionFailed(e, msg) { if (e) s.patch(e, { error: String(msg).slice(0, 300) }); },
      screenshot(url) { if (url && own) s.emit({ type: 'shot', url, transient: true }); },
      final(text) {
        if (lane) lane.lastFinal = String(text || '');
        if (lane?.helper) s.emit({ type: 'action', name: 'finished', args: { item: `#${lane.item + 1} ${lane.itemName}`, summary: String(text || '').replace(/\s+/g, ' ').slice(0, 120) }, ...tag });
        else s.emit({ type: 'final', text, ...tag });
      },
      error(text) {
        if (text === 'Stopped.') { if (own) s.emit({ type: 'stopped' }); return; }
        if (lane) lane.lastError = String(text).slice(0, 300);
        s.emit({ type: 'error', text, ...tag });
      },
      memory(text) { s.emit({ type: 'memory', text, ...tag }); },
      skillsChanged() { /* views listen to storage */ },
      file(f) {
        const rec = { id: crypto.randomUUID(), name: f.name, mime: f.mime, ...(f.dataUrl ? { dataUrl: f.dataUrl } : { content: f.content }) };
        s.conv.files.push(rec);
        s.emit({ type: 'file', fileId: rec.id, name: rec.name }, { file: rec });
      },
      usage(u) {
        const c = costOf(u, settings);
        s.conv.usage = addUsage(s.conv.usage, c);
        s.taskUsage = addUsage(s.taskUsage, c);
        s.sessionUsage = addUsage(s.sessionUsage, c);
        s.pushState();
      },
      // Parallel workers take turns asking the user: one question card at a time.
      ask(question) {
        return s.oneAtATime(() => new Promise((resolve, reject) => {
          const e = s.emit({ type: 'ask', text: question, ...tag });
          s.pending = { type: 'ask', eventId: e.id, resolve, reject };
          s.setLight('ask');
          s.alertUser('ask', 'DeepPilot needs your input: ' + question.slice(0, 120));
        }));
      },
      confirm(question) {
        return s.oneAtATime(() => new Promise((resolve, reject) => {
          const e = s.emit({ type: 'confirm', text: question, ...tag });
          const labels = { deny: 'Denied', allow: 'Allowed', all: 'Allowed for the rest of this task', site: 'Always allowed on this site' };
          s.pending = {
            type: 'confirm', eventId: e.id, reject,
            resolve: choice => {
              s.pending = null;
              s.patch(e, { answer: labels[choice] || 'Denied' });
              s.dismiss();
              s.setLight('running');
              resolve(choice in labels ? choice : 'deny');
            },
          };
          s.setLight('ask');
          s.alertUser('ask', 'DeepPilot wants your permission: ' + question.slice(0, 120));
        }));
      },
      cancelPending() {
        if (s.pending) { const p = s.pending; s.pending = null; p.reject(new DOMException('Aborted', 'AbortError')); }
      },
    };
  }

  oneAtATime(fn) {
    const run = () => (this.stopRequested && this.workers.size > 1 ? Promise.reject(new DOMException('Aborted', 'AbortError')) : fn());
    const p = (this.askChain || Promise.resolve()).then(run, run);
    this.askChain = p.catch(() => {});
    return p;
  }

  recap() {
    const out = [];
    let cur = null;
    for (const e of this.conv.events || []) {
      if (e.type === 'user') { cur = { task: e.text, result: '' }; out.push(cur); }
      else if (cur && (e.type === 'final' || e.type === 'error')) cur.result = e.text;
    }
    const files = (this.conv.files || []).map(f => f.name);
    return out.slice(-8).map(x => `- Task: ${x.task.slice(0, 300)}\n  Result: ${(x.result || '(no result)').slice(0, 700)}`).join('\n')
      + (files.length ? `\nFiles created so far: ${files.join(', ')}` : '');
  }

  async runTask(text, files = []) {
    await ready;
    if (!settings.apiKey) { this.post({ type: 'needKey' }); return; }
    this.running = true;
    this.startedAt = Date.now();
    updateKeepAlive();
    this.dismiss();
    if (!this.conv) {
      this.conv = newConversation(text);
      this.pushFull();
      if (this.boundTabId != null) chrome.storage.session.set({ ['tabConv:' + this.boundTabId]: this.conv.id }).catch(() => {});
    }
    const hadHistory = this.conv.events.some(ev => ev.type === 'user');
    const recap = hadHistory ? this.recap() : '';
    this.conv.status = 'running';
    const { task: expanded, used } = expandSkills(text, await loadSkills());
    const task = files.length ? `${expanded}\n\nThe user attached ${files.length === 1 ? 'a file' : `${files.length} files`} to this message:\n\n${attachBlock(files)}` : expanded;
    this.emit({ type: 'user', text, ...(used.length ? { skills: used } : {}), ...this.attachMeta(files) });
    this.storeAttachments(files);
    this.taskUsage = null;
    if (!this.agent) {
      this.agent = new Agent({ settings, ui: this.bridge() });
      this.agent.sid = this.id;
      this.agent.boundTabId = this.boundTabId;
      this.agent.preferNewTab = this.boundTabId == null;
      this.agent.io = { buildDataUrl, readPdf, parallel: req => this.runSubtasks(req) };
      if (recap) this.agent.seed(recap);
      this.agent.sessionFiles = (this.conv.files || []).filter(f => f.dataUrl || f.content != null).map(f => ({ ...f }));
    }
    this.agent.settings = settings;
    this.agent.visionOn = settings.vision;
    this.setLight('running');

    let outcome = 'error';
    this.stopRequested = false;
    this.workers.add(this.agent);
    try { outcome = await this.agent.run(task); } catch (e) { this.emit({ type: 'error', text: e.message || String(e) }); }
    finally { this.workers.delete(this.agent); }
    this.running = false;
    this.pending = null;
    this.status = null;
    updateKeepAlive();
    this.conv.status = outcome;
    await this.persist(true);

    const finalEv = [...this.conv.events].reverse().find(ev => ev.type === 'final');
    if (outcome === 'done') {
      this.setLight('done');
      if (this.queue.length && !this.queuePaused) { playShort('done'); setTimeout(() => this.next(), 800); }
      else this.alertUser('done', `Done — ${(finalEv?.text || text).replace(/\s+/g, ' ').slice(0, 110)}`);
    } else if (outcome === 'stopped') {
      this.setLight('error', 'Stopped');
      if (this.queue.length) this.queuePaused = true;
    } else {
      this.setLight('error', 'Error');
      this.alertUser('error', 'The task stopped because of a problem');
      if (this.queue.length) this.queuePaused = true;
    }
    this.pushState();
  }

  next() {
    if (this.running || !this.queue.length || this.queuePaused) return;
    const t = this.queue.shift();
    const files = this.queueFiles.shift() || [];
    this.pushState();
    this.routeText(t, files);
  }

  send(text, mode = '', rawFiles = []) {
    text = String(text || '').trim();
    const files = cleanAttachments(rawFiles);
    if (!text && files.length) text = files.length === 1 ? `Use the attached file ${files[0].name}.` : 'Use the attached files.';
    if (!text) return;
    if (this.pending?.type === 'ask') {
      const p = this.pending;
      this.pending = null;
      this.emit({ type: 'answer', text, ...this.attachMeta(files) });
      this.storeAttachments(files);
      this.dismiss();
      this.setLight('running');
      p.resolve(files.length ? `${text}\n\n${attachBlock(files, 30000)}` : text);
      return;
    }
    if (this.running) {
      if (mode === 'steer') return this.steer(text, files);
      this.queue.push(text); this.queueFiles.push(files); this.pushState(); return;
    }
    if (mode !== 'chat' && this.pausedRun()) return this.updateAndResume(text, files);
    this.routeText(text, files);
  }

  // Keep attached files in the chat (History, upload_file) and give them to the running agent(s).
  storeAttachments(files) {
    if (!files?.length || !this.conv) return;
    for (const f of files) {
      const rec = { id: f.id, name: f.name, mime: f.mime, attached: true, ...(f.dataUrl ? { dataUrl: f.dataUrl } : { content: f.text ?? '' }) };
      this.conv.files.push(rec);
      for (const ag of new Set([this.agent, ...this.workers])) if (ag) ag.sessionFiles = [...(ag.sessionFiles || []).filter(x => x.name !== rec.name), { ...rec }];
    }
    this.scheduleSave();
  }
  attachMeta(files) { return files?.length ? { files: files.map(f => ({ name: f.name, size: f.size })) } : {}; }

  // An agent run that stopped before finishing (paused, stuck, or cut off by a browser restart).
  pausedRun() {
    const r = this.conv?.agentRun;
    return r && ['paused', 'failed', 'running'].includes(r.status) ? r : null;
  }
  addUpdate(run, text) {
    run.updates = [...(run.updates || []), { text: text.slice(0, 16000), t: Date.now() }];
    return run.updates.length;
  }

  // "Tell it now": deliver a note to everything running in this session, and keep it for later stages/items.
  steer(text, files = []) {
    this.storeAttachments(files);
    const full = files.length ? `${text}\n\n${attachBlock(files, 15000)}` : text;
    const run = this.conv?.agentRun;
    const n = run && run.status === 'running' ? this.addUpdate(run, full) : null;
    const live = [...this.workers];
    for (const ag of live) ag.inject(full);
    if (this.split) this.split.updates.push(full); // helpers that start later get it too
    this.emit({ type: 'update', text, n, mode: 'steer', live: live.length, ...this.attachMeta(files) });
    this.scheduleSave();
    this.pushState();
  }

  // Message sent to a paused agent: becomes an update to the plan, then the run resumes.
  updateAndResume(text, files = []) {
    const run = this.pausedRun();
    this.storeAttachments(files);
    const n = this.addUpdate(run, files.length ? `${text}\n\n${attachBlock(files, 15000)}` : text);
    this.emit({ type: 'update', text, n, mode: 'resume', ...this.attachMeta(files) });
    return this.runAgent(null, null, null, '', true);
  }

  async routeText(text, files = []) {
    const m = text.match(/^\/([a-z0-9\u0980-\u09ff-]+)(?:\s+([\s\S]*))?$/i);
    if (m) {
      const agent = (await loadAgents()).find(a => a.name === m[1].toLowerCase());
      if (agent) { const { inputs, extra } = parseInputs(m[2] || '', agent); return this.runAgent(agent.id, inputs, extra, text, false, files); }
    }
    return this.runTask(text, files);
  }

  // ---------- Agents: multi-stage runs ----------
  stageTask(run, st, itemIdx, lastErr) {
    const def = run.def;
    const fill = t => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (k in run.inputs ? run.inputs[k] : m));
    const parts = [];
    parts.push(`You are running the saved agent "${def.title || def.name}". Stage ${run.stage + 1} of ${def.stages.length}: "${st.title}"${itemIdx != null ? ` — item ${itemIdx + 1} of ${run.items.length}` : ''}.`);
    if (def.description) parts.push(`AGENT GOAL: ${fill(def.description)}`);
    if (def.rules) parts.push(`RULES (always follow):\n${fill(def.rules)}`);
    const inp = Object.entries(run.inputs || {});
    if (inp.length) parts.push(`INPUTS: ${inp.map(([k, v]) => `${k} = ${v}`).join('; ')}`);
    if (run.extra) parts.push(`EXTRA INSTRUCTIONS FROM THE USER: ${run.extra}`);
    if (run.updates?.length) {
      parts.push(`UPDATES FROM THE USER DURING THIS RUN — they change the plan and override the stage instructions where they conflict (newest last):\n${run.updates.map((u, i) => `${i + 1}. ${u.text}`).join('\n')}\nApply them to this stage. Items finished before an update are not redone unless an update says so. If this stage writes a final summary, say briefly how the updates were applied.`);
    }
    parts.push(`ALL STAGES: ${def.stages.map((x, i) => `${i + 1}. ${x.title}${i === run.stage ? ' ← YOU ARE HERE' : ''}`).join(' | ')}`);
    parts.push(`THIS STAGE — do ONLY this now:\n${fill(st.instructions)}`);
    if (st.doneWhen) parts.push(`DONE WHEN: ${fill(st.doneWhen)}`);
    if (itemIdx != null) parts.push(`CURRENT ITEM:\n${JSON.stringify(run.items[itemIdx]).slice(0, 3000)}`);
    else if (run.items.length) parts.push(`ITEMS SAVED BY EARLIER STAGES (${run.items.length}):\n${JSON.stringify(run.items).slice(0, 6000)}`);
    if (run.results.length) {
      const res = JSON.stringify(run.results.map(r => ({ stage: r.stage, item: r.item, ...((r.data && typeof r.data === 'object') ? r.data : { value: r.data }) })));
      parts.push(`RESULTS RECORDED SO FAR (${run.results.length}):\n${itemIdx != null ? res.slice(-2500) : res.slice(0, 20000)}`);
    }
    const files = (this.conv.files || []).map(f => f.name);
    if (files.length) parts.push(`FILES CREATED SO FAR: ${files.join(', ')}`);
    if (lastErr) parts.push(`PREVIOUS ATTEMPT OF THIS STAGE FAILED: ${lastErr}. Try a different approach.`);
    parts.push('Tools for agent runs: save_items(items) passes a list to later stages; record_result(data) stores this stage/item\'s result. When THIS stage (for this item) is complete, call done with a one-line summary. Do not start later stages.');
    return parts.join('\n\n');
  }

  async runAgent(agentId, inputs = {}, extra = '', displayText = '', resume = false, files = []) {
    await ready;
    if (!settings.apiKey) { this.post({ type: 'needKey' }); return; }
    let run;
    if (resume) {
      run = this.conv?.agentRun;
      if (!run || run.status === 'done') return;
    } else {
      const def = (await loadAgents()).find(a => a.id === agentId || a.name === agentId);
      if (!def) { this.post({ type: 'notice', text: 'Agent not found.' }); return; }
      if (!this.conv || this.conv.agentRun) {
        this.conv = newConversation(`${def.title || def.name}`);
        this.agent = null;
        this.pushFull();
        if (this.boundTabId != null) chrome.storage.session.set({ ['tabConv:' + this.boundTabId]: this.conv.id }).catch(() => {});
      }
      if (files.length) extra = `${extra || ''}\n\nATTACHED BY THE USER:\n${attachBlock(files, 20000)}`.trim();
      run = { def: JSON.parse(JSON.stringify(def)), inputs, extra, stage: 0, item: 0, items: [], results: [], notes: '', status: 'running', startedAt: Date.now(), costAtStart: this.conv.usage?.cost || 0 };
      this.conv.agentRun = run;
      this.conv.title = `${def.title || def.name}${inputs && Object.keys(inputs).length ? ' · ' + Object.values(inputs).join(', ') : ''}`.slice(0, 120);
      this.emit({ type: 'user', text: displayText || `/${def.name} ${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(' ')} ${String(extra || '').split('ATTACHED BY THE USER:')[0]}`.trim(), agent: def.title || def.name, ...this.attachMeta(files) });
      this.storeAttachments(files);
      this.emit({ type: 'agentStart', name: def.title || def.name, inputs, stages: def.stages.map(s => s.title) });
    }
    const def = run.def;
    this.running = true;
    this.startedAt = Date.now();
    this.stopRequested = false;
    updateKeepAlive();
    this.dismiss();
    run.status = 'running';
    this.conv.status = 'running';
    this.taskUsage = null;
    if (resume) {
      run.failedItems = []; // give items that failed last time another chance
      const st0 = def.stages[run.stage];
      const doneN = Array.isArray(run.doneItems) ? run.doneItems.length : (run.item || 0);
      this.emit({ type: 'memory', text: `Resuming at stage ${run.stage + 1}${st0?.forEach ? ` (${doneN} of ${run.items.length} items already done)` : ''}` });
    }
    this.setLight('running');
    let tabId = this.agent?.tabId ?? null;

    while (run.stage < def.stages.length) {
      const st = def.stages[run.stage];
      if (st.forEach && !run.items.length) {
        this.emit({ type: 'memory', text: `Stage "${st.title}" skipped: no items were saved by earlier stages.` });
        this.nextStage(run); continue;
      }
      if (this.overBudget(run)) return this.endAgent(run, 'paused', this.budgetMsg(run), true);

      if (st.forEach) {
        const r = await this.runItems(run, st, tabId);
        tabId = r.tabId;
        if (r.halted === 'stopped') return this.endAgent(run, 'paused', 'Paused — finished items are kept. Press Resume, or send a message to change the plan and continue.', false);
        if (r.halted === 'budget') return this.endAgent(run, 'paused', this.budgetMsg(run), true);
        if (r.halted === 'failed') return this.endAgent(run, 'failed', `Items in "${st.title}" keep failing (${run.failedItems.length} failed, ${run.doneItems.length} done). Fix the problem (e.g. log in) and press Resume.`, true);
        if (run.failedItems.length) {
          const names = run.failedItems.map(i => this.itemLabel(run, i)).join(', ');
          this.emit({ type: 'memory', text: `${run.failedItems.length} item${run.failedItems.length === 1 ? '' : 's'} skipped after 3 failed attempts: ${names.slice(0, 300)}` });
        }
        // Parallel workers finish in any order — keep this stage's results in item order.
        const mine = run.results.filter(x => x.stage === st.title && x.item != null).sort((x, y) => x.item - y.item);
        run.results = run.results.filter(x => !(x.stage === st.title && x.item != null)).concat(mine);
        this.nextStage(run);
        await this.persist(false);
        continue;
      }

      this.emit({ type: 'stage', n: run.stage + 1, of: def.stages.length, title: st.title, item: null, items: null, itemName: '' });
      this.pushState();
      const r = await this.attemptStage(run, st, null, tabId, null);
      tabId = r.tabId;
      if (r.outcome === 'stopped') return this.endAgent(run, 'paused', 'Paused. Press Resume, or send a message to change the plan and continue.', false);
      if (r.outcome !== 'done') return this.endAgent(run, 'failed', `Stage "${st.title}" failed 3 times. Fix the problem (e.g. log in) and press Resume.`, true);
      this.nextStage(run);
      await this.persist(false);
    }
    return this.endAgent(run, 'done', null, true);
  }

  nextStage(run) { run.stage++; run.item = 0; run.doneItems = []; run.failedItems = []; }
  overBudget(run) {
    const spent = (this.conv.usage?.cost || 0) - (run.costAtStart || 0);
    return !!run.def.maxCost && spent >= run.def.maxCost;
  }
  budgetMsg(run) {
    const spent = (this.conv.usage?.cost || 0) - (run.costAtStart || 0);
    return `Budget reached ($${spent.toFixed(3)} of $${run.def.maxCost}). Raise the agent's max cost or press Resume to continue anyway.`;
  }
  itemLabel(run, i) { return labelOf(run.items[i], i); }

  // One stage (or one item of a for-each stage) with up to 3 attempts. Returns { outcome, tabId }.
  async attemptStage(run, st, itemIdx, tabId, lane) {
    const def = run.def;
    const worker = lane && lane.n > 1; // extra parallel worker: own tab, own tab-ownership id
    let outcome = 'error', lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.stopRequested) { outcome = 'stopped'; break; }
      const ag = new Agent({ settings, ui: this.bridge(lane) });
      ag.sid = worker ? `${this.id}:w${lane.n}` : this.id;
      ag.boundTabId = worker ? null : this.boundTabId;
      ag.tabId = tabId;
      ag.preferNewTab = worker || this.boundTabId == null;
      ag.io = { buildDataUrl, readPdf, ...(itemIdx == null ? { parallel: req => this.runSubtasks(req) } : {}) };
      ag.notes = run.notes;
      ag.maxStepsOverride = def.maxStepsPerStage;
      ag.skipVerify = itemIdx != null; // per-item work is checked by the stage that uses the results
      ag.sessionFiles = (this.conv.files || []).filter(f => f.dataUrl || f.content != null).map(f => ({ ...f }));
      ag.runCtx = {
        saveItems: items => {
          if (itemIdx != null) return { error: 'save_items is not available inside a "for each item" stage. Use record_result for this item instead.' };
          run.items = items; run.item = 0; run.doneItems = []; run.failedItems = [];
          this.emit({ type: 'memory', text: `Saved ${items.length} item${items.length === 1 ? '' : 's'} for the next stages` });
          return null;
        },
        recordResult: data => {
          // An item that is re-run (retry, or resumed after a pause) replaces its earlier result.
          if (itemIdx != null) run.results = run.results.filter(r => !(r.stage === st.title && r.item === itemIdx + 1));
          run.results.push({ stage: st.title, item: itemIdx != null ? itemIdx + 1 : null, data });
          this.scheduleSave();
        },
      };
      ag.settings = settings;
      ag.visionOn = settings.vision;
      if (!worker) this.agent = ag;
      this.workers.add(ag);
      if (lane) lane.lastError = '';
      try { outcome = await ag.run(this.stageTask(run, st, itemIdx, lastErr)); } catch (e) { outcome = 'error'; if (lane) lane.lastError = e.message; }
      finally { this.workers.delete(ag); }
      tabId = ag.tabId;
      if (!lane?.parallel) run.notes = ag.notes; // parallel workers don't overwrite the shared notes
      if (outcome !== 'error' || this.stopRequested) break;
      lastErr = lane?.lastError || [...this.conv.events].reverse().find(ev => ev.type === 'error')?.text?.slice(0, 300) || 'unknown error';
      if (attempt < 3) this.emit({ type: 'memory', text: `${itemIdx != null ? `"${this.itemLabel(run, itemIdx)}"` : 'Stage'} failed — retrying (attempt ${attempt + 1} of 3)`, ...(lane?.parallel ? { w: lane.n } : {}) });
    }
    if (this.stopRequested && outcome === 'error') outcome = 'stopped';
    return { outcome, tabId };
  }

  // run_in_parallel: the model split a job into independent items. Each item gets a helper Agent in its
  // own background tab; helpers pull items from a shared queue. Returns every result to the calling agent.
  async runSubtasks({ instructions, items, maxTabs, task }) {
    if (this.split) return { error: 'Already running items in parallel — wait for that to finish.' };
    const max = clampParallel(settings.maxParallel);
    let n = Math.min(clampParallel(maxTabs ?? max), max, items.length);
    const hit = SENSITIVE.find(([re]) => re.test(instructions.toLowerCase()));
    if (hit && n > hit[1]) n = hit[1];
    if (n < 2) return { error: `Parallel tabs are not used for this${hit ? ` (${hit[2]})` : ''}. Do the items yourself, one at a time.` };

    const split = { title: instructions.replace(/\s+/g, ' ').slice(0, 90), total: items.length, done: 0, failed: [], results: new Array(items.length), lanes: [], updates: [] };
    const queue = items.map((_, i) => i);
    const created = [];
    this.emit({ type: 'memory', text: `Splitting ${items.length} items across ${n} parallel tabs${hit ? ` (limited: ${hit[2]})` : ''}` });

    const work = async lane => {
      let wTab = null;
      if (lane.n > 1) await sleep((lane.n - 1) * 350);
      while (queue.length && !this.stopRequested) {
        const run = this.conv?.agentRun;
        if (run?.status === 'running' && this.overBudget(run)) break;
        const idx = queue.shift();
        lane.item = idx; lane.itemName = labelOf(items[idx], idx); lane.status = 'starting…';
        this.pushState();
        if (wTab == null) {
          try { const t = await B.createAgentTab('about:blank', undefined, `${this.id}:p${lane.n}`); wTab = t.id; created.push(t.id); } catch (_) { /* helper opens one */ }
        }
        let ok = false, result, lastErr = '';
        for (let attempt = 1; attempt <= 3 && !this.stopRequested; attempt++) {
          const ag = new Agent({ settings, ui: this.bridge(lane) });
          ag.sid = `${this.id}:p${lane.n}`;
          ag.boundTabId = null;
          ag.tabId = wTab;
          ag.preferNewTab = true;
          ag.io = { buildDataUrl, readPdf };
          ag.isHelper = true; // no planner / completion check per helper item (the main agent reviews the whole job)
          ag.visionOn = settings.vision;
          ag.maxStepsOverride = Math.min(settings.maxSteps || 100, 60);
          let recorded;
          ag.runCtx = {
            saveItems: () => ({ error: 'Not available for a helper. Use record_result for this item.' }),
            recordResult: data => { recorded = data; },
          };
          lane.lastFinal = ''; lane.lastError = '';
          this.workers.add(ag);
          let out = 'error';
          try { out = await ag.run(this.subtaskPrompt({ instructions, items, idx, task, n: lane.n, updates: split.updates, lastErr })); }
          catch (e) { lane.lastError = e.message; }
          finally { this.workers.delete(ag); }
          wTab = ag.tabId;
          if (out === 'done') { ok = true; result = recorded ?? parseLoose(lane.lastFinal); break; }
          if (out === 'stopped' || this.stopRequested) break;
          lastErr = lane.lastError || 'unknown error';
          if (attempt < 3) this.emit({ type: 'memory', text: `"${lane.itemName}" failed — retrying (attempt ${attempt + 1} of 3)`, w: lane.n });
        }
        if (ok) { split.results[idx] = result; split.done++; }
        else if (!this.stopRequested) {
          split.failed.push({ item: idx + 1, name: lane.itemName, error: lastErr.slice(0, 200) });
          this.emit({ type: 'error', text: `"${lane.itemName}" failed 3 times — skipped. ${lastErr}`.trim(), w: lane.n });
        } else queue.unshift(idx);
        lane.item = null; lane.itemName = ''; lane.status = null;
        this.pushState();
      }
    };

    split.lanes = Array.from({ length: n }, (_, i) => ({ n: i + 1, parallel: true, helper: true, item: null, itemName: '', status: null }));
    this.split = split;
    this.pushState();
    try { await Promise.all(split.lanes.map(work)); }
    finally {
      for (const id of created) chrome.tabs.remove(id).catch(() => {});
      for (let i = 1; i <= n; i++) B.releaseAll(`${this.id}:p${i}`);
      this.split = null;
      this.pushState();
    }
    const stopped = this.stopRequested;
    const notDone = queue.length;
    this.emit({ type: 'memory', text: `Parallel tabs finished: ${split.done} of ${items.length} done${split.failed.length ? `, ${split.failed.length} failed` : ''}${stopped ? ' (stopped)' : notDone ? ` (${notDone} not started — budget reached)` : ''}` });
    // Keep the answer inside the tool-result limit: shrink long per-item results evenly.
    const res = items.map((it, i) => (split.results[i] !== undefined ? { item: i + 1, name: labelOf(it, i), result: split.results[i] } : null)).filter(Boolean);
    let out = { done: split.done, total: items.length, results: res, failed: split.failed, ...(notDone ? { not_started: queue.map(i => i + 1) } : {}), ...(stopped ? { stopped: true } : {}) };
    if (JSON.stringify(out).length > 14000) {
      const per = Math.max(120, Math.floor(12000 / Math.max(1, res.length)));
      out = { ...out, results: res.map(r => ({ item: r.item, name: r.name, result: (() => { const t = typeof r.result === 'string' ? r.result : JSON.stringify(r.result); return t.length > per ? t.slice(0, per) + '…' : r.result; })() })) };
    }
    return out;
  }

  subtaskPrompt({ instructions, items, idx, task, n, updates, lastErr }) {
    const parts = [
      `You are parallel helper tab ${n}. The main DeepPilot agent split a job into independent items; you handle exactly ONE item in your own background tab.`,
      `MAIN TASK (context only — do NOT do the whole task): ${String(task).slice(0, 1500)}`,
      `WHAT TO DO FOR THIS ITEM:\n${instructions}`,
      `ITEM ${idx + 1} of ${items.length}:\n${(typeof items[idx] === 'string' ? items[idx] : JSON.stringify(items[idx])).slice(0, 3000)}`,
    ];
    if (updates.length) parts.push(`UPDATES FROM THE USER (they override the instructions where they conflict):\n${updates.map((u, i) => `${i + 1}. ${u}`).join('\n')}`);
    if (lastErr) parts.push(`YOUR PREVIOUS ATTEMPT FAILED: ${lastErr}. Try a different approach.`);
    parts.push('When finished, call record_result with this item\'s result as an object with the requested fields, then call done with a one-line summary. If the item cannot be completed (site down, no data), still record_result with what you found plus an "error" field. Do not create files, send messages, or ask the user unless a login or CAPTCHA blocks you.');
    return parts.join('\n\n');
  }

  // How many tabs a for-each stage may use. Logged-in social / map sites get a low cap because
  // they flag accounts that act from many tabs at once.
  concurrencyFor(run, st) {
    const want = st.sequential ? 1 : clampParallel(run.def.parallel);
    const text = `${st.instructions} ${st.title}`.toLowerCase();
    const hit = SENSITIVE.find(([re]) => re.test(text));
    if (hit && want > hit[1]) return { n: hit[1], why: hit[2] };
    return { n: want, why: '' };
  }

  // Run a for-each stage with a pool of workers. Each worker is its own Agent in its own background
  // tab; workers pull the next unfinished item until the list is empty. Returns { halted, tabId }.
  async runItems(run, st, tabId) {
    if (!Array.isArray(run.doneItems)) run.doneItems = Array.from({ length: Math.min(run.item || 0, run.items.length) }, (_, i) => i);
    if (!Array.isArray(run.failedItems)) run.failedItems = [];
    const queue = run.items.map((_, i) => i).filter(i => !run.doneItems.includes(i) && !run.failedItems.includes(i));
    const { n: cap, why } = this.concurrencyFor(run, st);
    const n = Math.max(1, Math.min(cap, queue.length));
    const parallel = n > 1;
    if (parallel) this.emit({ type: 'memory', text: `Running ${queue.length} items with ${n} parallel tabs${why ? ` (limited to ${n}: ${why})` : ''}` });
    else if (why && queue.length > 1) this.emit({ type: 'memory', text: `Running items one at a time: ${why}` });
    let halted = null, fails = 0, wins = 0;
    const createdTabs = [];
    let mainTab = tabId;
    this.lanes = [];

    const work = async lane => {
      let wTab = lane.n === 1 ? tabId : null;
      if (lane.n > 1) await sleep((lane.n - 1) * 350); // stagger start-up so the API isn't hit all at once
      while (queue.length && !halted && !this.stopRequested) {
        if (this.overBudget(run)) { halted = 'budget'; break; }
        const idx = queue.shift();
        lane.item = idx;
        lane.itemName = this.itemLabel(run, idx);
        lane.status = 'starting…';
        this.emit({ type: 'stage', n: run.stage + 1, of: run.def.stages.length, title: st.title, item: idx + 1, items: run.items.length, itemName: lane.itemName, ...(parallel ? { w: lane.n } : {}) });
        this.pushState();
        if (wTab == null) {
          try {
            const t = await B.createAgentTab('about:blank', undefined, `${this.id}:w${lane.n}`);
            wTab = t.id; createdTabs.push(t.id);
          } catch (_) { /* the agent will open one itself */ }
        }
        const r = await this.attemptStage(run, st, idx, wTab, lane);
        wTab = r.tabId;
        if (lane.n === 1) mainTab = wTab;
        if (r.outcome === 'done') { run.doneItems.push(idx); wins++; }
        else if (r.outcome === 'stopped' || this.stopRequested) { queue.unshift(idx); halted = halted || 'stopped'; }
        else {
          run.failedItems.push(idx); fails++;
          this.emit({ type: 'error', text: `"${lane.itemName}" failed 3 times — skipped. ${lane.lastError || ''}`.trim(), ...(parallel ? { w: lane.n } : {}) });
          if (fails >= 3 && fails > wins) halted = halted || 'failed';
        }
        lane.item = null; lane.itemName = ''; lane.status = null;
        this.scheduleSave();
        this.pushState();
      }
      lane.status = null;
    };

    try {
      const lanes = Array.from({ length: n }, (_, i) => ({ n: i + 1, parallel, item: null, itemName: '', status: null, tabId: null }));
      this.lanes = lanes;
      await Promise.all(lanes.map(work));
    } finally {
      this.lanes = null;
      // Close the extra worker tabs and free them.
      for (const id of createdTabs) chrome.tabs.remove(id).catch(() => {});
      for (let i = 2; i <= n; i++) B.releaseAll(`${this.id}:w${i}`);
    }
    if (this.stopRequested && !halted) halted = 'stopped';
    return { halted, tabId: mainTab };
  }

  async endAgent(run, status, message, alarm) {
    run.status = status;
    this.running = false;
    this.pending = null;
    this.status = null;
    updateKeepAlive();
    if (message) this.emit({ type: status === 'failed' ? 'error' : 'memory', text: message });
    this.conv.status = status === 'done' ? 'done' : status === 'paused' ? 'stopped' : 'error';
    await this.persist(true);
    const name = run.def.title || run.def.name;
    if (status === 'done') {
      this.setLight('done');
      if (this.queue.length && !this.queuePaused) { playShort('done'); setTimeout(() => this.next(), 800); }
      else this.alertUser('done', `Agent "${name}" finished all ${run.def.stages.length} stages`);
    } else {
      this.setLight('error', status === 'paused' ? 'Paused' : 'Needs help');
      if (alarm) this.alertUser('error', status === 'paused' ? `Agent "${name}" paused — ${message}` : `Agent "${name}" is stuck — ${message}`);
      if (this.queue.length) this.queuePaused = true;
    }
    this.pushState();
  }

  stop() {
    this.stopRequested = true;
    this.agent?.stop();
    for (const ag of this.workers) ag.stop();
  }

  newChat() {
    if (this.running) return;
    B.releaseAll(this.id);
    this.conv = null;
    this.agent = null;
    this.taskUsage = null;
    this.queue = [];
    this.queueFiles = [];
    this.queuePaused = false;
    this.workTab = null;
    this.alert = null;
    stopSound();
    if (this.boundTabId != null) chrome.storage.session.remove('tabConv:' + this.boundTabId).catch(() => {});
    this.setLight('idle');
    this.pushFull();
  }

  async openConv(id) {
    if (this.running) { this.post({ type: 'notice', text: 'busy' }); return; }
    let c = await getConversation(id).catch(() => null);
    if (!c && cloud.isConfigured()) c = await cloud.getCloud(id).catch(() => null);
    if (!c) { this.post({ type: 'notice', text: 'Conversation not found.' }); return; }
    this.conv = c;
    this.agent = null;
    this.taskUsage = null;
    if (this.boundTabId != null) chrome.storage.session.set({ ['tabConv:' + this.boundTabId]: c.id }).catch(() => {});
    this.setLight('idle');
    this.pushFull();
  }

  async deleteConv(id) {
    if (this.running && this.conv?.id === id) { this.post({ type: 'notice', text: 'Stop the task before deleting this chat.' }); return; }
    await deleteConversation(id).catch(() => {});
    if (cloud.isConfigured() && await cloud.getSession().catch(() => null)) await cloud.deleteCloud(id).catch(e => console.warn(e));
    for (const s of sessions.values()) if (s.conv?.id === id && !s.running) s.newChat();
    broadcast({ type: 'historyChanged' });
  }

  async viewTab() {
    const id = this.workTab?.id ?? this.boundTabId;
    if (id == null) return;
    try { const t = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); } catch (_) { /* closed */ }
  }
}

function broadcast(msg) { for (const s of sessions.values()) s.post(msg); }

async function getSession(key, { tabId = null, mode = 'panel' } = {}) {
  let s = sessions.get(key);
  if (s) return s;
  s = new Session(key, { tabId, mode });
  sessions.set(key, s);
  // Restore the chat this tab had before the service worker restarted.
  if (tabId != null) {
    const k = 'tabConv:' + tabId;
    const { [k]: convId } = await chrome.storage.session.get(k).catch(() => ({}));
    if (convId) {
      const c = await getConversation(convId).catch(() => null);
      if (c) { if (c.status === 'running') c.status = 'error'; s.conv = c; }
    }
  }
  return s;
}

// ---------- ports from the views ----------
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'dp-ui') return;
  let session = null;
  port.onMessage.addListener(async msg => {
    await ready;
    if (msg.cmd === 'attach') {
      if (session) session.ports.delete(port);
      session = await getSession(msg.key, { tabId: msg.tabId ?? null, mode: msg.mode || 'panel' });
      session.ports.add(port);
      port.postMessage({ type: 'full', conv: session.conv, state: session.state() });
      return;
    }
    if (!session) return;
    switch (msg.cmd) {
      case 'send': session.send(msg.text, msg.mode || '', msg.files || []); break;
      case 'confirm': if (session.pending?.type === 'confirm') session.pending.resolve(msg.choice); break;
      case 'stop': session.stop(); break;
      case 'queueRemove': session.queue.splice(msg.index, 1); session.queueFiles.splice(msg.index, 1); session.pushState(); break;
      case 'queueClear': session.queue = []; session.queueFiles = []; session.queuePaused = false; session.pushState(); break;
      case 'queueResume': session.queuePaused = false; session.pushState(); session.next(); break;
      case 'newChat': session.newChat(); break;
      case 'runAgent': if (!session.running) session.runAgent(msg.agentId, msg.inputs || {}, msg.extra || ''); break;
      case 'resumeAgent': if (!session.running) session.runAgent(null, null, null, '', true); break;
      case 'openConv': session.openConv(msg.id); break;
      case 'deleteConv': session.deleteConv(msg.id); break;
      case 'dismiss': session.dismiss(); break;
      case 'viewTab': session.viewTab(); break;
      case 'refresh': port.postMessage({ type: 'full', conv: session.conv, state: session.state() }); break;
      default: break;
    }
  });
  port.onDisconnect.addListener(() => { if (session) session.ports.delete(port); });
});

// ---------- scheduled runs ----------
async function runScheduled(sched) {
  await ready;
  if (!settings.apiKey) return;
  const key = `sched:${sched.id}:${Date.now()}`;
  const s = await getSession(key, { mode: 'app' });
  s.scheduleName = sched.name;
  await markRun(sched.id, null);
  const done = s.routeText(sched.text);
  // remember which chat this run produced, so the Schedules list can open it
  setTimeout(async () => { if (s.conv) { s.conv.title = `⏰ ${sched.name}`.slice(0, 120); await s.persist(true); await markRun(sched.id, s.conv.id); } }, 3000);
  await done;
}
chrome.alarms.onAlarm.addListener(a => {
  const id = alarmId(a.name);
  if (!id) return;
  loadSchedules().then(list => { const sc = list.find(x => x.id === id && x.enabled); if (sc) runScheduled(sc); });
});
ready.then(() => rearmAll(sc => runScheduled(sc)).catch(e => console.warn('schedules', e)));
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.schedules) (ch.schedules.newValue || []).forEach(sc => arm(sc).catch(() => {})); });

// ---------- tabs & notifications ----------
chrome.tabs.onRemoved.addListener(tabId => {
  for (const [key, s] of sessions) {
    if (s.boundTabId === tabId) {
      s.stop();
      chrome.storage.session.remove('tabConv:' + tabId).catch(() => {});
      setTimeout(() => { if (!s.running) sessions.delete(key); }, 3000);
    }
  }
});

chrome.notifications.onClicked.addListener(id => {
  if (!id.startsWith('dp:')) return;
  const s = sessions.get(id.slice(3));
  if (!s) return;
  const tabId = s.boundTabId ?? s.workTab?.id;
  if (tabId != null) {
    chrome.sidePanel.open({ tabId }).catch(() => {});
    chrome.tabs.update(tabId, { active: true }).then(t => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
  }
  s.dismiss();
});
