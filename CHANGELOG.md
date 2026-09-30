# Changelog

All notable changes to DeepPilot. The format follows [Keep a Changelog](https://keepachangelog.com/) and versions follow [Semantic Versioning](https://semver.org/).

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
