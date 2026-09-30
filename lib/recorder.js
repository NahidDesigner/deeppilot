// High-accuracy voice input: record with MediaRecorder, transcribe with Whisper
// (Groq's free API by default, or any OpenAI-compatible /audio/transcriptions endpoint).

export function createRecorder({ onLevel = () => {}, maxSeconds = 300, onAutoStop = () => {} } = {}) {
  let stream = null, rec = null, chunks = [], actx = null, raf = null, timer = null, mime = '';

  function cleanup() {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    stream?.getTracks().forEach(t => t.stop());
    actx?.close().catch(() => {});
    stream = null; actx = null; rec = null;
    onLevel(0);
  }

  return {
    get recording() { return !!rec && rec.state === 'recording'; },
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
      chunks = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.start(250);
      // Live input level for the UI.
      actx = new AudioContext();
      const src = actx.createMediaStreamSource(stream);
      const an = actx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        raf = requestAnimationFrame(tick);
      };
      tick();
      timer = setTimeout(() => onAutoStop(), maxSeconds * 1000);
    },
    stop() {
      return new Promise(resolve => {
        if (!rec) return resolve(null);
        const r = rec;
        r.onstop = () => {
          const blob = new Blob(chunks, { type: (mime || 'audio/webm').split(';')[0] });
          cleanup();
          resolve(blob.size ? blob : null);
        };
        r.stop();
      });
    },
    cancel() {
      if (rec) { rec.onstop = null; try { rec.stop(); } catch (_) { /* already stopped */ } }
      cleanup();
    },
  };
}

export async function transcribe(blob, { url, key, model, language, prompt }) {
  const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
  const fd = new FormData();
  fd.append('file', blob, `speech.${ext}`);
  fd.append('model', model || 'whisper-large-v3');
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  if (language) fd.append('language', language);
  if (prompt) fd.append('prompt', prompt.slice(0, 800));
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Whisper API key was rejected. Check it in Settings → Voice input.');
    throw new Error(`Transcription failed (${res.status}): ${t.slice(0, 160)}`);
  }
  const j = await res.json();
  return String(j.text || '').trim();
}
