// Long-term memory: facts, preferences and saved workflows the user asked the agent to remember.
// Stored in chrome.storage.local, so it survives browser restarts and is injected into every task.

const KEY = 'memories';
const MAX_ITEMS = 200;

export async function loadMemories() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return Array.isArray(list) ? list : [];
}

async function save(list) {
  await chrome.storage.local.set({ [KEY]: list });
}

export async function addMemory(text) {
  const clean = String(text || '').trim().slice(0, 4000);
  if (!clean) throw new Error('Nothing to remember.');
  const list = await loadMemories();
  const dup = list.find(m => m.text.toLowerCase() === clean.toLowerCase());
  if (dup) return dup.id;
  if (list.length >= MAX_ITEMS) throw new Error(`Memory is full (${MAX_ITEMS} items). Ask the user which memories to delete.`);
  const id = list.reduce((mx, m) => Math.max(mx, m.id), 0) + 1;
  list.push({ id, uid: crypto.randomUUID(), text: clean, created: Date.now() });
  await save(list);
  return id;
}

export async function updateMemory(id, text) {
  const list = await loadMemories();
  const m = list.find(x => x.id === Number(id));
  if (!m) throw new Error(`No memory with id ${id}.`);
  m.text = String(text || '').trim().slice(0, 4000);
  m.updated = Date.now();
  await save(list);
}

export async function deleteMemory(id) {
  const list = await loadMemories();
  const next = list.filter(x => x.id !== Number(id));
  if (next.length === list.length) throw new Error(`No memory with id ${id}.`);
  await save(next);
}

export function formatMemories(list) {
  if (!list.length) return '(no memories saved yet)';
  return list.map(m => `[m${m.id}] ${m.text}`).join('\n');
}
