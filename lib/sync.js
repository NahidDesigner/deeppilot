// Chrome Sync: memories, skills, agents and settings follow the user's Google account to every
// computer where Chrome is signed in (Settings → Sync → Extensions must be on). Nothing goes to any
// DeepPilot server — Chrome stores it in the user's own Google account.
//
// Layout in chrome.storage.sync (≈100 KB total, 8 KB per item, ~120 writes/min):
//   dp1|m|<uid>   a memory      dp1|s|<name>  a skill      dp1|a|<name>  an agent
//   dp1|c|settings               non-secret settings (+ API keys only if "sync keys" is on)
//   dp1|x|<rec>   tombstone = time it was deleted, so deletions spread too
// Each record is {u: updatedAt, d: data} or, when too big for one item, {u, n} + pieces "<key>~0…n-1".
// Merge rule: newest change wins, per record.
import { DEFAULTS } from './settings.js';

const P = 'dp1|';
const PIECE = 6500;                   // bytes per chunk (the item limit is 8192 incl. the key)
const TOMBSTONE_DAYS = 60;
const SECRETS = ['apiKey', 'whisperKey', 'supabaseKey'];
const LOCAL_ONLY = ['chromeSync'];    // turning sync off on one computer doesn't turn it off everywhere
const STATE = 'syncState', STATUS = 'syncStatus';
const enc = new TextEncoder();

const hash = str => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + str.length; };
const bytes = s => enc.encode(s).length;

async function getState() {
  const { [STATE]: s } = await chrome.storage.local.get(STATE);
  return s && s.h ? s : { h: {}, u: {} };
}
const putState = s => chrome.storage.local.set({ [STATE]: s });
async function setStatus(st) { await chrome.storage.local.set({ [STATUS]: { ...st, at: Date.now() } }); }

async function readLocal() {
  const keys = ['memories', 'skills', 'agents', ...Object.keys(DEFAULTS)];
  const all = await chrome.storage.local.get(keys);
  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) cfg[k] = k in all ? all[k] : DEFAULTS[k];
  let memories = Array.isArray(all.memories) ? all.memories : [];
  // Older memories had no stable id across computers — give them one.
  if (memories.some(m => !m.uid)) {
    memories = memories.map(m => (m.uid ? m : { ...m, uid: crypto.randomUUID() }));
    await chrome.storage.local.set({ memories });
  }
  return { memories, skills: Array.isArray(all.skills) ? all.skills : [], agents: Array.isArray(all.agents) ? all.agents : [], cfg };
}

function settingsRecord(cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (LOCAL_ONLY.includes(k)) continue;
    if (SECRETS.includes(k) && !cfg.syncKeys) continue;
    out[k] = cfg[k];
  }
  return out;
}

function buildRecords(local) {
  const r = new Map();
  for (const m of local.memories) r.set(`m|${m.uid}`, { uid: m.uid, text: m.text, created: m.created, updated: m.updated || null });
  for (const s of local.skills) if (s?.name) r.set(`s|${s.name}`, s);
  for (const a of local.agents) if (a?.name) r.set(`a|${a.name}`, a);
  r.set('c|settings', settingsRecord(local.cfg));
  return r;
}

function encodeRecord(key, data, u) {
  const json = JSON.stringify(data);
  if (bytes(json) + key.length + 40 < 8000) return { [P + key]: { u, d: data } };
  const out = {};
  let n = 0, cur = '';
  for (const ch of json) {                       // split by characters so multi-byte text stays intact
    if (bytes(cur) + 4 > PIECE) { out[`${P}${key}~${n++}`] = cur; cur = ''; }
    cur += ch;
  }
  if (cur) out[`${P}${key}~${n++}`] = cur;
  out[P + key] = { u, n };
  return out;
}

