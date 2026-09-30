// Builds dist/deeppilot-v<version>.zip — only the files the extension needs (no tests, docs or tools).
// Pure Node + the bundled JSZip, so it works the same on Windows, macOS and Linux.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// vendor/jszip.min.js is a UMD bundle; load it as CommonJS without a package.json "type" clash.
const JSZip = (() => { const module = { exports: {} }; new Function('module', 'exports', fs.readFileSync(path.join(ROOT, 'vendor/jszip.min.js'), 'utf8'))(module, module.exports); return module.exports; })();
const INCLUDE = ['manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'permission.html', 'permission.js',
  'sidepanel.html', 'sidepanel.css', 'sidepanel.js', 'supabase.sql', 'LICENSE', 'lib', 'icons', 'fonts', 'vendor'];

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const zip = new JSZip();
let files = 0;
const add = rel => {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isDirectory()) { for (const f of fs.readdirSync(abs)) add(path.join(rel, f)); return; }
  if (/\.(pem|crx|zip)$|\.DS_Store$/.test(rel)) return;
  zip.file(`deeppilot/${rel.split(path.sep).join('/')}`, fs.readFileSync(abs));
  files++;
};
INCLUDE.forEach(add);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', `deeppilot-v${version}.zip`);
fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
console.log(`Built ${path.relative(ROOT, out)} — ${files} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
