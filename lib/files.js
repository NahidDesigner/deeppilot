// File generation: turns the agent's text output into downloadable files.
// Text formats are saved as-is. XLSX / PDF / DOCX are built from CSV/JSON (tables) or Markdown (documents)
// using the bundled libraries in /vendor (loaded as globals by sidepanel.html).
// Files are stored by their SOURCE text, so history (local + cloud) stays small and JSON-friendly;
// binary files are regenerated on download.

const MIME = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml', js: 'text/javascript', css: 'text/css',
  py: 'text/x-python', vcf: 'text/vcard', ics: 'text/calendar', yaml: 'text/yaml', yml: 'text/yaml', sql: 'application/sql',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const extOf = name => (String(name).split('.').pop() || '').toLowerCase();
export const mimeOf = name => MIME[extOf(name)] || 'text/plain';
export const isBinary = name => ['xlsx', 'pdf', 'docx'].includes(extOf(name));

export function safeName(name) {
  let n = String(name || 'result.txt').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 120);
  if (!n.includes('.')) n += '.txt';
  return n;
}

// ---------- tables ----------
export function parseCSV(text, delim) {
  const src = String(text).replace(/^﻿/, '');
  if (!delim) {
    const first = src.split('\n')[0] || '';
    delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  }
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

// Accepts CSV/TSV, a JSON array of objects/arrays, or a JSON object of sheets { "Sheet": [...] }.
export function parseSheets(content) {
  const t = String(content).trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const toRows = arr => {
        if (!Array.isArray(arr) || !arr.length) return [];
        if (Array.isArray(arr[0])) return arr.map(r => r.map(v => v ?? ''));
        const cols = [...new Set(arr.flatMap(o => Object.keys(o || {})))];
        return [cols, ...arr.map(o => cols.map(c => (o && o[c] != null ? (typeof o[c] === 'object' ? JSON.stringify(o[c]) : o[c]) : '')))];
      };
      if (Array.isArray(j)) return [{ name: 'Sheet1', rows: toRows(j) }];
      return Object.entries(j).map(([name, arr]) => ({ name: name.slice(0, 31), rows: toRows(arr) }));
    } catch (_) { /* fall through to CSV */ }
  }
  return [{ name: 'Sheet1', rows: parseCSV(t) }];
}

function buildXlsx(content) {
  const XLSX = globalThis.XLSX;
  if (!XLSX) throw new Error('Excel library not loaded.');
  const wb = XLSX.utils.book_new();
  for (const s of parseSheets(content)) {
    if (!s.rows.length) throw new Error('No table rows found. Give CSV text or a JSON array.');
    const rows = s.rows.map(r => r.map(v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim().length < 15 && !/^0\d/.test(v.trim()) ? Number(v) : v)));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, ci) => ({ wch: Math.min(60, Math.max(8, ...rows.map(r => String(r[ci] ?? '').length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, s.name || 'Sheet1');
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: MIME.xlsx });
}

// ---------- markdown → blocks ----------
export function parseMarkdown(md) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  // Lines of one paragraph are joined with a space, except after a Markdown hard break (two trailing
  // spaces or a backslash) and before "**Label:** value" lines, which keep their own line.
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.map((l, k) => (k === 0 ? '' : (para[k - 1].br || /^\*\*[^*]+:\*\*/.test(l.text) ? '\n' : ' ')) + l.text).join('') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tr = line.trim();
    if (tr.startsWith('```')) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      blocks.push({ t: 'code', text: code.join('\n') });
      continue;
    }
    if (!tr) { flush(); continue; }
    let m;
    if ((m = tr.match(/^(#{1,6})\s+(.*)$/))) { flush(); blocks.push({ t: 'h', level: m[1].length, text: m[2] }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(tr)) { flush(); blocks.push({ t: 'hr' }); continue; }
    if (tr.startsWith('|')) {
      flush();
      const tl = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) tl.push(lines[i++].trim());
      i--;
      const rows = tl.filter(l => !/^\|?(\s*:?-{2,}:?\s*\|)+\s*(:?-{2,}:?\s*)?$/.test(l))
        .map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      blocks.push({ t: 'table', rows });
      continue;
    }
    if ((m = tr.match(/^[-*•]\s+(.*)$/))) { flush(); blocks.push({ t: 'li', text: m[1] }); continue; }
    if ((m = tr.match(/^(\d+)[.)]\s+(.*)$/))) { flush(); blocks.push({ t: 'oli', n: m[1], text: m[2] }); continue; }
    if ((m = tr.match(/^>\s?(.*)$/))) { flush(); blocks.push({ t: 'quote', text: m[1] }); continue; }
    para.push({ text: tr.replace(/\\$/, ''), br: / {2,}$/.test(line) || /\\$/.test(tr) });
  }
  flush();
  return blocks;
}

