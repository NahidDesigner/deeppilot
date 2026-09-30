// Functions injected into the web page with chrome.scripting.executeScript.
// Each one must be fully self-contained (no references to outer scope).
// They run in the extension's isolated world, whose globals persist between
// calls on the same page, so element references are kept in window.__dp.

export function pageSnapshot(opts) {
  // opts: { marks: bool, idBase: number, clip?: {left,top,right,bottom} (this frame's part of the main
  // viewport, for iframes), outline: bool }. Older callers pass a boolean (= marks).
  if (typeof opts !== 'object' || opts === null) opts = { marks: !!opts };
  const MAX = opts.max || 250;
  const idBase = opts.idBase || 0;
  const drawMarks = !!opts.marks;
  const old = document.getElementById('__dp_marks');
  if (old) old.remove();

  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary', 'label[for]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[role=searchbox]', '[role=slider]', '[role=spinbutton]', '[role=treeitem]', '[role=gridcell][tabindex]', '[contenteditable=""]', '[contenteditable=true]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const clean = (s, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) {
      // Use only the label's own text, not the text of controls nested inside it (e.g. <option>s).
      const t = Array.from(el.labels).map(l => {
        const own = Array.from(l.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
        return clean(own) ? own : l.innerText;
      }).join(' ');
      if (clean(t)) return clean(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return clean(el.getAttribute('alt') || el.getAttribute('title') || 'image');
    if (tag === 'canvas') return clean(el.getAttribute('aria-label') || 'canvas');
    if (tag === 'input' || tag === 'textarea') {
      return clean(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '');
    }
    const text = clean(el.innerText || el.textContent || '');
    if (text) return text;
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && clean(img.alt)) return clean(img.alt);
    const svgTitle = el.querySelector && el.querySelector('svg title');
    if (svgTitle && clean(svgTitle.textContent)) return clean(svgTitle.textContent);
    return clean(el.getAttribute('title') || el.getAttribute('data-tooltip') || el.getAttribute('name') || el.getAttribute('value') || '');
  }

  function isVisible(el, r) {
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) < 0.05) return false;
    return true;
  }

  const clip = opts.clip || { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  function inViewport(r) {
    return r.bottom > Math.max(0, clip.top) && r.right > Math.max(0, clip.left) && r.top < Math.min(innerHeight, clip.bottom) && r.left < Math.min(innerWidth, clip.right);
  }

  function isOnTop(el, r) {
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (!hit) return true;
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    const root = el.getRootNode();
    if (root && root.host && (hit === root.host || hit.contains(root.host))) return true;
    // Labels wrapping inputs, etc.
    if (hit.closest && hit.closest('label') && hit.closest('label').contains(el)) return true;
    return false;
  }

  // Collect candidates, including inside open shadow roots.
  const candidates = [];
  const roots = [document];
  while (roots.length) {
    const root = roots.shift();
    root.querySelectorAll(SELECTOR).forEach(el => candidates.push(el));
    root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); });
  }
  // Also pick up elements styled as clickable (cursor:pointer) that have no semantic role.
  let checked = 0;
  for (const el of document.querySelectorAll('div,span,li,img,svg,td,i')) {
    if (++checked > 6000 || candidates.length > 3000) break;
    const r = el.getBoundingClientRect();
    if (!inViewport(r) || r.width < 2 || r.height < 2) continue;
    if (el.closest(SELECTOR)) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
    candidates.push(el);
  }

  // Large images/canvases are listed too, so the agent can save them (save_image).
  for (const el of document.querySelectorAll('img, canvas, [role=img]')) {
    const r = el.getBoundingClientRect();
    if (r.width >= 60 && r.height >= 60) candidates.push(el);
  }

  const chosen = [];
  const chosenSet = new Set();
  let above = 0, below = 0;
  for (const el of candidates) {
    if (chosenSet.has(el)) continue;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) continue;
    if (!inViewport(r)) { if (r.bottom <= Math.max(0, clip.top)) above++; else below++; continue; }
    if (!isOnTop(el, r)) continue;
    const tag = el.tagName.toLowerCase();
    const isField = ['input', 'textarea', 'select', 'img', 'canvas'].includes(tag);
    // Skip non-field elements nested inside an already chosen clickable.
    let p = el.parentElement, nested = false;
    while (p) { if (chosenSet.has(p)) { nested = true; break; } p = p.parentElement; }
    if (nested && !isField) continue;
    chosen.push({ el, r });
    chosenSet.add(el);
    if (chosen.length >= MAX) break;
  }

  // Context for ambiguous controls: the row / card / list item they belong to.
  // (A DNS table has 30 "Edit" buttons — the model must know which row each one edits.)
  const GENERIC = /^(edit|delete|remove|more|more actions|options|menu|open|view|manage|details|settings|select|copy|share|\.\.\.|⋮|…|x|close|save|cancel|add|\+|-|actions|configure|update|change)$/i;
  const labelCount = new Map();
  const labels = chosen.map(({ el }) => { const l = labelOf(el); labelCount.set(l, (labelCount.get(l) || 0) + 1); return l; });
  function contextOf(el, label) {
    let p = el.parentElement;
    for (let depth = 0; p && depth < 8; depth++, p = p.parentElement) {
      const role = p.getAttribute && p.getAttribute('role');
      const isRow = p.tagName === 'TR' || role === 'row' || p.tagName === 'LI' || role === 'listitem' || p.tagName === 'ARTICLE' || role === 'article' || p.tagName === 'FIELDSET';
      const txt = clean(p.innerText || '', 400);
      if (!txt || txt === label) continue;
      if (isRow || (txt.length > label.length + 3 && txt.length <= 220 && depth >= 1)) {
        const rest = clean(txt.replace(label, ' '), 90);
        if (rest) return rest;
      }
      if (txt.length > 400) break;
    }
    return '';
  }

  // "New since the last step" markers — the clearest signal of what an action changed.
  const prev = window.__dp && window.__dp.sigs;
  const sigs = new Set();

  window.__dp = { els: [], labels: [], sigs, idBase };
  const lines = [];
  const colors = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];
  let marks = null;
  if (drawMarks) {
    marks = document.createElement('div');
    marks.id = '__dp_marks';
    marks.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  }

  chosen.forEach(({ el, r }, i) => {
    const id = idBase + i + 1;
    const tag = el.tagName.toLowerCase();
    const label = labels[i];
    window.__dp.els[id] = el;
    window.__dp.labels[id] = label;
    const sig = `${tag}|${el.getAttribute('role') || ''}|${label}|${el.getAttribute('href') || ''}`;
    sigs.add(sig);
    let desc = `${prev && !prev.has(sig) ? '*' : ''}[${id}] <${tag}`;
    const type = el.getAttribute('type');
    if (type && tag === 'input') desc += ` type=${type}`;
    const role = el.getAttribute('role');
    if (role) desc += ` role=${role}`;
    desc += `> "${label}"`;
    if (tag === 'input' || tag === 'textarea') {
      if (type === 'password') desc += el.value ? ' value=(hidden, filled)' : ' value=""';
      else if (type === 'checkbox' || type === 'radio') desc += el.checked ? ' checked' : ' unchecked';
      else desc += ` value="${clean(el.value, 60)}"`;
      if (el.required) desc += ' required';
      if (el.getAttribute('aria-invalid') === 'true') desc += ' INVALID';
    }
    if (tag === 'select') {
      const opts = Array.from(el.options).slice(0, 15).map(o => clean(o.text, 30));
      desc += ` selected="${clean(el.selectedOptions[0]?.text || '', 40)}" options=[${opts.join(' | ')}${el.options.length > 15 ? ' | …' : ''}]`;
    }
    if (role === 'combobox' || role === 'spinbutton' || role === 'slider') {
      const v = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || (el.value ?? '') || '';
      if (v) desc += ` value="${clean(String(v), 40)}"`;
    }
    if (el.isContentEditable && tag !== 'input' && tag !== 'textarea') desc += ` editable text="${clean(el.innerText, 60)}"`;
    if (tag === 'img' || tag === 'canvas') desc += ` size=${Math.round(r.width)}x${Math.round(r.height)}`;
    if (el.getAttribute('aria-expanded')) desc += ` expanded=${el.getAttribute('aria-expanded')}`;
    if (el.getAttribute('aria-checked')) desc += ` checked=${el.getAttribute('aria-checked')}`;
    if (el.getAttribute('aria-pressed')) desc += ` pressed=${el.getAttribute('aria-pressed')}`;
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') desc += ' selected';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') desc += ' disabled';
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript')) desc += ` href="${href.slice(0, 80)}"`;
    }
    if (labelCount.get(label) > 1 || GENERIC.test(label) || !label) {
      const ctx = contextOf(el, label);
      if (ctx) desc += ` — in: "${ctx}"`;
    }
    lines.push(desc);

    if (marks) {
      const c = colors[i % colors.length];
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid ${c};border-radius:3px;box-sizing:border-box;`;
      const badge = document.createElement('div');
      badge.textContent = id;
      const bx = Math.max(0, r.left);
      const by = r.top > 14 ? r.top - 14 : r.top;
      badge.style.cssText = `position:fixed;left:${bx}px;top:${by}px;background:${c};color:#fff;font:bold 11px/14px Arial,sans-serif;padding:0 3px;border-radius:3px;`;
      marks.appendChild(box);
      marks.appendChild(badge);
    }
  });
  if (marks) document.documentElement.appendChild(marks);

  // Visible text the element list can't show: headings, alerts/toasts, open dialogs, tables in view
  // and short value texts (statuses, prices, counts). Capped so it stays cheap.
  const outline = [];
  if (opts.outline !== false) {
    const seen = new Set();
    let budget = 2400;
    const push = t => { t = clean(t, 220); if (!t || seen.has(t) || budget <= 0) return; seen.add(t); outline.push(t); budget -= t.length + 1; };
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && inViewport(r) && getComputedStyle(el).visibility !== 'hidden'; };
    for (const el of document.querySelectorAll('[role=alert], [role=alertdialog], [role=status], [aria-live=assertive], [aria-live=polite], .toast, [class*="toast" i], [class*="snackbar" i], [class*="error-message" i], .error, .notice')) {
      const t = clean(el.innerText || '', 200);
      if (t && vis(el)) push(`ALERT: ${t}`);
    }
    for (const d of document.querySelectorAll('dialog[open], [role=dialog], [aria-modal=true]')) {
      if (!vis(d)) continue;
      const h = d.querySelector('h1,h2,h3,[role=heading]');
      push(`DIALOG OPEN: ${clean(d.getAttribute('aria-label') || h?.innerText || d.innerText, 120)}`);
    }
    for (const h of document.querySelectorAll('h1,h2,h3,h4,[role=heading]')) if (vis(h)) push(`${'#'.repeat(Math.min(4, +(h.tagName[1]) || +(h.getAttribute('aria-level')) || 2))} ${h.innerText}`);
    let tables = 0;
    for (const t of document.querySelectorAll('table, [role=grid], [role=table], [role=treegrid]')) {
      if (tables >= 2 || !vis(t)) continue;
      tables++;
      const rows = [...t.querySelectorAll('tr, [role=row]')].filter(vis).slice(0, 16);
      if (!rows.length) continue;
      push(`TABLE (${t.querySelectorAll('tr, [role=row]').length} rows):`);
      for (const r of rows) push('| ' + [...r.querySelectorAll('th, td, [role=columnheader], [role=cell], [role=gridcell], [role=rowheader]')].map(c => clean(c.innerText, 32)).join(' | ') + ' |');
    }
    // short leaf texts in view: values, statuses, labels next to numbers
    let leafs = 0;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n, visited = 0;
    while ((n = walker.nextNode()) && leafs < 45 && budget > 600 && ++visited < 5000) {
      const raw = n.textContent.replace(/\s+/g, ' ').trim();
      // Short texts only (values, statuses, prices, labels) — prose is what get_page_text / extract are for.
      if (raw.length < 2 || raw.length > 70 || !n.parentElement) continue;
      const t = raw;
      const pe = n.parentElement;
      if (pe.closest('script,style,noscript,table,[role=grid],h1,h2,h3,h4,button,a,[role=button],[role=link],label,option,select,textarea,#__dp_marks')) continue;
      if (!vis(pe)) continue;
      push(t); leafs++;
    }
  }

  const se = document.scrollingElement || document.documentElement;
  const vh = innerHeight || 1;
  return {
    url: location.href,
    title: document.title,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    scrollY: Math.round(se.scrollTop),
    scrollHeight: Math.round(se.scrollHeight),
    pagesAbove: +(se.scrollTop / vh).toFixed(1),
    pagesBelow: +(Math.max(0, se.scrollHeight - se.scrollTop - vh) / vh).toFixed(1),
    elements: lines,
    count: chosen.length,
    offscreen: above + below, above, below,
    outline,
  };
}

