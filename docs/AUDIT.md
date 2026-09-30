# Competitive audit — September 2026

Before v2.5 we compared DeepPilot with the browser agents people actually use, to find what makes their results better and make sure DeepPilot isn't missing it.

**Compared:**

- **Open-source extensions and libraries:** Claude in Chrome, [Nanobrowser](https://github.com/nanobrowser/nanobrowser), [browser-use](https://github.com/browser-use/browser-use), [BrowserOS](https://github.com/browseros-ai/BrowserOS), [OpenBrowse](https://github.com/openbrowse-ai/openbrowse), [Pie](https://github.com/WiseriaAI/pie-ai-agent), [Browd](https://github.com/wyddy7/browd) and [browser-agent-extension](https://github.com/Diegoregalado0/browser-agent-extension).
- **Techniques published by:** OpenAI Operator / ChatGPT agent and Perplexity Comet.

**Sources:** each project's README, docs and core source files (perception, agent loop, tool list), plus Anthropic's help-center pages for Claude in Chrome.

None of these projects publishes controlled before/after numbers for individual techniques. The priorities below come from what the successful projects all converge on, and from our own failing runs, such as a LinkedIn task that took 150 steps and a Canva task that ran out of steps.

## What decides whether a task succeeds

| # | Capability | Who has it | DeepPilot before | DeepPilot 2.5 |
|---|---|---|---|---|
| 1 | **"What changed" markers** after each action (`*[12]`) | Nanobrowser, browser-use, BrowserOS (diff), OpenBrowse | — | ✅ `*` on every element that is new since the last action |
| 2 | **Context for ambiguous controls** (a row's "Edit", a card's "…") | Claude (accessibility tree), BrowserOS, OpenBrowse | — | ✅ `— in: "A · www · 192.0.2.1 · Proxied"` on repeated or generic controls |
| 3 | **Iframes**, including cross-origin | browser-use, Nanobrowser, BrowserOS, OpenBrowse | — | ✅ Every visible frame is read and acted on (ids 1000·k+) |
| 4 | **Visible text, not just clickables**: alerts, dialogs, tables, values | Claude (`read_page`), browser-use, OpenBrowse (`readPage`) | Only via `get_page_text` | ✅ `TEXT IN VIEW`: headings, ALERT/DIALOG lines, table rows, short values |
| 5 | **Whole-page search** of elements | Claude (`find`), browser-use (`find_elements`, `search_page`), BrowserOS (`grep`) | — | ✅ `find` (scrolls the best match into view), `search_page` |
| 6 | **Question-answering extraction** from long pages | browser-use (`extract`), OpenBrowse | — | ✅ `extract` (separate call, with paging) |
| 7 | **Several actions per step**, stopped when the page changes | Claude (`browser_batch`), browser-use | One per step in practice | ✅ Batching; the rest is skipped if the URL changes |
| 8 | **Filling a whole form at once** | Claude (`form_input`), BrowserOS (`fill fields[]`) | — | ✅ `fill_form` |
| 9 | **Independent completion check** | Nanobrowser (planner), browser-use (judge), OpenBrowse (gate) | — | ✅ Check before "done", at most 2 rejections |
| 10 | **Stronger planner + cheap navigator** | Nanobrowser, Browd | — | ✅ Optional planner model (any OpenAI-compatible) |
| 11 | **Loop, stall and failure recovery** | browser-use | Loop detector (v2.4.1) | ✅ Plus "page hasn't changed for 5 steps" and "3 failures in a row" nudges |
| 12 | **Site know-how** | OpenBrowse (site skills), Claude (built-in app knowledge) | — | ✅ Site Playbooks: 16 built-in, plus notes the agent learns per site |
| 13 | **Zooming into a region**, drag, double/right click | Claude (`zoom`, drag, clicks), BrowserOS | — | ✅ `look` with a region, `drag`, `click` with double/right |
| 14 | **Reading PDFs** | Pie, browser-use (PDF notice) | — | ✅ `read_pdf` and PDF attachments (PDF.js) |

## Trust & safety

| Capability | Who has it | DeepPilot 2.5 |
|---|---|---|
| Page content fenced as untrusted, with a random nonce | BrowserOS, Pie, Nanobrowser | ✅ `<untrusted_page_data id=…>`; look-alike markers removed |
| Confirmation before buy/send/delete/post | Claude, Operator, Comet | ✅ (since v1) |
| Extra confirmation on high-stakes dashboards (DNS, ad spend, hosting, payments) | Claude (site categories), browser-agent-extension | ✅ Save/Publish/Apply need approval on those sites |
| "Always allow on this site" | Claude | ✅ |
| Domain blocklist | browser-use, Nanobrowser (firewall) | ✅ |
| Never type credentials the user didn't give; hand over logins and CAPTCHAs | Claude, Operator, BrowserOS | ✅ (since v1) |

## Everyday features

| Capability | Who has it | DeepPilot |
|---|---|---|
| Scheduled tasks | Claude, Pie, BrowserOS, OpenBrowse | ✅ New in 2.5: once / hourly / daily / weekdays / weekly |
| Saved prompts as `/commands` | Claude, Pie, Nanobrowser | ✅ Skills (since v1.x) |
| Multi-stage workflows that run until done | — (none of the above in this form) | ✅ Agents (not found in the others) |
| Parallel tabs chosen by the agent | BrowserOS neo (separate product) | ✅ `run_in_parallel` (not found in the other extensions) |
| Real files out (Excel, designed PDF, Word, CSV) | Pie (CSV) | ✅ (the broadest set) |
| Queue, "Tell it now", Update & resume | — | ✅ (not found in the others) |
| Chrome Sync between computers | — | ✅ (not found in the others) |
| Live cost meter | Browd (token ring) | ✅ |
| Workflow recording ("do it once, it learns") | Claude, Pie | ⏳ Planned for 2.6 |
| GIF / replay of a run | Claude (GIF), Nanobrowser (replay), BrowserOS neo (video) | ⏳ Planned |
| MCP (connect to Claude Code / Cursor) | browser-use, BrowserOS, OpenBrowse | ⏳ Planned |
| Console and network reading, JavaScript execution | Claude, OpenBrowse | Not planned for end users (developer feature; security trade-off) |

## Measured cost of the upgrade

Same scripted 24-step task, with `npm run bench:cost`:

| | v2.4.2 | v2.5 |
|---|---|---|
| Page state per step | 1,859 chars | 2,081 chars (+12%) |
| Uncached tokens | 58.9K | 63.3K (+7%) |
| Estimated cost | $0.0246 | $0.0262 (+6%) |

A scripted benchmark can't show the real saving, which is fewer steps. Knowing which row an "Edit" belongs to, seeing the "Saved" alert, reading inside iframes, and not declaring "done" early are what turn a 150-step flail into a 20-step task.

## What we can't match

The model. Claude and Operator are trained specifically for using computers, while DeepSeek Flash is a fast, cheap general model. Better perception, planning, checks and site knowledge close most of the gap on everyday dashboards. For the hardest interfaces, the optional **planner model** lets a stronger model steer.
