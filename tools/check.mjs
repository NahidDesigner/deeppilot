// Fast checks that need no browser: syntax of every script, manifest validity, versions in sync,
// and no secrets in the tree. Run with `npm run check` (CI runs it on every push).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
  if (['node_modules', '.git', 'vendor', 'dist', '.out'].includes(d.name)) return [];
  const p = path.join(dir, d.name);
  return d.isDirectory() ? walk(p) : [p];
});
const files = walk(ROOT);

for (const f of files.filter(f => /\.(m?js)$/.test(f))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { problems.push(`Syntax error in ${path.relative(ROOT, f)}:\n${String(e.stderr).split('\n').slice(0, 5).join('\n')}`); }
}
let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')); } catch (e) { problems.push('manifest.json is not valid JSON: ' + e.message); }
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest) {
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (manifest.version !== pkg.version) problems.push(`Version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
  const referenced = [manifest.background?.service_worker, manifest.side_panel?.default_path, ...Object.values(manifest.icons || {})];
  for (const r of referenced) if (r && !fs.existsSync(path.join(ROOT, r))) problems.push(`manifest.json points to a missing file: ${r}`);
}
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (/\.pem$/.test(f)) problems.push(`Private key file in the tree: ${rel} — never commit it`);
  if (/\.(js|mjs|json|html|md)$/.test(f) && fs.statSync(f).size < 2e6) {
    const t = fs.readFileSync(f, 'utf8');
    if (/sk-[a-f0-9]{32}/.test(t) || /gsk_[A-Za-z0-9]{20,}/.test(t)) problems.push(`Something that looks like a real API key in ${rel}`);
  }
}
if (problems.length) { console.error(problems.map(p => '✗ ' + p).join('\n')); process.exit(1); }
console.log(`✓ ${files.filter(f => /\.(m?js)$/.test(f)).length} scripts parse · manifest v${manifest.version} valid · versions in sync · no secrets`);
