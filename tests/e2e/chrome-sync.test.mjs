import './_setup.mjs';
import { fileURLToPath } from 'node:url';
// Chrome Sync between two "computers" (two profiles). The test plays the role of Chrome's sync server
// by copying the dp1| records from one profile's chrome.storage.sync to the other's.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function open(name) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-' + name)), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/permission.html`);
  return { ctx, p, id };
}
const dump = p => p.evaluate(async () => { const a = await chrome.storage.sync.get(null); return Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith('dp1|'))); });
// "Chrome sync": make B's dp1 records identical to A's
const transfer = async (from, to) => { const d = await dump(from.p); await to.p.evaluate(async d => { const cur = Object.keys(await chrome.storage.sync.get(null)).filter(k => k.startsWith('dp1|') && !(k in d)); if (cur.length) await chrome.storage.sync.remove(cur); await chrome.storage.sync.set(d); }, d); await sleep(2500); };
const local = p => p.evaluate(async () => { const d = await chrome.storage.local.get(['memories', 'skills', 'agents', 'apiKey', 'theme', 'maxParallel', 'syncStatus']); return { mem: (d.memories || []).map(m => `m${m.id}:${m.text}`), skills: (d.skills || []).map(s => s.name + ':' + s.instructions.slice(0, 20)), agents: (d.agents || []).map(a => a.name + ':' + a.stages.length + ':' + a.stages[0].instructions.length), apiKey: d.apiKey || '', theme: d.theme, maxParallel: d.maxParallel, status: d.syncStatus }; });

const A = await open('A'), Bc = await open('B');
const out = { idA: A.id, idB: Bc.id, sameId: A.id === Bc.id, fixed: A.id === 'hdcnglpkoadmkcnjmejcckcpjjbpofjn' };
// PC A: create data through the real modules
await A.p.evaluate(async () => {
  const { addMemory } = await import('./lib/memory.js'); const { saveSkill } = await import('./lib/skills.js'); const { saveAgent } = await import('./lib/agents.js'); const { saveSettings } = await import('./lib/settings.js');
  await addMemory('My welcome template: Hi {first}, thanks for connecting!');
  await addMemory('Bengali test: আমার নাম নাহিদ');
  await saveSkill({ name: 'daily-report', description: 'x', instructions: 'Open analytics and summarise yesterday' });
  await saveAgent({ title: 'Big Agent', stages: [{ title: 'S1', instructions: 'এটি একটি দীর্ঘ নির্দেশনা। '.repeat(500) }, { title: 'S2', instructions: 'do more', forEach: true }] });
  await saveSettings({ apiKey: 'sk-A-secret', theme: 'dark', maxParallel: 6 });
});
await sleep(3500);
const dA = await dump(A.p);
out.syncKeysA = Object.keys(dA).map(k => k.replace(/\|[0-9a-f-]{36}/, '|<uid>'));
out.chunked = Object.keys(dA).filter(k => k.includes('~')).length;
out.secretInSync = JSON.stringify(dA).includes('sk-A-secret');
out.statusA = (await local(A.p)).status;
// PC B has its own memory + key already
await Bc.p.evaluate(async () => { const { addMemory } = await import('./lib/memory.js'); const { saveSettings } = await import('./lib/settings.js'); await addMemory('B-only memory'); await saveSettings({ apiKey: 'sk-B-own' }); });
await sleep(2500);
// Chrome sync delivers A's data to B (merge: B's own memory must survive and be pushed)
const bBefore = await dump(Bc.p);
await Bc.p.evaluate(async d => { await chrome.storage.sync.set(d); }, dA); await sleep(3000);
out.B_afterFirstSync = await local(Bc.p);
// B edits + deletes
await Bc.p.evaluate(async () => {
  const { loadMemories, updateMemory } = await import('./lib/memory.js'); const { loadSkills, deleteSkill, saveSkill } = await import('./lib/skills.js');
  const m = (await loadMemories()).find(x => x.text.startsWith('My welcome'));
  await updateMemory(m.id, 'My welcome template v2: Hello {first}!');
  await deleteSkill((await loadSkills()).find(s => s.name === 'daily-report').id);
  await saveSkill({ name: 'from-b', instructions: 'made on PC B' });
});
await sleep(3000);
await transfer(Bc, A);
out.A_afterBChanges = await local(A.p);
// keys sync opt-in on A
await A.p.evaluate(async () => { const { saveSettings } = await import('./lib/settings.js'); await saveSettings({ syncKeys: true }); });
await sleep(3000);
await transfer(A, Bc);
out.B_keyAfterOptIn = (await local(Bc.p)).apiKey;
// UI renders status
await A.p.goto(`chrome-extension://${A.id}/sidepanel.html?tab=1`); await sleep(800);
await A.p.click('#settingsBtn'); await sleep(400);
out.ui = { text: await A.p.textContent('#syncText'), chromeSyncChecked: await A.p.isChecked('#s_chromeSync'), meterTitle: await A.p.getAttribute('.sync-meter', 'title') };
await A.p.click('#syncNow'); await sleep(1200); out.ui.after = await A.p.textContent('#syncMsg');
await A.p.locator('#syncSection').screenshot({ path: 'sync-ui.png' });
// backup round trip
const [dl] = await Promise.all([A.p.waitForEvent('download'), A.p.click('#backupExport')]);
const file = await dl.path(); const bk = JSON.parse(fs.readFileSync(file, 'utf8'));
out.backup = { mem: bk.memories.length, skills: bk.skills.length, agents: bk.agents.length, hasKey: JSON.stringify(bk).includes('sk-') };
console.log(JSON.stringify(out, null, 1));
await A.ctx.close(); await Bc.ctx.close();