function decodeAll(all) {
  const recs = new Map(), tomb = new Map();
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(P) || k.includes('~')) continue;
    const key = k.slice(P.length);
    if (key.startsWith('x|')) { tomb.set(key.slice(2), Number(v) || 0); continue; }
    if (!v || typeof v !== 'object') continue;
    if ('d' in v) recs.set(key, { u: v.u || 0, d: v.d });
    else if (v.n) {
      let json = '';
      for (let i = 0; i < v.n; i++) json += all[`${k}~${i}`] ?? '';
      try { recs.set(key, { u: v.u || 0, d: JSON.parse(json) }); } catch (_) { /* half-synced — next change fixes it */ }
    }
  }
  return { recs, tomb };
}

// Keys (head + pieces) currently used by a record in sync storage.
const keysOf = (all, key) => Object.keys(all).filter(k => k === P + key || k.startsWith(`${P}${key}~`));

let busy = Promise.resolve();
const serial = fn => (busy = busy.then(fn, fn));

// Send local changes to Chrome Sync.
export function push() {
  return serial(async () => {
    const local = await readLocal();
    if (!local.cfg.chromeSync) return;
    const state = await getState();
    const all = await chrome.storage.sync.get(null);
    const recs = buildRecords(local);
    const now = Date.now();
    const toSet = {}, toRemove = new Set(), changed = [];
    for (const [key, data] of recs) {
      const h = hash(JSON.stringify(data));
      if (state.h[key] === h) continue;
      const enc = encodeRecord(key, data, now);
      for (const k of keysOf(all, key)) if (!(k in enc)) toRemove.add(k); // leftover pieces
      Object.assign(toSet, enc);
      if (`${P}x|${key}` in all) toRemove.add(`${P}x|${key}`);
      changed.push([key, h]);
    }
    for (const key of Object.keys(state.h)) {
      if (recs.has(key)) continue;
      for (const k of keysOf(all, key)) toRemove.add(k);
      toSet[`${P}x|${key}`] = now;
      changed.push([key, null]);
    }
    for (const [k, v] of Object.entries(all)) {   // forget very old tombstones
      if (k.startsWith(`${P}x|`) && now - Number(v) > TOMBSTONE_DAYS * 864e5) toRemove.add(k);
    }
    if (!changed.length && !toRemove.size) return;
    let error = '';
    try {
      if (toRemove.size) await chrome.storage.sync.remove([...toRemove]);
      if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
      for (const [key, h] of changed) { if (h) { state.h[key] = h; state.u[key] = now; } else { delete state.h[key]; delete state.u[key]; } }
    } catch (e) {
      // Usually the 100 KB quota or the write-rate limit: save record by record, newest first.
      error = /QUOTA_BYTES/i.test(e.message) ? 'Chrome Sync storage is full (about 100 KB). Some items were not synced — delete old agents or long memories.'
        : /MAX_WRITE/i.test(e.message) ? 'Syncing too often — will retry in a minute.' : e.message;
      for (const [key, h] of changed) {
        try {
          if (h) { await chrome.storage.sync.set(encodeRecord(key, recs.get(key), now)); state.h[key] = h; state.u[key] = now; }
          else { await chrome.storage.sync.set({ [`${P}x|${key}`]: now }); delete state.h[key]; delete state.u[key]; }
        } catch (_) { /* stays unsynced; retried on the next change */ }
      }
      if (/MAX_WRITE/i.test(e.message)) setTimeout(() => push(), 65000);
    }
    await putState(state);
    await report(local, error);
  });
}

