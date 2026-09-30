// Scheduled runs: any chat task, /skill or /agent command, run automatically (once, hourly, daily,
// on weekdays or weekly) with chrome.alarms. Runs need Chrome to be open; a run that was missed while
// the computer was off happens at the next start if it's less than 12 hours late.

const KEY = 'schedules';
const PREFIX = 'dp-sched:';

export async function loadSchedules() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return Array.isArray(list) ? list : [];
}
async function save(list) { await chrome.storage.local.set({ [KEY]: list }); }

const pad = n => String(n).padStart(2, '0');
function at(date, hhmm) {
  const [h, m] = String(hhmm || '09:00').split(':').map(Number);
  const d = new Date(date); d.setHours(h || 0, m || 0, 0, 0); return d;
}

// Next run time (ms) strictly after `from`, in the computer's local time zone.
export function nextRun(s, from = Date.now()) {
  if (!s.enabled) return null;
  const now = new Date(from);
  if (s.repeat === 'once') { const t = new Date(s.onceAt).getTime(); return t > from ? t : null; }
  if (s.repeat === 'hourly') {
    const d = new Date(from); d.setMinutes(Number(s.minute) || 0, 0, 0);
    if (d.getTime() <= from) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  for (let i = 0; i < 8; i++) {
    const d = at(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i), s.time);
    if (d.getTime() <= from) continue;
    const dow = d.getDay(); // 0 = Sunday
    if (s.repeat === 'weekdays' && (dow === 0 || dow === 6)) continue;
    if (s.repeat === 'weekly' && dow !== Number(s.day ?? 1)) continue;
    return d.getTime();
  }
  return null;
}

export function describe(s) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (s.repeat === 'once') return `once · ${new Date(s.onceAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (s.repeat === 'hourly') return `every hour at :${pad(Number(s.minute) || 0)}`;
  if (s.repeat === 'weekdays') return `weekdays at ${s.time}`;
  if (s.repeat === 'weekly') return `every ${days[Number(s.day ?? 1)]} at ${s.time}`;
  return `daily at ${s.time}`;
}

export async function saveSchedule(input) {
  const text = String(input.text || '').trim();
  if (!text) throw new Error('Write what DeepPilot should do (a task, /skill or /agent command).');
  const s = {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || text).trim().slice(0, 80),
    text: text.slice(0, 4000),
    repeat: ['once', 'hourly', 'daily', 'weekdays', 'weekly'].includes(input.repeat) ? input.repeat : 'daily',
    time: /^\d{1,2}:\d{2}$/.test(input.time || '') ? input.time : '09:00',
    minute: Math.min(59, Math.max(0, Number(input.minute) || 0)),
    day: Math.min(6, Math.max(0, Number(input.day ?? 1))),
    onceAt: input.onceAt || null,
    enabled: input.enabled !== false,
    lastRun: input.lastRun || null,
    lastConv: input.lastConv || null,
    createdAt: input.createdAt || Date.now(),
  };
  if (s.repeat === 'once' && !(new Date(s.onceAt).getTime() > Date.now())) throw new Error('Pick a date and time in the future.');
  const list = (await loadSchedules()).filter(x => x.id !== s.id);
  list.push(s);
  await save(list);
  await arm(s);
  return s;
}

export async function deleteSchedule(id) {
  await save((await loadSchedules()).filter(x => x.id !== id));
  await chrome.alarms.clear(PREFIX + id);
}

export async function markRun(id, convId) {
  const list = await loadSchedules();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  s.lastRun = Date.now();
  if (convId) s.lastConv = convId;
  if (s.repeat === 'once') s.enabled = false;
  await save(list);
  await arm(s);
  return s;
}

export async function arm(s) {
  await chrome.alarms.clear(PREFIX + s.id);
  const t = nextRun(s);
  if (t) await chrome.alarms.create(PREFIX + s.id, { when: t });
  return t;
}

// Re-create all alarms (after install/update/browser start) and catch up runs missed while Chrome was closed.
export async function rearmAll(runMissed) {
  const list = await loadSchedules();
  for (const s of list) {
    if (!s.enabled) { await chrome.alarms.clear(PREFIX + s.id); continue; }
    const prevDue = s.lastRun ? nextRun(s, s.lastRun) : null;
    if (runMissed && prevDue && prevDue < Date.now() && Date.now() - prevDue < 12 * 3600e3) runMissed(s);
    else await arm(s);
  }
}

export const alarmId = name => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null);
