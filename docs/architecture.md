# Architecture

DeepPilot is a Manifest V3 Chrome extension written in plain ES modules. There is no build step and no framework, so any file can be edited and reloaded as-is.

```
┌──────────────────────────────┐        port "dp-ui"         ┌──────────────────────────────────────────────┐
│ Side panel / full page (view)│ ◀─────────────────────────▶ │ Background service worker (engine)           │
│ sidepanel.html/.css/.js      │  commands ▸   ◂ state/events │ lib/engine.js                                │
└──────────────────────────────┘                             │  Session per tab ─ Agent (lib/agent.js)      │
                                                             │   ├ agent runs: stages, items, worker pool   │
┌──────────────────────────────┐                             │   ├ run_in_parallel: helper pool             │
│ Offscreen document           │ ◀── build / ring / play ─── │   ├ queue, alarms, notifications             │
│ offscreen.html/.js           │                             │   └ history (IndexedDB) + Supabase + Sync    │
│ sounds · Excel/PDF/Word      │                             └───────────────┬──────────────────────────────┘
└──────────────────────────────┘                                             │ chrome.debugger (CDP) + scripting
                                                                             ▼
                                                                     the web pages it works on
```

## The view and the engine

The **engine** lives in the background service worker, so tasks keep running when the panel closes. The **view** (side panel or full page) is a thin client: it connects with `chrome.runtime.connect({ name: 'dp-ui' })`, sends commands (`send`, `stop`, `runAgent`, `resumeAgent`, `queue*`, `openConv`…) and renders the `full` / `state` / `event` / `patch` messages it receives.

Each browser tab gets its own **Session** (`tab:<id>`); the full-page view gets `page:<uuid>`. A session owns its conversation, queue, status light, alerts and the Agent working for it. `background.js` makes the side panel per-tab by enabling it with `chrome.sidePanel.setOptions({ tabId, path })` when the icon is clicked.

## The agent loop — `lib/agent.js`

1. **Observe**: `lib/browser.js → observe()` injects `pageSnapshot` (`lib/page.js`). It lists the visible interactive elements as `[id] <tag> "label"`, optionally draws numbered boxes, and takes a CDP screenshot.
2. **Think**: `lib/llm.js` streams a chat completion with the tool definitions and returns text, tool calls and token usage.
3. **Act**: `execute()` runs each tool: real mouse and keyboard through CDP (`Input.dispatchMouseEvent`, `insertText`), navigation, reading, files, memory, `ask_user`, `run_in_parallel`, `done`…
4. Repeat until `done`. Plain replies without a tool call are nudged back into the loop rather than treated as the end.

**Keeping it cheap without losing information.** DeepSeek bills repeated prompt prefixes at about 2% of the normal price, so the history is only ever *appended to* between compactions. When the uncompacted tail gets large, `compact()` shrinks everything but the latest step in one go: old page states become their first lines, long tool results are trimmed, and old reasoning is dropped. Other savings:

- Screenshots are sent only when the page address or content changes, after a failed action, or when the model calls `look`.
- An unchanged element list is replaced by a one-line reference to the previous step.
- A new task in the same chat compacts the earlier ones.

**Safety.** Page text is treated as data. Risky clicks (buy, send, delete, post) go through `ui.confirm`. `repairHistory()` guarantees every tool call has a matching result, so Stop never leaves the conversation in a state the API rejects.

## Agents runner — `Session.runAgent` in `lib/engine.js`

The run state lives in `conv.agentRun`: the definition, inputs, current stage, saved items, finished and failed items, results, updates and notes. It's persisted with the chat, which is why pause and resume survive restarts.

- Each stage (or item) gets a **fresh Agent** with a task built by `stageTask()`: goal, rules, inputs, the stage list, the current item, results so far and user updates. It gets up to 3 attempts.
- **For-each stages** run through `runItems()`, a worker pool. Worker *n* gets its own background tab, and tab ownership uses the id `<session>:w<n>`. Workers pull from a shared queue. The pool is capped by the agent's *Parallel tabs* setting, by the "one at a time" flag, and by site rules in `SENSITIVE` (LinkedIn/Facebook/messaging 1, Google Maps 2).
- `record_result` from a re-run item replaces its earlier result, and results are sorted into item order at the end of the stage.

## Automatic parallel tabs — `run_in_parallel`

The model can call `run_in_parallel({ instructions, items, max_tabs })`. `Session.runSubtasks()` starts a helper pool (tab ownership id `<session>:p<n>`) with the same retry and skip rules. It returns `{ done, total, results, failed }` to the waiting agent, which then continues. Helpers can't split again, and the same site caps apply.

## Steering

`Agent.inject(text)` puts a note in the agent's inbox. It's delivered as a user message before the next step. **Tell it now** injects into every running agent and helper, and stores the note in `run.updates` or `split.updates` so items that start later see it too. **Update & resume** appends to `run.updates` and resumes the run.

## Tabs

`lib/browser.js` tracks which session owns which tab, so two sessions never drive the same tab. Agent-opened tabs join a tab group per session and never take focus. When a page opens a new tab (`target=_blank`), that tab is claimed by the owner and focus returns to where you were.

## Storage

| What | Where |
|---|---|
| Settings, memories, skills, agents | `chrome.storage.local` |
| Conversations (events, files, usage, agent runs) | IndexedDB (`lib/store.js`) |
| Cross-computer copy of settings, memories, skills, agents | `chrome.storage.sync` via `lib/sync.js`: records `dp1|<type>|<id>`, chunked above 8 KB, tombstones for deletions, newest change wins |
| Optional cloud history | The user's own Supabase project (`lib/cloud.js`, `supabase.sql`, row-level security) |

The manifest carries a fixed public `key`, so the extension has the same id (`hdcnglpkoadmkcnjmejcckcpjjbpofjn`) on every computer. Chrome Sync needs that to match data. Forks that publish their own build should generate their own key.

## Files

| File | Role |
|---|---|
| `background.js` | Per-tab side panel, engine bootstrap, update migrations |
| `lib/engine.js` | Sessions, queue, alerts, agents runner, worker pools, steering, persistence |
| `lib/agent.js` | Agent loop, tools, system prompt, cache-friendly history |
| `lib/browser.js` | Tabs, ownership, groups, CDP input, screenshots, downloads, uploads |
| `lib/page.js` | Functions injected into pages: snapshot, text, links, cursor, file inputs |
| `lib/llm.js` | Streaming OpenAI-compatible client with retries |
| `lib/files.js` | CSV/Excel/PDF/Word/text builders and parsers |
| `lib/agents.js`, `lib/skills.js`, `lib/memory.js` | Saved agents, skills and memories |
| `lib/sync.js` | Chrome Sync |
| `lib/store.js`, `lib/cloud.js` | History in IndexedDB and Supabase |
| `lib/settings.js`, `lib/pricing.js` | Defaults, validation, cost maths |
| `lib/voice.js`, `lib/recorder.js`, `lib/sound.js` | Voice input, Whisper recording, alarm sounds |
| `lib/icons.js` | The icon set (SVG sprite) |
| `offscreen.*` | Audio playback and binary file building (needs a DOM) |
| `sidepanel.*` | The interface |
| `tests/e2e` | End-to-end suites + runner |
| `tools/` | Build, checks, screenshots, cost benchmark |
