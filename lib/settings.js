import { PRICE_DEFAULTS } from './pricing.js';

export const DEFAULTS = {
  apiKey: '',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  maxSteps: 100,
  vision: true,
  smartVision: true,    // only send a screenshot when the page changes (saves tokens)
  confirmRisky: true,
  showCursor: true,
  autoParallel: true,  // let the agent split independent items across tabs by itself
  maxParallel: 4,
  // Sync (Chrome Sync: memory, skills, agents and settings follow your Google account)
  chromeSync: true,
  syncKeys: false,     // also sync API keys (off = keys stay on each computer)
  // View
  theme: 'light',
  conversational: true,
  showWorkflow: false,
  // Alerts
  soundDone: 'chime',
  soundAsk: 'alarm',
  soundError: 'siren',
  volume: 0.7,
  repeatAlarm: true,
  notify: true,
  // Voice
  voiceLang: 'en-US',
  voiceEngine: 'whisper',
  whisperKey: '',
  whisperUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
  whisperModel: 'whisper-large-v3',
  voiceWords: '',
  // Pricing (USD per 1M tokens, peak)
  ...PRICE_DEFAULTS,
  taskBudget: 0.05,
  // Cloud history (Supabase)
  supabaseUrl: '',
  supabaseKey: '',
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

const num = (v, d, min, max) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

export async function saveSettings(values) {
  const c = { ...(await loadSettings()), ...values };
  c.baseUrl = (c.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  c.model = (c.model || DEFAULTS.model).trim();
  c.apiKey = (c.apiKey || '').trim();
  c.maxSteps = Math.round(num(c.maxSteps, DEFAULTS.maxSteps, 5, 300));
  c.maxParallel = Math.round(num(c.maxParallel, DEFAULTS.maxParallel, 2, 10));
  c.volume = num(c.volume, DEFAULTS.volume, 0, 1);
  c.priceHit = num(c.priceHit, DEFAULTS.priceHit, 0, 1000);
  c.priceMiss = num(c.priceMiss, DEFAULTS.priceMiss, 0, 1000);
  c.priceOut = num(c.priceOut, DEFAULTS.priceOut, 0, 1000);
  c.taskBudget = num(c.taskBudget, DEFAULTS.taskBudget, 0.001, 1000);
  for (const k of ['vision', 'smartVision', 'confirmRisky', 'showCursor', 'autoParallel', 'chromeSync', 'syncKeys', 'conversational', 'showWorkflow', 'repeatAlarm', 'notify', 'offPeak']) c[k] = !!c[k];
  c.supabaseUrl = (c.supabaseUrl || '').trim().replace(/\/+$/, '');
  c.supabaseKey = (c.supabaseKey || '').trim();
  c.whisperKey = (c.whisperKey || '').trim();
  c.whisperUrl = (c.whisperUrl || DEFAULTS.whisperUrl).trim();
  c.whisperModel = (c.whisperModel || DEFAULTS.whisperModel).trim();
  c.voiceEngine = c.voiceEngine === 'chrome' ? 'chrome' : 'whisper';
  c.theme = ['dark', 'light', 'auto'].includes(c.theme) ? c.theme : 'light';
  await chrome.storage.local.set(c);
  return c;
}