// Search the WHOLE page (not only what's in view) for elements and texts matching a description.
// Returns the best matches; with scroll=true the best match is scrolled into view so the next page
// state lists it with an id.
export function findOnPage(query, scroll) {
  const clean = (s, n = 100) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const words = clean(query, 200).toLowerCase().split(/[^\p{L}\p{N}.@:-]+/u).filter(w => w.length > 1);
  if (!words.length) return { error: 'Describe what to find, e.g. "Proxy status toggle for www".' };
  const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=switch],[role=checkbox],[role=combobox],[role=option],[contenteditable=true],[onclick],label,h1,h2,h3,h4,th,td,[role=gridcell],[role=cell],summary,li';
  const all = [];
  const roots = [document];
  while (roots.length) { const r = roots.shift(); r.querySelectorAll(SEL).forEach(e => all.push(e)); r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) roots.push(e.shadowRoot); }); }
  const scored = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden') continue;
    const own = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.value || '', 120);
    const row = el.closest('tr,[role=row],li,article,fieldset,section');
    const ctx = row && row !== el ? clean(row.innerText, 160) : '';
    const hay = (own + ' ' + ctx).toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += own.toLowerCase().includes(w) ? 2 : 1;
    if (!score) continue;
    const interactive = el.matches('a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=switch],[role=checkbox],[role=combobox],[role=option],[contenteditable=true],[onclick],summary');
    scored.push({ el, score: score + (interactive ? 0.5 : 0) - own.length / 1000, own, ctx, inView: r.bottom > 0 && r.top < innerHeight, tag: el.tagName.toLowerCase() });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 12);
  if (scroll && top[0] && !top[0].inView) top[0].el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return {
    matches: top.map((m, i) => ({ rank: i + 1, tag: m.tag, text: m.own, context: m.ctx && m.ctx !== m.own ? m.ctx.slice(0, 120) : undefined, in_view: m.inView || (i === 0 && !!scroll) })),
    total: scored.length,
    note: top.length ? (scroll ? 'The best match is now in view — use its [id] from the next page state.' : 'Scroll to a match to get its [id].') : 'Nothing matched. Try other words, or it may be inside a menu/tab that must be opened first.',
  };
}