const plain = s => String(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

// ---------- PDF ----------
// Designed output: a navy title band, accent headings, Geist font (so —, ≤, →, €, ₹ render correctly),
// rich **bold** text, styled tables with zebra rows, callout quotes, and "Page x of y" footers.
const C = { navy: [15, 21, 34], ink: [28, 35, 51], muted: [98, 108, 128], faint: [150, 158, 175], accent: [184, 224, 74], line: [226, 230, 237], zebra: [246, 248, 251], tint: [244, 248, 234] };
const SWAP = { '✓': '√', '✔': '√', '✗': '×', '✘': '×', '★': '●', '☆': '○', '■': '●', '□': '○', '▪': '•', '►': '▶', '◆': '●', '৳': 'Tk ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '' };
const pdfText = s => String(s ?? '').replace(/[✓✔✗✘★☆■□▪►◆৳   ​]/g, ch => SWAP[ch])
  .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')        // emoji & joiners
  .replace(/[^\x09\x0a\x20-\x7e\xa0-ɏ -⁯₠-₿℀-⋿■-◿✀-➿]/g, '');
const inline = s => pdfText(String(s).replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1$2').replace(/__(.+?)__/g, '$1'));

let pdfFonts = null;
async function loadPdfFonts() {
  if (pdfFonts !== null) return pdfFonts;
  try {
    const get = async f => {
      const buf = new Uint8Array(await (await fetch(chrome.runtime.getURL('fonts/' + f))).arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    pdfFonts = { regular: await get('Geist-PDF-Regular.ttf'), bold: await get('Geist-PDF-Bold.ttf') };
  } catch (_) { pdfFonts = false; } // fall back to Helvetica
  return pdfFonts;
}

async function buildPdf(content, title) {
  const J = globalThis.jspdf && globalThis.jspdf.jsPDF;
  if (!J) throw new Error('PDF library not loaded.');
  const doc = new J({ unit: 'mm', format: 'a4' });
  const fonts = await loadPdfFonts();
  let FONT = 'helvetica';
  if (fonts) {
    doc.addFileToVFS('Geist-Regular.ttf', fonts.regular); doc.addFont('Geist-Regular.ttf', 'Geist', 'normal');
    doc.addFileToVFS('Geist-Bold.ttf', fonts.bold); doc.addFont('Geist-Bold.ttf', 'Geist', 'bold');
    FONT = 'Geist';
  }
  const clean = fonts ? inline : s => plain(s).replace(/[^\x20-\x7e\xa0-\xff–—‘’“”•…€]/g, '');
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 18, BOTTOM = H - 18;
  const TW = W - 2 * M;
  let y = M;
  const color = c => doc.setTextColor(...c);
  const font = (style, size) => { doc.setFont(FONT, style); doc.setFontSize(size); };
  const need = h => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };

  // Rich text: **bold** segments, wrapped by measured width.
  const layout = (text, size, maxW, baseBold = false) => {
    if (String(text).includes('\n')) return String(text).split('\n').flatMap(t => layout(t, size, maxW, baseBold));
    const parts = String(text).split('**');
    const balanced = parts.length % 2 === 1;
    const words = [];
    parts.forEach((p, i) => { const b = baseBold || (balanced && i % 2 === 1); for (const w of clean(p).split(/(\s+)/)) if (w) words.push({ w: /^\s+$/.test(w) ? ' ' : w, b }); });
    const lines = []; let cur = [], width = 0;
    const measure = t => { font(t.b ? 'bold' : 'normal', size); return doc.getTextWidth(t.w); };
    for (let t of words) {
      if (t.w === ' ' && !cur.length) continue;
      let tw = measure(t);
      if (t.w !== ' ' && tw > maxW) { // a very long word/URL: break it
        let chunk = '';
        for (const ch of t.w) { const nx = chunk + ch; font(t.b ? 'bold' : 'normal', size); if (doc.getTextWidth(nx) > maxW - width && chunk) { cur.push({ w: chunk, b: t.b }); lines.push(cur); cur = []; width = 0; chunk = ch; } else chunk = nx; }
        t = { w: chunk, b: t.b }; tw = measure(t);
      }
      if (width + tw > maxW && cur.length) { while (cur.length && cur[cur.length - 1].w === ' ') cur.pop(); lines.push(cur); cur = []; width = 0; if (t.w === ' ') continue; }
      cur.push(t); width += tw;
    }
    if (cur.length) lines.push(cur);
    return lines;
  };
  const drawLines = (lines, size, x, c = C.ink, lead = 1.5) => {
    const lh = size * 0.3528 * lead;
    for (const ln of lines) {
      need(lh); color(c);
      let cx = x;
      for (const t of ln) { font(t.b ? 'bold' : 'normal', size); doc.text(t.w, cx, y + lh * 0.72); cx += doc.getTextWidth(t.w); }
      y += lh;
    }
  };
  const para = (text, { size = 10, indent = 0, c = C.ink, gap = 2.4, bold = false } = {}) => { drawLines(layout(text, size, TW - indent, bold), size, M + indent, c); y += gap; };

  let blocks = parseMarkdown(content);
  if (!blocks.some(b => b.t !== 'p') && /,|\t/.test(content) && content.includes('\n')) { // CSV/JSON → table
    blocks = [{ t: 'h', level: 1, text: title }, { t: 'table', rows: parseSheets(content)[0].rows }];
  }
  // Title band from the first heading (+ a short first paragraph as subtitle).
  let docTitle = title;
  if (blocks[0]?.t === 'h') {
    docTitle = clean(plain(blocks[0].text));
    const sub = blocks[1]?.t === 'p' && plain(blocks[1].text).length <= 180 ? blocks[1] : null;
    blocks = blocks.slice(sub ? 2 : 1);
    const tl = layout(docTitle, 22, TW, true), sl = sub ? layout(sub.text, 11, TW) : [];
    const bandH = 16 + tl.length * 9.3 + (sl.length ? 3 + sl.length * 5.8 : 0) + 8;
    doc.setFillColor(...C.navy); doc.rect(0, 0, W, bandH, 'F');
    doc.setFillColor(...C.accent); doc.rect(M, bandH - 2.2, 26, 2.2, 'F');
    y = 15;
    drawLines(tl, 22, M, [255, 255, 255], 1.2);
    if (sl.length) { y += 3; drawLines(sl, 11, M, [196, 206, 222], 1.5); }
    y = bandH + 10;
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t === 'h') {
      const size = [0, 17, 14, 11.5, 10.5, 10, 10][b.level];
      const lines = layout(b.text, size, TW - (b.level <= 2 ? 5 : 0), true);
      need(size * 0.53 * lines.length + 14); // keep headings with what follows
      y += b.level <= 2 ? 5 : 2.5;
      if (b.level <= 2) { doc.setFillColor(...C.accent); doc.rect(M, y + 1.2, 2, size * 0.36, 'F'); }
      drawLines(lines, size, M + (b.level <= 2 ? 5 : 0), b.level <= 2 ? C.navy : C.ink, 1.25);
      y += b.level <= 2 ? 2.5 : 1.5;
    } else if (b.t === 'p') para(b.text);
    else if (b.t === 'li' || b.t === 'oli') {
      const lines = layout(b.text, 10, TW - 7);
      need(5);
      if (b.t === 'li') { doc.setFillColor(...C.navy); doc.circle(M + 2, y + 2.55, 0.8, 'F'); }
      else { font('bold', 10); color(C.navy); doc.text(`${b.n}.`, M, y + 3.8); }
      drawLines(lines, 10, M + 7);
      y += (blocks[i + 1]?.t === 'li' || blocks[i + 1]?.t === 'oli') ? 1 : 3;
    } else if (b.t === 'quote') {
      const lines = layout(b.text, 10, TW - 12);
      const h = lines.length * 5.3 + 6;
      need(h);
      doc.setFillColor(...C.tint); doc.rect(M, y, TW, h, 'F');
      doc.setFillColor(...C.accent); doc.rect(M, y, 1.6, h, 'F');
      y += 3; drawLines(lines, 10, M + 7, C.ink); y += 6;
    } else if (b.t === 'code') {
      const lines = String(b.text).split('\n');
      const h = lines.length * 4.4 + 6;
      need(Math.min(h, 60));
      doc.setFillColor(...C.zebra); doc.rect(M, y, TW, h, 'F');
      doc.setFont('courier', 'normal'); doc.setFontSize(8.5); color(C.ink);
      y += 4; for (const l of lines) { need(4.4); doc.text(l.slice(0, 110), M + 4, y + 2.5); y += 4.4; } y += 4;
    } else if (b.t === 'hr') { need(6); doc.setDrawColor(...C.line); doc.setLineWidth(0.3); doc.line(M, y + 2, W - M, y + 2); y += 6; }
    else if (b.t === 'table' && b.rows.length) {
      if (typeof doc.autoTable !== 'function') throw new Error('PDF table plugin not loaded.');
      need(20);
      doc.autoTable({
        head: [b.rows[0].map(c => clean(plain(c)))], body: b.rows.slice(1).map(r => r.map(c => clean(plain(c)))), startY: y + 1,
        margin: { left: M, right: M, bottom: 22 }, theme: 'plain',
        styles: { font: FONT, fontSize: 8.8, cellPadding: { top: 2.4, bottom: 2.4, left: 3, right: 3 }, textColor: C.ink, lineColor: C.line, lineWidth: { bottom: 0.2 }, overflow: 'linebreak' },
        headStyles: { font: FONT, fontStyle: 'bold', fillColor: C.navy, textColor: [255, 255, 255], lineWidth: 0 },
        alternateRowStyles: { fillColor: C.zebra },
      });
      y = doc.lastAutoTable.finalY + 6;
    }
  }
  // Footer on every page: title · Page x of y
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...C.line); doc.setLineWidth(0.3); doc.line(M, H - 12, W - M, H - 12);
    font('normal', 8); color(C.faint);
    const ft = clean(plain(docTitle || '')).slice(0, 90);
    if (ft) doc.text(ft, M, H - 7.5);
    const pg = `Page ${p} of ${pages}`;
    doc.text(pg, W - M - doc.getTextWidth(pg), H - 7.5);
  }
  return doc.output('blob');
}

// ---------- DOCX ----------
const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runs(text, extra = '') {
  // Supports **bold**, *italic* and `code` inline.
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).filter(Boolean);
  return parts.map(p => {
    let rp = extra, t = p;
    if (/^\*\*.+\*\*$/.test(p)) { rp += '<w:b/>'; t = p.slice(2, -2); }
    else if (/^`.+`$/.test(p)) { rp += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'; t = p.slice(1, -1); }
    else if (/^\*.+\*$/.test(p)) { rp += '<w:i/>'; t = p.slice(1, -1); }
    t = plain(t);
    return `<w:r>${rp ? `<w:rPr>${rp}</w:rPr>` : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
  }).join('');
}

async function buildDocx(content) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('Word library not loaded.');
  const body = [];
  for (const b of parseMarkdown(content)) {
    if (b.t === 'h') body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${Math.min(b.level, 3)}"/></w:pPr>${runs(b.text)}</w:p>`);
    else if (b.t === 'p') body.push(`<w:p>${b.text.split('\n').map(t => runs(t)).join('<w:r><w:br/></w:r>')}</w:p>`);
    else if (b.t === 'li') body.push(`<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${runs('•\t' + b.text)}</w:p>`);
    else if (b.t === 'oli') body.push(`<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${runs(`${b.n}.\t` + b.text)}</w:p>`);
    else if (b.t === 'quote') body.push(`<w:p><w:pPr><w:ind w:left="720"/></w:pPr>${runs(b.text, '<w:i/>')}</w:p>`);
    else if (b.t === 'code') b.text.split('\n').forEach(l => body.push(`<w:p>${runs('`' + (l || ' ') + '`')}</w:p>`));
    else if (b.t === 'hr') body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>');
    else if (b.t === 'table' && b.rows.length) {
      const cols = Math.max(...b.rows.map(r => r.length));
      const rowsXml = b.rows.map((r, ri) => `<w:tr>${Array.from({ length: cols }, (_, ci) =>
        `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E8ECFF"/>' : ''}</w:tcPr><w:p>${runs(r[ci] ?? '', ri === 0 ? '<w:b/>' : '')}</w:p></w:tc>`).join('')}</w:tr>`).join('');
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join('')}</w:tblBorders></w:tblPr>${rowsXml}</w:tbl><w:p/>`);
    }
  }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1, 2, 3].map(l => `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${l === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${l - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="1F2A5A"/><w:sz w:val="${[0, 36, 30, 26][l]}"/></w:rPr></w:style>`).join('')}<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'blob', mimeType: MIME.docx });
}

// ---------- public ----------
export async function makeBlob(file) {
  if (file.dataUrl) return (await fetch(file.dataUrl)).blob();
  const ext = extOf(file.name);
  if (ext === 'xlsx') return buildXlsx(file.content);
  if (ext === 'pdf') return buildPdf(file.content, file.name.replace(/\.pdf$/i, ''));
  if (ext === 'docx') return buildDocx(file.content);
  const bom = ext === 'csv' || ext === 'tsv' ? '﻿' : ''; // so Excel reads UTF-8 correctly
  return new Blob([bom + file.content], { type: mimeOf(file.name) + ';charset=utf-8' });
}

export async function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  try {
    // chrome.downloads works reliably from the side panel and puts the file in the user's Downloads folder.
    await chrome.downloads.download({ url, filename: name, saveAs: false, conflictAction: 'uniquify' });
  } catch (_) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function downloadFile(file) {
  await saveBlob(await makeBlob(file), file.name);
}

// Short preview for the chat card: first rows of a table, or first lines of text.
export function preview(file) {
  if (file.dataUrl) return { kind: 'image', src: file.dataUrl };
  const ext = extOf(file.name);
  if (['csv', 'tsv', 'xlsx'].includes(ext) || (ext === 'json' && /^\s*\[/.test(file.content))) {
    try {
      const rows = parseSheets(file.content)[0].rows;
      return { kind: 'table', rows: rows.slice(0, 6), total: Math.max(0, rows.length - 1) };
    } catch (_) { /* ignore */ }
  }
  return { kind: 'text', text: String(file.content).slice(0, 400) };
}
