// Optional cloud history using Supabase (free tier works). Each user signs in with email + password;
// row-level security makes sure people only see their own conversations. See supabase.sql.

const SESSION_KEY = 'cloudSession';

let cfg = { url: '', key: '' };
export function configure(url, key) { cfg = { url: (url || '').trim().replace(/\/+$/, ''), key: (key || '').trim() }; }
export const isConfigured = () => !!(cfg.url && cfg.key);

async function authCall(path, body) {
  const res = await fetch(`${cfg.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || `Auth error ${res.status}`);
  return data;
}

async function storeSession(data) {
  if (!data.access_token) return null;
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    user: { id: data.user?.id, email: data.user?.email },
  };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

export async function signUp(email, password) {
  const data = await authCall('signup', { email, password });
  const s = await storeSession(data);
  if (!s) return { needsConfirm: true };
  return { session: s };
}

export async function signIn(email, password) {
  const data = await authCall('token?grant_type=password', { email, password });
  return storeSession(data);
}

export async function signOut() {
  await chrome.storage.local.remove(SESSION_KEY);
}

export async function getSession() {
  const { [SESSION_KEY]: s } = await chrome.storage.local.get(SESSION_KEY);
  if (!s || !isConfigured()) return null;
  if (Date.now() < s.expires_at - 60000) return s;
  try {
    return await storeSession(await authCall('token?grant_type=refresh_token', { refresh_token: s.refresh_token }));
  } catch (_) {
    await signOut();
    return null;
  }
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const s = await getSession();
  if (!s) throw new Error('Not signed in to cloud history.');
  const headers = { apikey: cfg.key, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`Cloud error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const TABLE = 'dp_conversations';

export async function upsertConversation(conv) {
  const row = {
    id: conv.id, title: conv.title, status: conv.status,
    created_at: new Date(conv.createdAt).toISOString(), updated_at: new Date(conv.updatedAt).toISOString(),
    usage: conv.usage, events: conv.events,
    // Big images stay local only (keeps the cloud row small).
    files: (conv.files || []).map(f => (f.dataUrl && f.dataUrl.length > 2_500_000 ? { ...f, dataUrl: null, localOnly: true } : f)),
  };
  await rest(`${TABLE}?on_conflict=id`, { method: 'POST', body: [row], prefer: 'resolution=merge-duplicates,return=minimal' });
}

export async function listCloud() {
  const rows = await rest(`${TABLE}?select=id,title,status,created_at,updated_at,usage&order=updated_at.desc&limit=200`);
  return (rows || []).map(r => ({
    id: r.id, title: r.title, status: r.status, usage: r.usage,
    createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at), cloud: true,
  }));
}

export async function getCloud(id) {
  const rows = await rest(`${TABLE}?id=eq.${encodeURIComponent(id)}&select=*`);
  const r = rows && rows[0];
  if (!r) return null;
  return {
    id: r.id, title: r.title, status: r.status, usage: r.usage || {}, events: r.events || [], files: r.files || [],
    createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at), synced: true,
  };
}

export async function deleteCloud(id) {
  await rest(`${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}
