# Changelog

All notable changes to DeepPilot. The format follows [Keep a Changelog](https://keepachangelog.com/) and versions follow [Semantic Versioning](https://semver.org/).

## [2.5.1] — 2026-10-02
Built from the first run on the **live Meta Ads Manager** (a Traffic campaign and ad set created as a draft on a fresh ad account: completed, nothing published, about 95 steps and $0.05). The run showed three things that slowed it down; this release fixes them.
### Added
- **Controls that only show on hover** (edit pencils, "⋯" row menus) are now listed as `(shows on hover)` with the row they belong to, and a click hovers the row first.
- **A real button inside a clickable row or card** is listed as its own target instead of being merged into the row.
- **Clicks that change nothing are reported**, with what to try next, so the agent stops repeating a dead click.
- README section **Tested on real sites** with the Ads Manager result.
### Changed
- `scroll` moves the page's **main inner panel** when the page itself can't scroll (editors, dashboards, mail apps), and says when it is already at the top or bottom.
- Every click now moves the pointer onto the target and re-measures before pressing, so layouts that shift on hover are hit correctly.
- **Meta Ads Manager playbook** rewritten from the live run: the create flow, manual setup, inner scrolling, hover pencils, locations, where the age range lives, never Escape inside the editor, and closing the "Publish draft items?" dialog to keep a draft.
- The agent now checks for "Show more options" / "Advanced" / "Further limit" before reporting that a setting doesn't exist.
### Fixed
- CI: a test file that crashes on a slow shared runner gets one more try, and the failing log's last lines are printed.

## [2.5.0] — 2026-10-01
A results-focused release, based on a feature-by-feature audit of Claude in Chrome, Nanobrowser, browser-use, BrowserOS, OpenBrowse, Pie and others ([docs/AUDIT.md](docs/AUDIT.md)).
### Added
- **Page perception:**
  - `*` markers for elements that are new since the last action.
  - Row/card context for repeated or generic controls (`— in: "A · www · …"`).
  - `TEXT IN VIEW` with headings, ALERT/DIALOG lines, visible table rows and short values.
  - Screens above/below, plus required/invalid/selected/pressed states.
- **Iframes**, including cross-origin: read, type, click and page text inside frames (ids 1000·k+).
- **New tools:** `find` (whole page, scrolls to the match), `search_page`, `extract` (question-answering over long pages), `fill_form`, `drag`, double/right `click`, `look` with a zoom region, and `read_pdf`.
- **Batching:** several actions per step; the rest is skipped when the page address changes.
- **Check before "done":** an independent review against the task (at most 2 rejections).
- **Optional planner model** (any OpenAI-compatible model): plans at the start, re-plans every 10 steps and after 3 failures, and does the final check.
- **Site Playbooks:** 16 built-in (Cloudflare, Meta Ads Manager, cPanel, WordPress/Elementor, Hostinger, GoDaddy, Namecheap, Google Ads/Search Console/Analytics, LinkedIn, Facebook, Gmail, Canva, Google Sheets, Shopify). The agent also saves learned notes per site, which sync between computers.
- **Scheduled runs:** once, hourly, daily, weekdays or weekly, for any task, skill or agent.
- **PDF reading** with PDF.js, for attachments and links.
- **Safety:**
  - page text fenced with a random nonce;
  - approval for Save/Publish/Apply/Delete on high-stakes dashboards;
  - "Always on this site";
  - a domain blocklist.
- **Recovery nudges** when the page hasn't changed for 5 steps or 3 actions fail in a row.
- New end-to-end suites: `dashboards` (DNS table, cross-origin iframe panel, long page) and `brains` (planner, playbooks, blocklist, trusted sites, PDFs, schedules).
### Changed
- The page view is about 12% larger per step, for about 6% more cost on the benchmark task. The expected payoff is far fewer steps on real dashboards.

## [2.4.2] — 2026-09-30
### Added
- **Designed PDFs.** Every PDF DeepPilot creates now has a dark title band, accent section headings, **bold** inside text, styled tables with zebra rows, highlighted callouts and "Page x of y" footers.
### Fixed
- **Symbols in PDFs** (≤ ≥ → — € ₹ ≈ …) printed as garbage. The Geist font is now embedded. Emoji are removed and ✓ ✗ ★ ৳ get close equivalents.
- Markdown line breaks ("**Label:** value" lines) are kept in PDFs, Word files and the chat.
- **Canvas editors (Canva, Figma…) and long tasks:**
  - a progress check every 25 steps and at 70% of the step budget;
  - "commit to one approach" rules, and guidance for canvas editors;
  - it offers to build the file itself when an in-app design isn't working.
- Key names like "Page Up", "Esc", "Return" and "Del" are understood.
- Viewing screenshots of the same page repeatedly no longer counts as going in circles.

## [2.4.1] — 2026-09-30
### Fixed
- **Simple tasks going in circles.** A real LinkedIn run took ~150 steps for a 20-step job. Four fixes:
  - **No more stale reads.** After every click, search, key press or scroll, DeepPilot now waits until the page stops changing (results loaded, dialog opened) before reading it. Single-page apps like LinkedIn used to be read before their results appeared, which caused contradictory conclusions.
  - **Going-in-circles detector.** Re-opening the same page, re-reading it or re-running the same search 3+ times triggers a firm nudge to decide from the notes and move on (and, if still stuck, to ask you).
  - **"Decide and move on" rules.** It checks a fact once, writes it down and trusts its notes, and prefers the most direct evidence. It checks "skip anyone already messaged" per person when it gets to them, instead of pre-scanning the inbox.
  - **Overlays handled.** Chat windows on LinkedIn/Facebook are closed with their X button (Escape doesn't close them), and a screenshot is sent automatically when a click opens a dialog or overlay.
- The latest 2 steps now stay in full detail, so the agent doesn't need to re-open a page it just read.

## [2.4.0] — 2026-09-30
### Added
- **Sync between computers** through Chrome Sync: memories, skills, agents and settings follow your Google account. API keys are optional. Includes a status line, *Sync now*, and a one-file **backup & restore**.
- A fixed extension id, so every computer is recognised as the same DeepPilot.
- A `look` tool, so the agent can ask for a screenshot whenever it needs to see the page.
### Changed
- **About 35% fewer tokens per request** with no information removed:
  - cache-friendly history (append-only between compactions);
  - screenshots only when the page changes;
  - unchanged pages aren't re-sent;
  - earlier tasks in a chat are condensed.
### Fixed
- An item paused right after saving its result could appear twice in the final file.

## [2.3.0]
### Added
- **Automatic parallel tabs**: DeepPilot decides by itself when to split independent items across up to 10 tabs (`run_in_parallel`). Includes settings for on/off and max tabs.
- **File attachments**: 📎, drag & drop or paste. It reads CSV, text, JSON, every Excel sheet and Word files; other files are kept for upload.

## [2.2.0]
### Added
- **Tell it now**: send new info to a running task and every parallel tab.
- **Update & resume** and **Just chat** for paused agents.
- An update history in the chat and on the flight card.

## [2.1.0]
### Added
- **Parallel tabs for agents**: "for each item" stages work on up to 10 items at once, with one lane per tab. Limits apply automatically on LinkedIn, Facebook, messaging and Google Maps.
- A "One item at a time" option per stage.
### Changed
- The light *Daylight* theme is now the default.

## [2.0.0]
### Added
- The *Flight Deck* interface: telemetry strip, flight path for agents, premium light and dark themes, Geist fonts, and an icon set.
- **Agents**: saved multi-stage workflows with inputs, per-item stages, retries, a cost limit, pause & resume, and Draft with AI.

## [1.x]
- The side-panel browser agent on DeepSeek: real input via CDP, vision, per-tab sessions in the background, task queue, alarms and sounds, cost meter, memory, skills with `/`, History with a full-page view, optional Supabase cloud history, and voice input with Whisper. Creates CSV/Excel/PDF/Word files, saves images and uploads files to websites.
