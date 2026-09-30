// Local conversation history in IndexedDB (always on). Cloud sync is layered on top in cloud.js.

const DB = 'deeppilot';
const STORE = 'conversations';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  }));
}

export const newId = () => crypto.randomUUID();

export function newConversation(title) {
  const now = Date.now();
  return {
    id: newId(), title: (title || 'New task').slice(0, 120), createdAt: now, updatedAt: now,
    status: 'running', events: [], files: [], usage: { hit: 0, miss: 0, out: 0, cost: 0, calls: 0 }, synced: false,
  };
}

export const saveConversation = conv => tx('readwrite', s => s.put(JSON.parse(JSON.stringify(conv))));
export const getConversation = id => tx('readonly', s => s.get(id));
export const deleteConversation = id => tx('readwrite', s => s.delete(id));

export async function listConversations() {
  const all = await tx('readonly', s => s.getAll());
  return (all || [])
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ events, files, ...meta }) => ({ ...meta, taskCount: (events || []).filter(e => e.type === 'user').length, fileCount: (files || []).length, fileNames: (files || []).map(f => f.name) }));
}

// Markdown transcript for download.
export function toMarkdown(conv) {
  const lines = [`# ${conv.title}`, '', `- Date: ${new Date(conv.createdAt).toLocaleString()}`, `- Status: ${conv.status}`,
    `- Tokens: in ${(conv.usage?.hit || 0) + (conv.usage?.miss || 0)}, out ${conv.usage?.out || 0} · est. cost $${(conv.usage?.cost || 0).toFixed(4)}`, ''];
  for (const e of conv.events || []) {
    const time = new Date(e.t).toLocaleTimeString();
    if (e.type === 'user') lines.push(`**You** (${time}): ${e.text}`, '');
    else if (e.type === 'talk') lines.push(`${e.text}`, '');
    else if (e.type === 'action') lines.push(`- \`${e.name}\` ${e.args ? JSON.stringify(e.args) : ''}${e.error ? ` → ❌ ${e.error}` : ''}`);
    else if (e.type === 'final') lines.push('', `**Result:**`, '', e.text, '');
    else if (e.type === 'error') lines.push('', `**Error:** ${e.text}`, '');
    else if (e.type === 'ask') lines.push('', `**DeepPilot asked:** ${e.text}`, '');
    else if (e.type === 'confirm') lines.push('', `**Permission:** ${e.text} → ${e.answer || ''}`, '');
    else if (e.type === 'memory') lines.push(`- 🧠 ${e.text}`);
    else if (e.type === 'file') lines.push(`- 📎 File created: ${e.name}`);
  }
  return lines.join('\n');
}

export async function download(name, content, mime = 'text/plain') {
  const { saveBlob } = await import('./files.js');
  await saveBlob(new Blob([content], { type: mime + ';charset=utf-8' }), name);
}
