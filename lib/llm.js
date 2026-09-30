// OpenAI-compatible chat client for the DeepSeek API (streaming + non-streaming).
// Streaming is used by the agent: the first bytes arrive quickly, which keeps the
// extension's background service worker alive during long model calls.

export class ApiError extends Error {
  constructor(status, body) {
    super(`API error ${status}: ${String(body).slice(0, 500)}`);
    this.status = status;
    this.body = String(body);
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

let streamUsageUnsupported = false;

async function readStream(res, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const msg = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let usage = null, finishReason = null, buf = '';
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // keep-alive comments etc.
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch (_) { continue; }
        if (j.usage) usage = j.usage;
        const ch = j.choices && j.choices[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch.delta || {};
        if (d.content) msg.content += d.content;
        if (d.reasoning_content) msg.reasoning_content += d.reasoning_content;
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? msg.tool_calls.length;
          const slot = msg.tool_calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  msg.tool_calls = msg.tool_calls.filter(Boolean).map((t, i) => ({ ...t, id: t.id || `call_${Date.now()}_${i}` }));
  if (!msg.tool_calls.length) delete msg.tool_calls;
  if (!msg.reasoning_content) delete msg.reasoning_content;
  return { message: msg, usage, finishReason };
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, tools, signal, maxTokens = 8192, stream = false }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const build = () => {
    const body = { model, messages, max_tokens: maxTokens, stream };
    if (stream && !streamUsageUnsupported) body.stream_options = { include_usage: true };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    return JSON.stringify(body);
  };

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: stream ? 'text/event-stream' : 'application/json' },
        body: build(),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = new Error(`Network error: ${e.message}`);
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }
    if (res.ok) {
      const ctype = res.headers.get('content-type') || '';
      if (stream && ctype.includes('event-stream')) return readStream(res, signal);
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      if (!choice || !choice.message) throw new Error('API returned no message.');
      return { message: choice.message, usage: data.usage || null, finishReason: choice.finish_reason };
    }
    const text = await res.text();
    lastErr = new ApiError(res.status, text);
    if (res.status === 400 && stream && !streamUsageUnsupported && /stream_options/i.test(text)) {
      streamUsageUnsupported = true;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * 2 ** attempt, signal);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}
