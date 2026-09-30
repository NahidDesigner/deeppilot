// Saved skills: reusable task instructions the user runs by typing /skill-name in the chat.

const KEY = 'skills';

export const slugify = s => String(s || '').toLowerCase().trim().replace(/^\//, '').replace(/[^a-z0-9ঀ-৿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export async function loadSkills() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return (Array.isArray(list) ? list : []).sort((a, b) => a.name.localeCompare(b.name));
}

async function save(list) { await chrome.storage.local.set({ [KEY]: list }); }

export async function saveSkill({ id, name, description = '', instructions }) {
  const slug = slugify(name);
  if (!slug) throw new Error('Give the skill a name (letters, numbers, dashes).');
  if (!String(instructions || '').trim()) throw new Error('Write the instructions for this skill.');
  const list = await loadSkills();
  const clash = list.find(s => s.name === slug && s.id !== id);
  if (clash && !id) {
    // Same name without an id = update that skill (used by the agent's save_skill tool).
    id = clash.id;
  } else if (clash) {
    throw new Error(`A skill named /${slug} already exists.`);
  }
  const now = Date.now();
  const existing = list.find(s => s.id === id);
  if (existing) {
    Object.assign(existing, { name: slug, description: String(description).trim().slice(0, 200), instructions: String(instructions).trim().slice(0, 8000), updatedAt: now });
  } else {
    list.push({ id: crypto.randomUUID(), name: slug, description: String(description).trim().slice(0, 200), instructions: String(instructions).trim().slice(0, 8000), createdAt: now, updatedAt: now });
  }
  await save(list);
  return slug;
}

export async function deleteSkill(id) {
  await save((await loadSkills()).filter(s => s.id !== id));
}

export async function importSkills(json) {
  const data = JSON.parse(json);
  const arr = Array.isArray(data) ? data : data.skills;
  if (!Array.isArray(arr)) throw new Error('Not a DeepPilot skills file.');
  let n = 0;
  for (const s of arr) {
    if (!s || !s.name || !s.instructions) continue;
    await saveSkill({ name: s.name, description: s.description, instructions: s.instructions });
    n++;
  }
  return n;
}

// Turn "/daily-linkedin 5 people" into the full instructions for the agent.
export function expandSkills(text, skills) {
  const used = [];
  const rest = String(text).replace(/(^|\s)\/([a-z0-9ঀ-৿-]+)(?=\s|$)/gi, (m, pre, name) => {
    const s = skills.find(x => x.name === name.toLowerCase());
    if (!s) return m;
    if (!used.includes(s)) used.push(s);
    return pre;
  }).trim();
  if (!used.length) return { task: text, used: [] };
  const parts = used.map(s => `Run the saved skill "/${s.name}"${s.description ? ` (${s.description})` : ''}. Follow these instructions:\n${s.instructions}`);
  parts.push(rest ? `Extra input from the user for this run: ${rest}` : 'No extra input from the user for this run.');
  return { task: parts.join('\n\n'), used: used.map(s => s.name) };
}