// Grep the page's text: every occurrence of `query` with some surrounding text. Costs no model call.
export function searchPageText(query, max) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { error: 'Give the text to search for.' };
  const text = (document.body?.innerText || '').replace(/[ \t]+/g, ' ');
  const low = text.toLowerCase();
  const hits = [];
  let i = low.indexOf(q);
  while (i >= 0 && hits.length < (max || 20)) {
    hits.push(text.slice(Math.max(0, i - 90), i + q.length + 90).replace(/\s+/g, ' ').trim());
    i = low.indexOf(q, i + q.length);
  }
  let count = 0; for (let j = low.indexOf(q); j >= 0; j = low.indexOf(q, j + q.length)) count++;
  return { query, count, matches: hits };
}

// Resolves once the page has stopped changing: no DOM changes for `quietMs` and no visible
// loading indicator — or after `maxMs` at the latest. Single-page apps (LinkedIn, Gmail…) keep the tab
// "complete" while they fetch and render, so reading right after an action would see stale content.
export function waitForQuiet(quietMs = 450, maxMs = 2500) {
  return new Promise(resolve => {
    const start = performance.now();
    let last = start;
    const mo = new MutationObserver(() => { last = performance.now(); });
    try { mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (_) { resolve({ waited: 0 }); return; }
    const busy = () => [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [class*="loader" i], [class*="spinner" i]')]
      .some(e => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
    const tick = () => {
      const now = performance.now();
      if ((now - last >= quietMs && document.readyState === 'complete' && !busy()) || now - start >= maxMs) {
        mo.disconnect();
        resolve({ waited: Math.round(now - start) });
      } else setTimeout(tick, 100);
    };
    setTimeout(tick, 120);
  });
}

// Where this frame is and what it is (run in every frame). Same-origin frames can compute their own
// offset in the top page via frameElement; cross-origin ones are matched to an <iframe> by URL.
export function frameProbe() {
  let off = null;
  try {
    if (window !== top) {
      let x = 0, y = 0, w = window;
      while (w !== top) {
        const fe = w.frameElement; if (!fe) { x = null; break; }
        const r = fe.getBoundingClientRect(), st = w.parent.getComputedStyle(fe);
        x += r.left + fe.clientLeft + parseFloat(st.paddingLeft || 0); y += r.top + fe.clientTop + parseFloat(st.paddingTop || 0);
        w = w.parent;
      }
      if (x !== null) off = { x, y, w: innerWidth, h: innerHeight };
    }
  } catch (_) { off = null; }
  return { url: location.href, name: window.name || '', w: innerWidth, h: innerHeight, off };
}
// The top page's iframes with their content-box position (to place cross-origin frames).
export function listIframes() {
  return [...document.querySelectorAll('iframe, frame')].map(f => {
    const r = f.getBoundingClientRect(), st = getComputedStyle(f);
    return { src: f.src || '', x: r.left + f.clientLeft + parseFloat(st.paddingLeft || 0), y: r.top + f.clientTop + parseFloat(st.paddingTop || 0), w: f.clientWidth, h: f.clientHeight };
  });
}

// What kind of form control an element is (for fill_form).
export function fieldKind(id) {
  const el = window.__dp && window.__dp.els[id];
  if (!el || !el.isConnected) return { error: `Element [${id}] is gone. Use ids from the latest page state.` };
  const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase(), role = el.getAttribute('role');
  if (tag === 'select') return { kind: 'select' };
  if (type === 'checkbox' || type === 'radio') return { kind: 'check', checked: el.checked };
  if (role === 'checkbox' || role === 'switch' || role === 'radio') return { kind: 'check', checked: el.getAttribute('aria-checked') === 'true' };
  return { kind: 'text' };
}

export function removeMarks() {
  const m = document.getElementById('__dp_marks');
  if (m) m.remove();
  return true;
}

export function elementPoint(id, scroll) {
  const el = window.__dp && window.__dp.els[id];
  if (!el || !el.isConnected) return { error: `Element [${id}] no longer exists. The page changed; use the ids from the latest page state.` };
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    label: (window.__dp.labels[id] || '').slice(0, 80),
    tag: el.tagName.toLowerCase(),
  };
}

export function jsClick(id) {
  const el = window.__dp && window.__dp.els[id];
  if (!el || !el.isConnected) return { error: `Element [${id}] no longer exists.` };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return { ok: true };
}

export function jsClickPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { error: 'Nothing at that point.' };
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts));
  }
  return { ok: true };
}