// Bring changes made on other computers into this one.
export function pull() {
  return serial(async () => {
    const local = await readLocal();
    if (!local.cfg.chromeSync) return;
    const state = await getState();
    const { recs, tomb } = decodeAll(await chrome.storage.sync.get(null));
    const mem = new Map(local.memories.map(m => [`m|${m.uid}`, m]));
    const skills = new Map(local.skills.map(s => [`s|${s.name}`, s]));
    const agents = new Map(local.agents.map(a => [`a|${a.name}`, a]));
    const cfgPatch = {};
    const applied = new Set();
    let changed = false;
    for (const [key, { u, d }] of recs) {
      const h = hash(JSON.stringify(d));
      if (state.h[key] === h || u <= (state.u[key] || 0)) continue;
      const kind = key[0];
      if (kind === 'm') {
        const cur = mem.get(key);
        if (cur) Object.assign(cur, { text: d.text, updated: d.updated });
        else mem.set(key, { id: 0, uid: d.uid, text: d.text, created: d.created, ...(d.updated ? { updated: d.updated } : {}) });
      } else if (kind === 's') skills.set(key, d);
      else if (kind === 'a') agents.set(key, d);
      else if (kind === 'c') {
        for (const [k, v] of Object.entries(d)) {
          if (LOCAL_ONLY.includes(k) || !(k in DEFAULTS)) continue;
          if (SECRETS.includes(k) && (!d.syncKeys || !v)) continue; // keys only when the sender shares them
          cfgPatch[k] = v;
        }
      }
      state.h[key] = h; state.u[key] = u;
      applied.add(key);
      changed = true;
    }
    for (const [key, t] of tomb) {
      if (t <= (state.u[key] || 0)) continue;
      const had = mem.delete(key) | skills.delete(key) | agents.delete(key);
      delete state.h[key]; state.u[key] = t;
      if (had) changed = true;
    }
    if (changed) {
      // Memory ids are local labels (m1, m2…); new ones get the next free number.
      const list = [...mem.values()];
      let next = list.reduce((mx, m) => Math.max(mx, m.id || 0), 0);
      const used = new Set();
      for (const m of list) { if (!m.id || used.has(m.id)) m.id = ++next; used.add(m.id); }
      // Re-hash what we are about to store so the echo of this write isn't pushed back.
      await chrome.storage.local.set({ memories: list, skills: [...skills.values()], agents: [...agents.values()], ...cfgPatch });
      const after = buildRecords(await readLocal());
      for (const [key, data] of after) if (applied.has(key)) state.h[key] = hash(JSON.stringify(data));
    }
    await putState(state);
    await report(await readLocal(), '');
  });
}

async function report(local, error) {
  let used = 0;
  try { used = await chrome.storage.sync.getBytesInUse(null); } catch (_) { /* old Chrome */ }
  await setStatus({ ok: !error, error, used, quota: chrome.storage.sync.QUOTA_BYTES || 102400, counts: { memories: local.memories.length, skills: local.skills.length, agents: local.agents.length } });
}

export async function syncNow() {
  await pull();
  await push();
  const { [STATUS]: st } = await chrome.storage.local.get(STATUS);
  return st;
}

// Remove everything DeepPilot stored in Chrome Sync (other computers keep their local copies).
export async function clearCloud() {
  return serial(async () => {
    const all = await chrome.storage.sync.get(null);
    await chrome.storage.sync.remove(Object.keys(all).filter(k => k.startsWith(P)));
    await putState({ h: {}, u: {} });
    await setStatus({ ok: true, error: '', used: 0, counts: {} });
  });
}

// ---------- wiring (runs in the background service worker) ----------
const WATCH = new Set(['memories', 'skills', 'agents', ...Object.keys(DEFAULTS)]);
let pushTimer = null, pullTimer = null;
export function startSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if ('chromeSync' in changes && changes.chromeSync.newValue) { syncNow(); return; }
      if (Object.keys(changes).some(k => WATCH.has(k))) { clearTimeout(pushTimer); pushTimer = setTimeout(() => push(), 1500); }
    } else if (area === 'sync') {
      if (Object.keys(changes).some(k => k.startsWith(P))) { clearTimeout(pullTimer); pullTimer = setTimeout(() => pull(), 400); }
    }
  });
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.target !== 'sync') return;
    (msg.cmd === 'clear' ? clearCloud().then(() => ({ ok: true })) : syncNow()).then(reply, e => reply({ ok: false, error: e.message }));
    return true;
  });
  syncNow().catch(e => console.warn('sync failed', e));
}
