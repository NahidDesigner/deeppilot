# User guide

Everything DeepPilot can do, and how to get the best out of it. New here? Start with [Install](../README.md#-install-in-2-minutes).

- [The side panel](#the-side-panel)
- [Giving good tasks](#giving-good-tasks)
- [While it works: queue, tell it now, stop](#while-it-works)
- [Files: attach and create](#files)
- [Parallel tabs](#parallel-tabs)
- [Agents](#agents)
- [Scheduled runs](#scheduled-runs)
- [Site playbooks](#site-playbooks)
- [Planner model & the check before "done"](#planner-model--the-check-before-done)
- [Safety controls](#safety-controls)
- [Skills](#skills)
- [Memory](#memory)
- [History and the full-page view](#history-and-the-full-page-view)
- [Sync between computers](#sync-between-computers)
- [Voice input](#voice-input)
- [Alerts and sounds](#alerts-and-sounds)
- [Settings reference](#settings-reference)
- [Other models](#other-models)

## The side panel

Click the DeepPilot icon (or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>) on any tab. **Each tab gets its own DeepPilot** with its own chat, queue and status, so you can run different tasks in different tabs at the same time. Tasks keep running when you switch tabs or close the panel; open it again to see where they are.

The strip under the tabs is the **telemetry**: the status light (STANDBY · LIVE · NEEDS YOU · LANDED · STOPPED), what it's doing right now, and the elapsed time. The two icons on the right switch **narration** (the agent's short commentary) and **steps** (every click and keystroke) on or off.

The meter at the bottom shows the tokens and cost of the current task and the whole session.

## Giving good tasks

DeepPilot understands plain language. You get better results when you say:

- **Where** — "on Google Maps", "in my Gmail", "on linkedin.com/mynetwork".
- **What exactly** — "10 companies", "only ones with a website and 4+ stars".
- **What you want back** — "as a CSV with name, website, email, phone", "a 5-bullet summary".
- **What it must not do** — "don't send anything, just draft".

Long multi-part requests are fine. It writes itself a checklist and doesn't stop until every part is done.

It uses the sites you're already logged into. For logins, CAPTCHAs and two-factor codes it asks you to do that part yourself.

## While it works

- **Queue next** (default): type another task and it runs after the current one. Queued tasks show above the message box. You can remove them, or resume the queue if it paused after an error.
- **Tell it now**: sends your message to the task that's running. It's used on the very next step, and with parallel tabs every tab gets it. Use it for new info or a change of plan: *"also note if the site has a booking form"*.
- **Stop**: stops right away. Then just send a correction; the chat stays valid and it continues with your new instructions.
- **Ask cards**: when it needs you (a question, or permission to buy/send/post/delete), the light turns orange, an alarm rings and a card appears in the chat.

## Files

**Attaching.** Click 📎 next to the mic, drag files onto the panel, or paste them. You can attach up to 8 files of 15 MB each, to a new task, a queued task, **Tell it now** or **Update & resume**.

| File | What the agent gets |
|---|---|
| CSV, TSV, TXT, MD, JSON, HTML, XML, code… | The full text (very long files are trimmed and it's told so) |
| Excel (xlsx, xls, ods) | Every sheet, as CSV |
| Word (docx) | The document text |
| PDF, images, anything else | Kept in the chat so it can **upload** them to a website; it can't read their content yet |

**Creating.** Ask for any format: *"give me an Excel file"*, *"make a 2-page PDF report"*, *"save it as a Word document"*. Files appear as cards with a preview and a **Download** button, and they're kept in History. It can also save images from pages (e.g. one you generated on ChatGPT) and upload files into any site's upload box.

## Parallel tabs

When a task has several **independent** items that each need the same browsing work, DeepPilot decides by itself to split them across background tabs working at the same time. Examples: audit 10 websites, find the email on every company site, check the price on each product page.

- A **Parallel tabs** card shows one lane per tab (T1, T2…) and what each is doing.
- Each tab is a helper with its own fresh context. Failed items are retried up to 3 times, then skipped and reported.
- When they're done, the main task continues with all the results (e.g. builds the Excel file).
- It stays **one at a time** for anything that sends messages, posts or buys, and for LinkedIn, Facebook, Instagram, X and email. Google Maps is limited to 2 tabs.
- **Settings → Agent behaviour**: switch automatic splitting off, or set **Max parallel tabs** (2–10, default 4). See [performance](performance.md) for choosing a number for your computer.

Parallel tabs make work **faster, not cheaper**: the total cost is about the same.

## Agents

Agents are saved multi-stage workflows that keep going until the job is done. They're the best way to run the same big job again and again. **[Read the Agents guide →](agents.md)**

## What the agent sees and can do

Each step the agent gets a map of the page, much like a person scanning it:

- **Every control with its context.** For example, `[14] <a> "Edit" — in: "A · www · 192.0.2.1 · Proxied"`, so it knows which of many identical buttons to press.
- **`*` marks what's new** since its last action: the dialog that opened, the menu that appeared.
- **`TEXT IN VIEW`** shows headings, **ALERT** lines (errors like "Invalid value", confirmations like "Saved"), open dialogs, visible table rows and short values (prices, statuses, counts).
- **Iframes** (cPanel, payment forms, embedded editors) are listed under "INSIDE FRAME" and used like the rest of the page.

Its extra tools:

- **find**: jumps to a control anywhere on the page.
- **search_page**: like Ctrl+F.
- **extract**: answers a question from a long page or report.
- **fill_form**: fills many fields at once.
- **drag**: drag and drop.
- **double/right click**.
- **look with a region**: zooms into small print or icons.
- **read_pdf**: the PDF in the tab, a PDF link, or an attached PDF.

## Scheduled runs

**Agents** tab → **Scheduled runs**. Use **⏱ Schedule** on any agent or skill card, or **New schedule** for any task.

| Setting | What it does |
|---|---|
| **What to run** | A task in plain words, a `/skill` or a `/agent` command with its inputs |
| **Repeat** | Once, every hour, every day, weekdays, or every week at a time you pick |

Runs happen in a background tab **while Chrome is open**. Each run is saved in History (titled "⏰ name") and you get a notification. If the computer was off, a missed run happens when Chrome starts again, up to 12 hours late. Each schedule has **Run now**, **Pause/Resume**, **Edit** and **Last result**.

## Site playbooks

Built-in know-how for common dashboards is added automatically when the agent reaches the site:

- Cloudflare
- Meta Ads Manager
- cPanel
- WordPress and Elementor
- Hostinger, GoDaddy, Namecheap
- Google Ads, Search Console, Analytics
- LinkedIn, Facebook, Gmail
- Canva, Google Sheets
- Shopify

After a task, the agent can save **its own notes** for a site (where a setting lives, a step that worked). Next time it's on that site, it uses them. See and delete them in **Memory → Site playbooks**. They sync between your computers with Chrome Sync.

## Planner model & the check before "done"

- **Check the result before finishing** (on by default): before reporting "done", a separate review compares every part of your request with what was actually done and what the page shows. If something is missing, the agent continues. The review rejects at most twice, so it can't loop, and costs one short extra call per task.
- **Planner model** (optional, **Settings → DeepSeek → Planner model**): a stronger model for hard sites. It writes the plan at the start, re-plans every 10 steps and after 3 failed actions in a row, and does the final check. The main model keeps doing the clicking, so costs stay low. It can be any OpenAI-compatible model, with its own base URL and key (e.g. via OpenRouter); leave the base URL and key blank to reuse the main ones.

## Safety controls

- **Ask before buying, sending, deleting or posting** (on by default).
- **High-stakes dashboards:** on DNS, ad-spend, hosting and payment dashboards (Cloudflare, Ads Manager, Google Ads, cPanel, hosting panels, Stripe, PayPal, cloud consoles), **Save / Publish / Apply / Delete** also need your OK.
- **Your options on each approval card:** **Allow**, **Allow all for this task**, **Always on this site** (remembered; reset in Settings), or **Deny**.
- **Never open or act on these sites:** a blocklist in Settings.
- **Page text is fenced:** everything read from a page is wrapped in markers with a random code, and the agent treats it as data, never as instructions.

## Skills

A skill is a saved task you run again with `/`. When a task finishes, click **Save as skill** under the result, or use the **Skills** tab. Type `/` in the message box to pick one. Anything after the name is extra input for that run: `/daily-report focus on mobile traffic`.

Skills and agents can be exported and imported as JSON files, so you can share them.

## Memory

Say *"remember …"* and DeepPilot saves it to long-term memory: templates, names, preferences, how you like things done. Memories are included in every task. Manage them in the **Memory** tab, or just say *"forget the welcome template"* or *"update my signature to …"*.

## History and the full-page view

Every chat is saved with its steps, results and files, grouped by day and searchable. Open one to read it, download its files, continue it, or delete it. The ⤢ button opens the **full-page view**: the same cockpit in a normal tab, with your history in a sidebar.

**Cloud history (optional).** In **Settings → Cloud history** you can connect a free [Supabase](https://supabase.com) project of your own to keep history in the cloud. Run `supabase.sql` in its SQL editor once. Your data goes to your project, protected by row-level security.

## Sync between computers

Memory, skills, agents and settings follow your Google account through **Chrome Sync**. No account or server is needed.

1. On every computer, sign in to Chrome with the same Google account.
2. Go to Chrome → **Settings → Sync and Google services → Manage what you sync** and make sure **Extensions** is on.
3. In DeepPilot: **Settings → Sync between computers**. **Sync with Chrome Sync** is on by default. **Sync now** forces an update.

API keys stay on each computer unless you tick **Also sync my API keys**. Chrome allows about 100 KB of synced data in total; the bar shows how full it is. History and files don't sync this way; use cloud history for those. **Download backup** saves memory, skills, agents and settings (never keys) in one file; **Restore…** merges a backup back in.

## Voice input

Click the mic, speak, click again (or press Send). **Whisper** (default) is the most accurate, including বাংলা, Hindi, Urdu, Arabic and South-Asian English, and needs a free key from [console.groq.com](https://console.groq.com). **Chrome built-in** needs no key but is less accurate. Add names or brand words under **Words it should know** to improve accuracy.

## Alerts and sounds

When a task finishes, needs you, or stops because of a problem, DeepPilot plays a sound, shows a desktop notification and badges its toolbar icon (✓ · ! · ×). Choose a sound for each event, the volume, and whether alarms repeat until you stop them. **Stop sound** appears while an alarm is ringing.

## Settings reference

| Group | Setting | Default |
|---|---|---|
| DeepSeek | API key · Model · Base URL | — · `deepseek-flash` · `https://api.deepseek.com` |
| | Planner model · planner base URL · planner key | off (optional) |
| Appearance | Theme: Daylight · Flight deck · System | Daylight |
| Agent behaviour | Max steps per task | 100 |
| | Send screenshots (vision) · only when the page changes | on · on |
| | Check the result before finishing | on |
| | Ask before buying, sending, deleting or posting | on |
| | Never open or act on these sites (blocklist) · always-allowed sites | empty |
| | Show the agent's cursor | on |
| | Split work across parallel tabs by itself · Max parallel tabs | on · 4 |
| Sounds & alerts | Sound per event · volume · repeat · desktop notifications | on |
| Voice input | Engine · language · Groq key · words it should know | Whisper · English (US) |
| Cost meter | Prices per 1M tokens · off-peak discount · budget per task | DeepSeek prices · on · $0.05 |
| Sync | Chrome Sync · also sync API keys · backup & restore | on · off |
| Cloud history | Supabase URL & anon key · sign in | off |

## Other models

DeepPilot uses the OpenAI-compatible chat API, so in **Settings → DeepSeek** you can change **Base URL** and **Model**:

| Provider | Base URL | Notes |
|---|---|---|
| DeepSeek (default) | `https://api.deepseek.com` | Developed and tested with this |
| OpenRouter | `https://openrouter.ai/api/v1` | Hundreds of models behind one key |
| Groq | `https://api.groq.com/openai/v1` | Very fast open models |
| Ollama (local, free) | `http://localhost:11434/v1` | Start Ollama with `OLLAMA_ORIGINS="chrome-extension://*"` so the extension may call it |

The model must support **tool calling**. For screenshots it must also accept images; if it doesn't, DeepPilot falls back to text-only automatically. Update the prices in **Settings → Cost meter** so the meter stays accurate. Small local models often struggle with long multi-step tasks.
