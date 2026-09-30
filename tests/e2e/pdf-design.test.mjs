import './_setup.mjs';
import { fileURLToPath } from 'node:url';
// Designed PDFs: the Geist font is embedded (so —, ≤, →, €, ₹ render), headings/tables/callouts build,
// "Page x of y" footers exist, and hard line breaks are kept.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pdf-')), { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const p = await ctx.newPage(); await p.goto(`chrome-extension://${sw.url().split('/')[2]}/offscreen.html`); await p.waitForTimeout(500);
const errors = []; p.on('pageerror', e => errors.push(String(e)));
const md = `# Audit Report\nPrepared for Uptown — September 2026\n\n**Website:** https://example.com/  \n**Score:** 17 / 100\n\n## Results\n| Metric | Value | Target |\n|---|---|---|\n| LCP | 13.9 s | ≤ 2.5 s |\n| Cost | €120 · ₹900 · ৳500 | → lower |\n\n> Quick wins can move the score to 60+ ✓ 🚀\n\n${'- A long bullet point with enough words to wrap across the line and continue on the next one\n'.repeat(40)}`;
const r = await p.evaluate(async md => {
  const { makeBlob, parseMarkdown } = await import('./lib/files.js');
  const blob = await makeBlob({ name: 'report.pdf', content: md });
  const raw = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
  const para = parseMarkdown('**Website:** a  \n**Score:** b').find(b => b.t === 'p');
  return { size: blob.size, geist: /Geist/.test(raw), pages: (raw.match(/\/Type \/Page\b/g) || []).length, head: raw.slice(0, 8), hardBreak: para.text.includes('\n') };
}, md);
console.log(JSON.stringify({ ...r, errors }, null, 1));
await ctx.close();