// Focus a field and select its content (so inserted text replaces it) or put caret at end.
export function prepareField(id, clear) {
  const el = window.__dp && window.__dp.els[id];
  if (!el || !el.isConnected) return { error: `Element [${id}] no longer exists.` };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  const tag = el.tagName.toLowerCase();
  const editable = el.isContentEditable;
  if (!(tag === 'input' || tag === 'textarea' || editable)) {
    // Maybe a wrapper; try an inner field.
    const inner = el.querySelector('input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true]');
    if (inner) { inner.focus(); return prepareFieldEl(inner); }
    return { error: `Element [${id}] (<${tag}>) is not a text field.` };
  }
  return prepareFieldEl(el);

  function prepareFieldEl(f) {
    if (f.isContentEditable) {
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(f);
      if (!clear) range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      try {
        if (clear) f.select();
        else { const n = f.value.length; f.setSelectionRange(n, n); }
      } catch (_) { /* some input types don't support selection */ if (clear) f.value = ''; }
    }
    return { ok: true, focused: document.activeElement === f || f.contains(document.activeElement) };
  }
}

// Fallback typing without the debugger: set value and fire events React/Vue listen to.
export function jsSetValue(id, text, clear) {
  const el = window.__dp && window.__dp.els[id];
  if (!el || !el.isConnected) return { error: `Element [${id}] no longer exists.` };
  let f = el;
  if (!(['input', 'textarea'].includes(f.tagName.toLowerCase()) || f.isContentEditable)) {
    f = el.querySelector('input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true]') || el;
  }
  f.focus();
  if (f.isContentEditable) {
    if (clear) f.textContent = '';
    document.execCommand('insertText', false, text);
  } else {
    const proto = f.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(f, (clear ? '' : f.value) + text);
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: true };
}

