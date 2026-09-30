// Agents: saved multi-stage workflows (e.g. a "lead hunter") that run stage by stage until done.
import { slugify } from './skills.js';

const KEY = 'agents';

export async function loadAgents() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return (Array.isArray(list) ? list : []).sort((a, b) => a.name.localeCompare(b.name));
}
async function save(list) { await chrome.storage.local.set({ [KEY]: list }); }

// How many browser tabs a "for each item" stage may use at the same time.
export const DEFAULT_PARALLEL = 4;
export function clampParallel(v) {
  const n = Math.round(Number(v ?? DEFAULT_PARALLEL));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : DEFAULT_PARALLEL;
}

export function normalizeAgent(a) {
  const name = slugify(a.name || a.title);
  if (!name) throw new Error('Give the agent a name.');
  const stages = (a.stages || []).map(s => ({
    id: s.id || crypto.randomUUID(),
    title: String(s.title || '').trim().slice(0, 120) || 'Stage',
    instructions: String(s.instructions || '').trim().slice(0, 6000),
    forEach: !!s.forEach,
    sequential: !!s.sequential,
    doneWhen: String(s.doneWhen || '').trim().slice(0, 600),
  })).filter(s => s.instructions);
  if (!stages.length) throw new Error('Add at least one stage with instructions.');
  const inputs = (a.inputs || []).map(i => ({ name: slugify(i.name).replace(/-/g, '_'), default: String(i.default ?? '').slice(0, 300) })).filter(i => i.name);
  return {
    id: a.id || crypto.randomUUID(),
    name,
    title: String(a.title || a.name).trim().slice(0, 80),
    description: String(a.description || '').trim().slice(0, 2000),
    rules: String(a.rules || '').trim().slice(0, 4000),
    inputs,
    stages,
    maxCost: Math.max(0, Number(a.maxCost) || 0),
    parallel: clampParallel(a.parallel),
    maxStepsPerStage: Math.min(300, Math.max(5, Number(a.maxStepsPerStage) || 60)),
    createdAt: a.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

export async function saveAgent(a) {
  const agent = normalizeAgent(a);
  const list = await loadAgents();
  const clash = list.find(x => x.name === agent.name && x.id !== agent.id);
  if (clash) throw new Error(`An agent named /${agent.name} already exists.`);
  const i = list.findIndex(x => x.id === agent.id);
  if (i >= 0) list[i] = { ...agent, createdAt: list[i].createdAt }; else list.push(agent);
  await save(list);
  return agent;
}

export async function deleteAgent(id) { await save((await loadAgents()).filter(a => a.id !== id)); }

export async function importAgents(json) {
  const data = JSON.parse(json);
  const arr = Array.isArray(data) ? data : data.agents;
  if (!Array.isArray(arr)) throw new Error('Not a DeepPilot agents file.');
  const list = await loadAgents();
  let n = 0;
  for (const a of arr) {
    try {
      const ag = normalizeAgent({ ...a, id: undefined });
      if (list.some(x => x.name === ag.name)) ag.name = `${ag.name}-${Math.random().toString(36).slice(2, 5)}`;
      list.push(ag);
      n++;
    } catch (_) { /* skip invalid */ }
  }
  await save(list);
  return n;
}

// "city=Dallas count=10 please focus on older sites" → { inputs: {city, count}, extra: 'please focus…' }
export function parseInputs(text, agent) {
  const inputs = {};
  let extra = String(text || '');
  extra = extra.replace(/(\w+)=("[^"]*"|'[^']*'|\S+)/g, (m, k, v) => {
    inputs[k.toLowerCase()] = v.replace(/^["']|["']$/g, '');
    return '';
  }).trim();
  for (const i of agent.inputs || []) if (!(i.name in inputs) && i.default) inputs[i.name] = i.default;
  return { inputs, extra };
}

export const EXAMPLE_LEAD_HUNTER = {
  name: 'lead-hunter',
  title: 'Lead Hunter',
  description: 'Find local businesses with weak websites, audit each site, and deliver a lead list with audit findings as Excel + PDF.',
  rules: '- Only collect public business information.\n- Never send messages, emails or form submissions.\n- Leave a field empty rather than guessing.\n- Keep a short, friendly progress note after each lead.',
  inputs: [{ name: 'niche', default: 'HVAC' }, { name: 'city', default: 'Houston, TX' }, { name: 'count', default: '10' }],
  maxCost: 0.5,
  maxStepsPerStage: 60,
  parallel: 4,
  stages: [
    {
      title: 'Find leads on Google Maps',
      instructions: 'Search Google Maps for "{niche} in {city}". Collect {count} businesses that have a website and at least 4.0 stars. For each: company name, website URL, phone, Google Maps URL, rating, number of reviews. Use get_links with filter "/maps/place/" to get listing URLs, open listings for details. Then call save_items with the list (one object per business).',
      forEach: false,
      doneWhen: 'save_items was called with {count} businesses (or as many as exist).',
    },
    {
      title: 'Audit each website',
      instructions: 'For the CURRENT ITEM: open its website. Find a contact email (check the contact page; get_page_text returns emails). Then open https://pagespeed.web.dev/analysis?url=<website> , wait until the mobile results load (use wait repeatedly), and read the Performance, Accessibility, Best Practices and SEO scores. Also note 2 visible website weaknesses (e.g. slow, no clear call-to-action, outdated design, no reviews shown, broken elements). Call record_result with: name, website, email, phone, maps_url, rating, reviews, mobile_performance, accessibility, best_practices, seo, weaknesses.',
      forEach: true,
      doneWhen: 'record_result was called for this business.',
    },
    {
      title: 'Build the deliverables',
      instructions: 'Using ALL results recorded so far, create "{niche}-{city}-leads.xlsx" (one row per business, all fields as columns, sorted by lowest mobile performance first) and a 1–2 page "{niche}-{city}-audit-report.pdf" with a title, short intro, a table (name, email, performance, SEO, top weakness) and 3 recommendations. Use create_file for both.',
      forEach: false,
      doneWhen: 'Both files were created.',
    },
    {
      title: 'Summary',
      instructions: 'Call done with a short summary: how many leads, how many have an email, the 3 weakest websites and why, and the names of the files created.',
      forEach: false,
      doneWhen: 'Summary delivered.',
    },
  ],
};

export const DRAFT_SYSTEM_PROMPT = `You design multi-stage browser automation agents for DeepPilot, an AI that controls the user's Chrome (they are already logged into their sites).
Return ONLY a JSON object, no prose, with this shape:
{"title": "...", "name": "short-dash-name", "description": "...", "rules": "- rule\\n- rule", "inputs": [{"name": "city", "default": "Houston, TX"}],
 "stages": [{"title": "...", "instructions": "...", "forEach": false, "sequential": false, "doneWhen": "..."}], "maxCost": 0.5, "parallel": 4}
Guidelines:
- 3–7 stages in logical order. Each stage's instructions must be concrete: which site/URL to open, what to collect, what to click, what to save.
- Use {input_name} placeholders for inputs.
- A stage that finds a list of things must end with "call save_items with the list".
- A stage that processes each thing from that list must have "forEach": true, work on the CURRENT ITEM only, and end with "call record_result with ..." listing the fields.
- forEach stages run up to "parallel" items at once, each in its own tab (1–10, default 4). Set "sequential": true on a forEach stage that must go one item at a time (sending messages, posting, anything on LinkedIn/Facebook/Instagram or a logged-in account).
- A stage that produces files must say which files (xlsx/csv/pdf/docx) via create_file and what goes in them.
- Rules: safety and quality constraints (e.g. never send messages unless asked).`;
