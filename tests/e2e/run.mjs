// DeepPilot end-to-end test runner.
//
// Every test loads the real extension into Chromium (headed — extensions need it; on Linux CI run under
// xvfb-run), drives it through the side panel, and talks to a local mock of the DeepSeek API and of the
// websites involved. No API key and no internet are needed. This runner starts each test, checks what it
// printed, and prints a summary. Usage:
//
//   npm test                     run everything
//   npm test -- agents steering  run tests whose name contains one of the words
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '.out');
fs.mkdirSync(OUT, { recursive: true });

// Tests print one JSON object at the end — pretty-printed or on a single line.
const json = s => {
  const i = s.indexOf('{\n');
  if (i >= 0) return JSON.parse(s.slice(i, s.lastIndexOf('}') + 1));
  const line = s.split('\n').reverse().find(l => l.trim().startsWith('{'));
  return JSON.parse(line);
};
const has = (s, t) => s.includes(t);

// name → what must be true about the test's output
const CHECKS = {
  'basic-actions': s => [
    [has(s, 'RESULT scroll-ok :: Saved: Nahid / Blue / Hello bio'), 'fills a form, selects, types, clicks, reads and scrolls'],
    [has(s, 'sawImage true sawTools true'), 'sends screenshots and tools to the model'],
    [has(s, 'CONFIRM CARD SHOWN'), 'asks before a risky click'],
    [has(s, 'panel errors []'), 'no errors in the panel'],
  ],
  'linkedin-memory': s => [
    [has(s, 'Sent 3 messages'), 'messages 3 connections one by one'],
    [has(s, 'system prompt had template: true'), 'uses the remembered template'],
    [/errors \[\]/.test(s), 'no errors in the panel'],
  ],
  'core-features': s => { const r = json(s); return [
    [r.lightDone === 'orb done' && /^Done/.test(r.alarmText), 'queue runs to the end and the alarm fires'],
    [r.saved?.length === 4, 'creates CSV / XLSX / PDF / DOCX files'],
    [r.cloud?.authHeaderOk && r.cloud?.rows === 2, 'syncs history to the user\'s own Supabase'],
    [/Austin/.test(r.p2final || ''), 'a second session works in parallel'],
    [/Invalid/.test(r.badLogin || ''), 'shows a clear cloud login error'],
  ]; },
  'multi-site-upload': s => { const r = json(s); return [
    [/Uploaded/.test(r.imgFinal || ''), 'saves an image on one site and uploads it on another'],
    [r.dls?.[0]?.state === 'complete', 'downloads the image'],
    [r.activeBefore === r.activeAfter, 'never steals the user\'s tab'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  'tab-sessions': s => { const r = json(s); return [
    [r.betaFinal === 'Beta finished' && /^Alpha finished/.test(r.alphaFinal || ''), 'two tabs run two tasks at the same time'],
    [r.streamed > 0, 'streams the model\'s answer'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  'stop-and-correct': s => { const r = json(s); return [
    [/saw stop note: true/.test(r.final || ''), 'Stop mid-task, then a correction continues cleanly'],
    [!r.errors?.length && !r.errorsShown?.length, 'no API errors after Stop'],
  ]; },
  agents: s => { const r = json(s); return [
    [/LANDED/.test(r.done?.meta || ''), 'a 4-stage agent runs to the end'],
    [r.xlsxRows?.results === 3 && r.xlsxRows?.files?.length === 2, 'records every item and builds Excel + PDF'],
    [/2 of 3 items already done/.test(JSON.stringify(r.done?.notes || [])), 'pause and resume keep finished items'],
    [r.draft?.stages?.length === 3, 'drafts an agent with AI'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  'parallel-agent': s => { const r = json(s); return [
    [r.done?.final === 'report 1,2,3,4,6,7', 'results in order, failing item skipped, no duplicates after resume'],
    [r.maxInflight === 4, 'works on 4 items at once'],
    [r.liMax === 1, 'LinkedIn stages stay one at a time'],
    [r.theme === 'light', 'light theme by default'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  steering: s => { const r = json(s); const res = r.results?.res || []; return [
    [/heard: use the blue theme/.test(r.chatFinal || ''), '"Tell it now" reaches a running task'],
    [res.length === 5 && res.every(x => x.color === 'blue'), 'a note reaches every running and later item'],
    [res.slice(2).every(x => x.tag === 'vip'), '"Update & resume" changes the rest of the run'],
    [r.stillPaused?.meta?.startsWith('PAUSED'), '"Just chat" leaves the agent paused'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  'auto-split': s => { const r = json(s); return [
    [r.after?.final === 'Found 8 emails.' && r.conv?.done === 8, 'splits 8 items across tabs by itself and gets every result'],
    [r.maxIn === 4, 'respects the max parallel tabs setting'],
    [!r.toolOffered?.length, 'helpers cannot split again'],
    [/LinkedIn/.test(r.liFinal || ''), 'refuses to split LinkedIn work'],
    [r.offFinal === 'tool not offered', 'can be switched off'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  attachments: s => { const r = json(s); const f = r.seen?.[0] || {}; return [
    [f.csv && f.xlsxLeads && f.xlsxNotes && f.docx, 'reads CSV, every Excel sheet and Word files'],
    [f.png, 'keeps images for upload and says it cannot read them'],
    [/true$/.test(r.steerFinal || ''), 'files can be sent with "Tell it now"'],
    [r.files?.length === 6, 'attachments are saved in the chat'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  'chrome-sync': s => { const r = json(s); return [
    [r.sameId && r.fixed, 'same extension id on every computer'],
    [r.chunked > 0, 'large agents are split to fit Chrome Sync'],
    [!r.secretInSync, 'API keys are not synced by default'],
    [JSON.stringify(r.A_afterBChanges?.skills) === '["from-b:made on PC B"]', 'edits and deletions travel between computers'],
    [r.A_afterBChanges?.mem?.length === 3, 'memories from both computers are merged'],
    [r.B_keyAfterOptIn === 'sk-A-secret', 'keys sync only after opting in'],
    [r.backup && !r.backup.hasKey, 'backup file never contains keys'],
  ]; },
  reliability: s => { const r = json(s); return [
    [r.staleFree === true, 'waits for results that load late (no stale reads after a search)'],
    [r.tickerStepMs != null && r.tickerStepMs < 6000, 'a constantly-changing page never makes a step hang'],
    [r.warned === true, 'going in circles triggers a nudge to decide and move on'],
    [!r.errors?.length, 'no errors in the panel'],
  ]; },
  voice: s => { const r = json(s); return [
    [!r.errors?.length, 'voice input works without errors'],
  ]; },
};

const only = process.argv.slice(2).map(a => a.toLowerCase());
const tests = Object.keys(CHECKS).filter(n => !only.length || only.some(o => n.includes(o)));
const results = [];
const bold = s => `\x1b[1m${s}\x1b[0m`, green = s => `\x1b[32m${s}\x1b[0m`, red = s => `\x1b[31m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`;

for (const name of tests) {
  const file = path.join(DIR, `${name}.test.mjs`);
  const t0 = Date.now();
  process.stdout.write(`${bold(name)} ${dim('…')}\n`);
  const out = await new Promise(resolve => {
    let buf = '';
    const p = spawn(process.execPath, [file], { cwd: OUT, env: process.env });
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { buf += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 240000);
    p.on('close', code => { clearTimeout(kill); resolve({ code, buf }); });
  });
  fs.writeFileSync(path.join(OUT, `${name}.log`), out.buf);
  let checks;
  try { checks = CHECKS[name](out.buf); } catch (e) { checks = [[false, `output could not be read (${e.message})`]]; }
  if (out.code !== 0) checks.unshift([false, `test process exited with code ${out.code}`]);
  const ok = checks.every(c => c[0]);
  for (const [pass, label] of checks) console.log(`  ${pass ? green('✓') : red('✗')} ${label}`);
  console.log(dim(`  ${((Date.now() - t0) / 1000).toFixed(1)}s · log: tests/e2e/.out/${name}.log\n`));
  results.push({ name, ok });
}

const failed = results.filter(r => !r.ok);
console.log(bold(`${results.length - failed.length}/${results.length} test files passed`) + (failed.length ? red(` — failed: ${failed.map(f => f.name).join(', ')}`) : green(' ✓')));
process.exitCode = failed.length ? 1 : 0;