export function selectOption(id, option) {
  const el = window.__dp && window.__dp.els[id];
  if (!el || !el.isConnected) return { error: `Element [${id}] no longer exists.` };
  if (el.tagName.toLowerCase() !== 'select') return { error: `Element [${id}] is not a <select>. Click it to open custom dropdowns instead.` };
  const want = String(option).trim().toLowerCase();
  const opts = Array.from(el.options);
  const match = opts.find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
    || opts.find(o => o.text.trim().toLowerCase().includes(want));
  if (!match) return { error: `No option matching "${option}". Options: ${opts.map(o => o.text.trim()).slice(0, 30).join(' | ')}` };
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, selected: match.text.trim() };
}

export function scrollPage(direction, amount, id) {
  let target = null;
  if (id) {
    target = window.__dp && window.__dp.els[id];
    if (!target || !target.isConnected) return { error: `Element [${id}] no longer exists.` };
  }
  const sign = direction === 'up' ? -1 : 1;
  if (target) {
    // Find nearest scrollable ancestor (or the element itself).
    let s = target;
    while (s && s !== document.body) {
      const st = getComputedStyle(s);
      if (/(auto|scroll)/.test(st.overflowY) && s.scrollHeight > s.clientHeight) break;
      s = s.parentElement;
    }
    if (s && s !== document.body) {
      s.scrollBy({ top: sign * s.clientHeight * amount, behavior: 'instant' });
      return { ok: true, scrolledElement: true };
    }
  }
  const se = document.scrollingElement || document.documentElement;
  const before = se.scrollTop;
  window.scrollBy({ top: sign * innerHeight * amount, behavior: 'instant' });
  const after = se.scrollTop;
  return { ok: true, moved: Math.round(after - before), atBottom: after + innerHeight >= se.scrollHeight - 2, atTop: after <= 0 };
}

