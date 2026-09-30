// Read the text of a PDF with Mozilla's PDF.js (vendor/pdfjs, Apache-2.0). Runs in extension pages
// (side panel, offscreen document) — not in the service worker, which can't load module workers.
let lib = null;
async function pdfjs() {
  if (lib) return lib;
  lib = await import(chrome.runtime.getURL('vendor/pdfjs/pdf.min.mjs'));
  lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
  return lib;
}

// data: ArrayBuffer / Uint8Array. Returns { text, pages, truncated }.
export async function pdfToText(data, { maxChars = 200000, fromPage = 1 } = {}) {
  const pj = await pdfjs();
  const doc = await pj.getDocument({ data: data instanceof Uint8Array ? data : new Uint8Array(data), isEvalSupported: false, useSystemFonts: false }).promise;
  let out = '';
  let last = fromPage - 1;
  for (let i = Math.max(1, fromPage); i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    let prevY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (prevY !== null && y !== null && Math.abs(y - prevY) > 2 && !text.endsWith('\n')) text += '\n';
      else if (text && !text.endsWith('\n') && !text.endsWith(' ') && it.str && !it.str.startsWith(' ')) text += ' ';
      text += it.str;
      if (it.hasEOL) text += '\n';
      prevY = y;
    }
    out += `\n--- Page ${i} of ${doc.numPages} ---\n${text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
    last = i;
    page.cleanup();
    if (out.length >= maxChars) break;
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { text: out.slice(0, maxChars).trim(), pages, lastPage: last, truncated: last < pages || out.length > maxChars };
}
