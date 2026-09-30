# Security

DeepPilot controls your browser with the sessions you're logged into, so we take security seriously.

## Reporting a vulnerability

Please **do not open a public issue.** Use GitHub's [private vulnerability reporting](https://github.com/NahidDesigner/deeppilot/security/advisories/new) (Security tab → *Report a vulnerability*) with steps to reproduce. You'll get a reply within a few days. Once there's a fix, we'll credit you in the release notes if you'd like.

Especially interesting: ways a web page can make the agent act against the user (prompt injection that bypasses confirmations), leaks of API keys or history, and anything that lets other extensions or sites reach DeepPilot's data.

## What the permissions are for

| Permission | Why DeepPilot needs it |
|---|---|
| `debugger` | Real mouse clicks, typing and background screenshots through the Chrome DevTools Protocol. This is why Chrome shows *"DeepPilot started debugging this browser"* while a task runs. |
| `<all_urls>`, `scripting` | Read the page and find its buttons, links and fields on whatever site you ask it to work on |
| `tabs`, `tabGroups`, `activeTab` | Open and group its own background tabs without stealing your focus |
| `sidePanel` | The DeepPilot panel next to each tab |
| `storage` | Settings, memories, skills, agents (and Chrome Sync, which uses your own Google account) |
| `downloads` | Save the files it creates and images it collects; find files a site downloaded |
| `notifications` | Tell you when a task is done or needs you |
| `offscreen` | Play alarm sounds, build Excel/PDF/Word files and read PDFs |
| `alarms` | Start your scheduled runs at the time you chose |

## Where your data goes

- **Stays in your browser:** API keys, settings, memories, skills, agents, history and files.
- **Sent to the model endpoint you configure** (DeepSeek by default): the task, the page state (element list, visible text, frames) and screenshots, only while a task runs. If you set an optional **planner model**, a summary of the task, the actions and the current page also goes to that endpoint.
- **Sent to the transcription service you configure** (Groq by default): voice recordings, only when you use Whisper voice input.
- **Chrome Sync** (optional, on by default): memories, skills, agents and settings go to *your* Google account through Chrome. API keys are excluded unless you opt in.
- **Cloud history** (optional, off by default): conversations go to *your own* Supabase project, protected by row-level security.

There is no DeepPilot server, and there's no analytics or tracking.

## Built-in safeguards

- Web page text is treated as data: it is wrapped in `<untrusted_page_data>` markers with a random per-task id (look-alike markers in the page are removed), and the agent is instructed never to follow instructions found on pages.
- On high-stakes dashboards (DNS, ad spend, hosting, payments, cloud consoles) Save / Publish / Apply / Delete need your approval; "Always on this site" is remembered per site and can be reset in Settings.
- A blocklist in Settings keeps the agent away from sites it must never open or act on.
- Clicks that look like buying, sending, deleting or posting need your confirmation (Settings → *Ask me before…*), unless your own request already asked for exactly that action.
- The agent never types passwords, payment or personal data you didn't give it for the task. Logins, CAPTCHAs and 2FA are handed back to you.
- Sites that restrict automation (LinkedIn, Facebook, Instagram, X, email) are never worked on in parallel.

## Supported versions

Security fixes go into the latest release. Please keep DeepPilot up to date.