export function pageText(maxChars) {
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n');
  // Contacts: visible text + mailto:/tel: links + raw HTML (catches emails hidden in attributes).
  const emails = new Set(), phones = new Set();
  const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
  const bad = /\.(png|jpe?g|gif|webp|svg|css|js)$|example\.com|sentry|wixpress|@2x/i;
  for (const m of (text + ' ' + (document.documentElement.innerHTML || '').slice(0, 2_000_000)).matchAll(emailRe)) {
    if (!bad.test(m[0])) emails.add(m[0].toLowerCase());
    if (emails.size > 50) break;
  }
  document.querySelectorAll('a[href^="mailto:"]').forEach(a => { const e = decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]).trim().toLowerCase(); if (e) emails.add(e); });
  document.querySelectorAll('a[href^="tel:"]').forEach(a => { const t = a.getAttribute('href').slice(4).trim(); if (t) phones.add(decodeURIComponent(t)); });
  for (const m of text.matchAll(/(?<![\d])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g)) { phones.add(m[0].trim()); if (phones.size > 30) break; }
  return {
    title: document.title, url: location.href,
    text: text.slice(0, maxChars), truncated: text.length > maxChars, totalChars: text.length,
    emails: [...emails].slice(0, 30), phones: [...phones].slice(0, 20),
  };
}

