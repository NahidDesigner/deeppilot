// Hidden helper page for the background engine: plays alert sounds and builds binary files
// (XLSX / PDF / DOCX need DOM-era libraries that can't run in a service worker).
import { makeBlob } from './lib/files.js';
import { ring, stopAlarm, playOnce, isRinging, onRinging } from './lib/sound.js';

const toDataUrl = blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });

onRinging(on => { chrome.runtime.sendMessage({ target: 'engine', cmd: 'ringing', on }).catch(() => {}); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      if (msg.cmd === 'build') sendResponse({ ok: true, dataUrl: await toDataUrl(await makeBlob(msg.file)) });
      else if (msg.cmd === 'pdftext') {
        const { pdfToText } = await import('./lib/pdftext.js');
        let buf;
        if (msg.dataUrl) buf = await (await fetch(msg.dataUrl)).arrayBuffer();
        else {
          const r = await fetch(msg.url, { credentials: 'include' });
          if (!r.ok) throw new Error(`Could not download the PDF (HTTP ${r.status}).`);
          buf = await r.arrayBuffer();
        }
        sendResponse({ ok: true, ...(await pdfToText(buf, { maxChars: msg.maxChars || 60000, fromPage: msg.fromPage || 1 })) });
      }
      else if (msg.cmd === 'ring') { ring(msg.sound, { volume: msg.volume, repeat: msg.repeat }); sendResponse({ ok: true }); }
      else if (msg.cmd === 'play') { playOnce(msg.sound, msg.volume); sendResponse({ ok: true }); }
      else if (msg.cmd === 'stop') { stopAlarm(); sendResponse({ ok: true }); }
      else if (msg.cmd === 'ping') sendResponse({ ok: true, ringing: isRinging() });
      else sendResponse({ ok: false, error: 'unknown command' });
    } catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
  })();
  return true;
});
