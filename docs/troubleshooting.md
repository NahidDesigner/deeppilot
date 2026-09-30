# Troubleshooting & FAQ

### "DeepPilot started debugging this browser" appears at the top
That's expected. Real mouse clicks, typing and background screenshots use Chrome's debugging protocol, and Chrome shows this bar whenever an extension uses it. It goes away when the task ends. Clicking **Cancel** stops the current task.

### Nothing happens when I click the icon
Make sure you're on a normal web page. Chrome doesn't allow extensions on `chrome://` pages, the Chrome Web Store or other extensions' pages. Also check Chrome is version 120 or newer (`chrome://settings/help`).

### "Add your DeepSeek API key first" / connection errors
Open **Settings → DeepSeek**, paste the key from [platform.deepseek.com](https://platform.deepseek.com), click **Test connection**, then **Save settings**. A `401` means the key is wrong; `402` means your DeepSeek balance is empty.

### It's slow
Speed depends mostly on your internet connection and computer. See the **[performance guide](performance.md)**. Quick fixes: use a stable connection, close heavy tabs, keep the laptop plugged in, and lower **Max parallel tabs** if your computer struggles.

### It said "done" but skipped part of my request
Say what's missing, *"you didn't create the PDF"*, and it continues. For big multi-part jobs, an **agent** with one stage per part is the most reliable approach.

### It clicked the wrong thing / got stuck on a popup
Press **Stop** and tell it what to do: *"close the cookie banner first"*, *"use the search box at the top"*. For pages where the layout matters (canvas apps, charts), make sure **vision** is on in Settings.

### It can't log in / hit a CAPTCHA
By design it doesn't type passwords you haven't given it. Log in or solve the CAPTCHA yourself in that tab, then answer its question (or say *"continue"*).

### LinkedIn or Google limited my account
Those sites restrict automated activity. DeepPilot keeps them to one tab at a time, but you should still keep batches small (for example 10–20 messages a day), stay human-paced, and follow each site's terms.

### Chrome Sync isn't syncing
1. Both computers are signed in to Chrome with the same Google account.
2. Chrome → **Settings → Sync and Google services → Manage what you sync** → **Extensions** is on.
3. Both computers run the same DeepPilot (same extension id, `hdcnglpkoadmkcnjmejcckcpjjbpofjn`; check at `chrome://extensions`).
4. Press **Sync now** in **Settings → Sync between computers**. The status line shows the last sync or an error. If it says storage is full, delete old agents or long memories: Chrome allows about 100 KB.

### I updated to v2.4 and my old data is gone
v2.4 gave DeepPilot a fixed extension id (needed for Chrome Sync), so Chrome treats it as a new extension. Data from older versions stays with the old one. If it's still installed, export your agents and skills there and import them into the new one. From now on, updates keep your data.

### The voice input doesn't understand me
Switch **Settings → Voice input → Engine** to **Whisper** and add a free Groq key. Pick your language (or *Detect automatically*), and add names and brand words under **Words it should know**.

### Where are my files?
Every file is in its chat (**History** → open the chat), with a Download button. Downloads go to your normal Downloads folder.

### How much will this cost me?
Usually 1–3 ¢ for a normal task and 5–15 ¢ for a 10-item agent run with files. The meter at the bottom shows the live cost, and **Max cost per run** caps agents. See [costs](../README.md#-what-it-costs).

### Still stuck?
[Open an issue](https://github.com/NahidDesigner/deeppilot/issues/new/choose) with what you asked, what happened, and a screenshot. Turn on the **steps** toggle first so the screenshot shows what it tried.