export function getLinks(filter, limit) {
  const f = String(filter || '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || href.startsWith('javascript:') || seen.has(href)) continue;
    const text = (a.getAttribute('aria-label') || a.innerText || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (f && !href.toLowerCase().includes(f) && !text.toLowerCase().includes(f)) continue;
    seen.add(href);
    out.push({ text, url: href.slice(0, 500) });
    if (out.length >= limit) break;
  }
  return { count: out.length, links: out };
}

// ---------- visible agent cursor ----------
export function showCursor(x, y, mode) {
  let c = document.getElementById('__dp_cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = '__dp_cursor';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transition:transform .32s cubic-bezier(.3,.7,.2,1);will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5 19.5 12 12.4 13.6 8.9 20.5z" fill="#4d6bfe" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const start = window.__dpLastCursor || { x: innerWidth / 2, y: innerHeight / 2 };
    c.style.transform = `translate(${start.x - 4}px, ${start.y - 2}px)`;
    document.documentElement.appendChild(c);
    c.getBoundingClientRect();
  }
  window.__dpLastCursor = { x, y };
  c.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
  clearTimeout(window.__dpCursorHide);
  window.__dpCursorHide = setTimeout(() => { c.remove(); }, 15000);
  if (mode === 'click') {
    setTimeout(() => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:3px solid #4d6bfe;z-index:2147483646;pointer-events:none;opacity:.9;transition:transform .45s ease-out,opacity .45s ease-out;`;
      document.documentElement.appendChild(r);
      r.getBoundingClientRect();
      r.style.transform = 'scale(1.9)';
      r.style.opacity = '0';
      setTimeout(() => r.remove(), 500);
    }, 320);
  }
  return true;
}

// ---------- images & file uploads ----------
export function imageSource(id) {
  const el = window.__dp && window.__dp.els[id];
  if (!el || !el.isConnected) return { error: `Element [${id}] no longer exists.` };
  const pick = n => {
    if (!n) return null;
    const tag = n.tagName.toLowerCase();
    if (tag === 'img') return n.currentSrc || n.src;
    if (tag === 'canvas') { try { return n.toDataURL('image/png'); } catch (_) { return null; } }
    if (tag === 'image' || tag === 'source') return n.getAttribute('href') || n.getAttribute('srcset')?.split(' ')[0];
    const bg = getComputedStyle(n).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    return m ? m[1] : null;
  };
  let src = pick(el);
  if (!src) {
    // Largest image inside the element (e.g. a card or link wrapping the picture).
    const imgs = [...el.querySelectorAll('img,canvas')].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    src = pick(imgs[0]);
  }
  if (!src) return { error: `No image found in element [${id}].` };
  return { src: new URL(src, location.href).href };
}

export async function fetchInPage(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const blob = await res.blob();
    if (blob.size > 25_000_000) return { error: 'Image is larger than 25 MB.' };
    const dataUrl = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
    return { dataUrl, mime: blob.type };
  } catch (e) { return { error: e.message }; }
}

// Find the file <input> belonging to element id (itself, inside it, its label, its form) or on the page, and tag it.
export function markFileInput(id) {
  document.querySelectorAll('[data-dp-upload]').forEach(n => n.removeAttribute('data-dp-upload'));
  const el = id != null && window.__dp ? window.__dp.els[id] : null;
  const isFile = n => n && n.tagName && n.tagName.toLowerCase() === 'input' && n.type === 'file';
  let input = null;
  if (el) {
    if (isFile(el)) input = el;
    else input = el.querySelector('input[type=file]')
      || (el.tagName.toLowerCase() === 'label' && el.control && isFile(el.control) ? el.control : null)
      || (el.closest('label') && isFile(el.closest('label').control) ? el.closest('label').control : null)
      || el.closest('form,[role=dialog],section,div')?.querySelector('input[type=file]');
  }
  if (!input) {
    const all = [...document.querySelectorAll('input[type=file]')];
    input = all.find(n => !n.disabled) || null;
  }
  if (!input) return { found: false };
  input.setAttribute('data-dp-upload', '1');
  return { found: true, accept: input.accept || '', multiple: input.multiple, count: document.querySelectorAll('input[type=file]').length };
}

export function fileInputCount() {
  const n = document.querySelector('[data-dp-upload]');
  return n ? n.files.length : -1;
}

// Upload without a disk path: build File objects and hand them to the input, or drop them on the element.
export async function setFilesViaDataTransfer(files, id) {
  const dt = new DataTransfer();
  for (const f of files) {
    const blob = await (await fetch(f.dataUrl)).blob();
    dt.items.add(new File([blob], f.name, { type: f.mime || blob.type }));
  }
  const input = document.querySelector('[data-dp-upload]');
  if (input) {
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, method: 'input', count: input.files.length };
  }
  const target = id != null && window.__dp ? window.__dp.els[id] : null;
  if (!target) return { error: 'No file input or drop target found.' };
  for (const type of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }
  return { ok: true, method: 'drop' };
}
