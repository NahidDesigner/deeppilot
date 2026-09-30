# Changelog

All notable changes to DeepPilot. The format follows [Keep a Changelog](https://keepachangelog.com/) and versions follow [Semantic Versioning](https://semver.org/).

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
