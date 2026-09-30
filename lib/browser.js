// Browser control: page reading, screenshots and real input via the Chrome DevTools Protocol.
import * as page from './page.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- script injection ----------
export async function run(tabId, func, ...args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res ? res.result : undefined;
}

export function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i.test(url)
    || /^https:\/\/chrome\.google\.com\/webstore/i.test(url)
    || /^https:\/\/chromewebstore\.google\.com/i.test(url);
}

// ---------- debugger (real mouse / keyboard input) ----------
const attached = new Set();
chrome.debugger.onDetach.addListener(src => { if (src.tabId) attached.delete(src.tabId); });

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  // Let the page behave as if focused even while it's a background tab (the user may be working elsewhere).
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_) { /* older Chrome */ }
}

async function cdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function detachTabs(tabIds) {
  for (const tabId of tabIds) {
    if (!attached.has(tabId)) continue;
    try { await chrome.debugger.detach({ tabId }); } catch (_) { /* already gone */ }
    attached.delete(tabId);
  }
}

let cursorOn = true;
export function setCursorEnabled(on) { cursorOn = !!on; }
async function moveCursor(tabId, x, y, mode) {
  if (!cursorOn) return;
  try { await run(tabId, page.showCursor, x, y, mode); await sleep(340); } catch (_) { /* page not scriptable */ }
}

export async function mouseClick(tabId, x, y, clickCount = 1) {
  await moveCursor(tabId, x, y, 'click');
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(40);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await sleep(40);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}

export async function mouseMove(tabId, x, y) {
  await moveCursor(tabId, x, y, 'move');
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export async function insertText(tabId, text) {
  await cdp(tabId, 'Input.insertText', { text });
}

const KEYMAP = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
};
const MODS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

export async function pressKey(tabId, combo) {
  const parts = String(combo).split('+').map(s => s.trim()).filter(Boolean);
  let modifiers = 0;
  let main = parts[parts.length - 1] || '';
  for (const p of parts.slice(0, -1)) {
    const m = MODS[p.toLowerCase().replace(/\s+/g, '')] ?? { option: 1, opt: 1, win: 4, super: 4 }[p.toLowerCase()];
    if (m === undefined) throw new Error(`Unknown modifier "${p}".`);
    modifiers |= m;
  }
  // Accept the names models naturally use: "Page Up", "Esc", "Return", "Del", "Up"…
  const ALIAS = { esc: 'escape', return: 'enter', del: 'delete', spacebar: 'space', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', pgup: 'pageup', pgdn: 'pagedown', pgdown: 'pagedown' };
  const norm = main.length === 1 ? main : main.toLowerCase().replace(/[\s_-]+/g, '');
  let def = KEYMAP[ALIAS[norm] || norm];
  if (!def) {
    if (main.length !== 1) throw new Error(`Unknown key "${main}". Use Enter, Tab, Escape, Backspace, Delete, Space, Arrow keys, PageUp/PageDown, Home, End, or a single character.`);
    const upper = main.toUpperCase();
    const isLetter = /[A-Z]/.test(upper);
    def = { key: main, code: isLetter ? `Key${upper}` : (/[0-9]/.test(main) ? `Digit${main}` : ''), keyCode: upper.charCodeAt(0), text: main };
  }
  const hasCmdMod = modifiers & (1 | 2 | 4);
  const down = {
    type: def.text && !hasCmdMod ? 'keyDown' : 'rawKeyDown',
    key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers,
  };
  if (def.text && !hasCmdMod) { down.text = def.text; down.unmodifiedText = def.text; }
  // Make select-all / copy / paste shortcuts work.
  if (hasCmdMod && def.key.length === 1) {
    const cmd = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' }[def.key.toLowerCase()];
    if (cmd) down.commands = [cmd];
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers });
}

// ---------- downloads & uploads ----------
export async function downloadAndWait(url, filename, timeout = 60000) {
  const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === 'complete') return item;
    if (item?.state === 'interrupted') throw new Error(`Download failed: ${item.error}`);
    await sleep(300);
  }
  throw new Error('Download timed out.');
}

// Put local files (by path) into the <input type=file> tagged by page.markFileInput.
export async function setFileInputByPath(tabId, paths) {
  const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: '[data-dp-upload]' });
  if (!nodeId) throw new Error('File input not reachable.');
  await cdp(tabId, 'DOM.setFileInputFiles', { nodeId, files: paths });
}

// ---------- tab helpers ----------
export async function waitForLoad(tabId, timeout = 15000) {
  const start = Date.now();
  await sleep(300);
  while (Date.now() - start < timeout) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (_) { return; }
    if (tab.status === 'complete') break;
    await sleep(250);
  }
  await settle(tabId); // single-page apps keep rendering after "complete"
}

// Wait until the page stops changing (results loaded, dialog opened) — at most maxMs.
export async function settle(tabId, maxMs = 2500) {
  try { await run(tabId, page.waitForQuiet, 450, maxMs); } catch (_) { await sleep(400); }
}

// The tab the user is looking at in their last focused normal browser window.
export async function getUserTab() {
  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch (_) { /* none */ }
  const q = win ? { active: true, windowId: win.id } : { active: true, lastFocusedWindow: true };
  const [active] = await chrome.tabs.query(q);
  if (active && !active.url?.startsWith(`chrome-extension://${chrome.runtime.id}`)) return active;
  const tabs = await chrome.tabs.query(win ? { windowId: win.id } : {});
  return tabs.filter(t => !t.url?.startsWith(`chrome-extension://${chrome.runtime.id}`))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

// ---------- sessions & tab ownership ----------
// All agents run inside the background service worker, one per session. A session "owns" the tabs it
// controls so two sessions never drive the same tab.
const owners = new Map(); // tabId -> sid

export async function claimTab(tabId, sid) {
  const cur = owners.get(tabId);
  if (cur && cur !== sid) return false;
  owners.set(tabId, sid);
  return true;
}
export function ownerOf(tabId) { return owners.get(tabId) || null; }
export function releaseAll(sid) {
  // Also releases the session's parallel workers ("<sid>:w2", "<sid>:w3", …).
  for (const [tabId, s] of owners) if (s === sid || s.startsWith(sid + ':')) owners.delete(tabId);
}
chrome.tabs.onRemoved.addListener(tabId => { owners.delete(tabId); attached.delete(tabId); });

// Tabs opened by pages we control (e.g. target=_blank links) become ours, and focus goes back to the user.
const recentActive = new Map(); // windowId -> [current, previous]
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const r = recentActive.get(windowId) || [];
  recentActive.set(windowId, [tabId, r[0]]);
});
const openedTabs = new Map(); // sid -> [tabIds]
chrome.tabs.onCreated.addListener(async tab => {
  const sid = tab.openerTabId != null ? owners.get(tab.openerTabId) : null;
  if (!sid) return;
  await claimTab(tab.id, sid);
  await groupTab(tab.id, sid);
  if (!openedTabs.has(sid)) openedTabs.set(sid, []);
  openedTabs.get(sid).push(tab.id);
  const [cur, prev] = recentActive.get(tab.windowId) || [];
  const back = cur === tab.id ? prev : cur;
  if (back != null && back !== tab.id) {
    setTimeout(async () => {
      try { if ((await chrome.tabs.get(tab.id)).active) await chrome.tabs.update(back, { active: true }); } catch (_) { /* gone */ }
    }, 150);
  }
});
export function takeOpenedTabs(sid) { const t = openedTabs.get(sid) || []; openedTabs.delete(sid); return t; }

const groups = new Map(); // sid -> groupId
export async function groupTab(tabId, sid, title = 'DeepPilot') {
  sid = String(sid).split(':')[0]; // parallel workers share their session's tab group
  try {
    let groupId = groups.get(sid) ?? null;
    if (groupId != null) {
      try { await chrome.tabGroups.get(groupId); } catch (_) { groupId = null; }
    }
    groupId = await chrome.tabs.group(groupId != null ? { tabIds: [tabId], groupId } : { tabIds: [tabId] });
    groups.set(sid, groupId);
    await chrome.tabGroups.update(groupId, { title, color: 'blue' });
  } catch (_) { /* tab groups unavailable */ }
}

// Create a background tab owned by this session (never steals focus).
export async function createAgentTab(url = 'about:blank', windowId, sid = 'default') {
  if (windowId == null) {
    try { windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id; } catch (_) { /* default */ }
  }
  let tab;
  try { tab = await chrome.tabs.create({ url, active: false, ...(windowId != null ? { windowId } : {}) }); }
  catch (_) { tab = (await chrome.windows.create({ url, focused: false })).tabs[0]; }
  await claimTab(tab.id, sid);
  await groupTab(tab.id, sid);
  return tab;
}

// Pick the tab a session works in: its previous/bound tab, else the user's current tab, else a new background tab.
export async function acquireTab(previousId, { preferNew = false, sid = 'default' } = {}) {
  if (previousId != null) {
    try { const t = await chrome.tabs.get(previousId); if (await claimTab(t.id, sid)) return t; } catch (_) { /* closed */ }
  }
  const t = await getUserTab();
  if (!preferNew && t && await claimTab(t.id, sid)) return t;
  return createAgentTab('about:blank', t?.windowId, sid);
}

// ---------- screenshots ----------
async function resizeImage(dataUrl, targetW) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const w = Math.min(targetW, bmp.width);
  const h = Math.round(bmp.height * (w / bmp.width));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
  return new Promise(res => { const r = new FileReader(); r.onload = () => res({ dataUrl: r.result, width: w }); r.readAsDataURL(out); });
}

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// Screenshot through the DevTools protocol: works for background tabs, so the user's view is never changed.
// Returns { dataUrl, scale } where scale = screenshot px / CSS px.
export async function screenshot(tab, viewportWidth, maxWidth = 1280) {
  const target = Math.min(maxWidth, viewportWidth || maxWidth);
  let raw;
  try {
    const r = await withTimeout(cdp(tab.id, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true }), 6000, 'screenshot timed out');
    raw = 'data:image/jpeg;base64,' + r.data;
  } catch (e) {
    // Fallback only if the tab is already visible — never switch tabs just to take a picture.
    if (!tab.active) throw e;
    raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
  }
  const img = await resizeImage(raw, target);
  return { dataUrl: img.dataUrl, scale: img.width / (viewportWidth || img.width) };
}

// ---------- observation ----------
export async function observe(tabId, { vision }) {
  const tab = await chrome.tabs.get(tabId);
  const result = { tab, snapshot: null, image: null, scale: 1, note: '' };
  if (isRestrictedUrl(tab.url)) {
    result.note = 'This is a browser-internal page that extensions cannot read or control. Use navigate to open a website.';
    return result;
  }
  try {
    result.snapshot = await run(tabId, page.pageSnapshot, !!vision);
  } catch (e) {
    result.note = `Could not read this page: ${e.message}`;
    return result;
  }
  if (vision) {
    try {
      const shot = await screenshot(tab, result.snapshot.viewportWidth);
      result.image = shot.dataUrl;
      result.scale = shot.scale;
    } catch (e) {
      result.note = `No screenshot this step (${e.message}); use the element list.`;
    } finally {
      try { await run(tabId, page.removeMarks); } catch (_) { /* ignore */ }
    }
  }
  return result;
}
