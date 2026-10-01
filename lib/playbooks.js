// Site Playbooks: expert know-how that is added to the agent's context the first time it reaches a
// matching site in a task. Built-in playbooks cover common dashboards; the agent (or the user) can save
// its own per domain ("learned"), which sync between computers with Chrome Sync.

const KEY = 'playbooks';

export const BUILTIN = [
  {
    name: 'Cloudflare dashboard', match: /(^|\.)dash\.cloudflare\.com$/,
    text: `- Structure: account home lists domains ("websites"). Open a domain to get its left navigation: Overview, DNS › Records, SSL/TLS, Security, Speed, Caching, Rules, Workers.
- DNS › Records: a table of records (Type, Name, Content, Proxy status, TTL) with an "Edit" link on each row — identify rows by Type + Name, never by position. "Add record" opens a form: Type, Name ("@" = root domain), IPv4 address / Target / Content, Proxy status toggle (orange cloud = Proxied, grey = DNS only), TTL. Click Save, then confirm the record appears in the table with the right values.
- Deleting a record: open the row's Edit, then Delete, then confirm.
- SSL/TLS › Overview sets the encryption mode (Off / Flexible / Full / Full (strict)). Caching › Configuration › "Purge Cache" (Purge Everything asks for confirmation).
- HIGH STAKES: DNS, SSL and security changes can take a website offline. Only change exactly what the user asked, never delete records you weren't asked to, and verify the result on the page after saving.`,
  },
  {
    name: 'Meta Ads Manager', match: /(^|\.)(adsmanager|business)\.facebook\.com$/,
    text: `(Tested on the live Ads Manager, October 2026 — Meta changes this screen often; trust the page state over these notes.)
- Hierarchy: Campaign › Ad set › Ad. Tabs "Campaigns", "Ad sets", "Ads" switch the table level; selecting a row's checkbox filters the next level to it.
- The table is large and virtualized: use find / extract to locate a row by name and read metrics instead of scrolling. Columns and the date range (top right) change what numbers you see — mention the date range when reporting results.
- Creating: "Create" › pick the objective › Continue › choose the MANUAL setup type when asked › Continue. The editor opens on the campaign; "Next" (bottom right) goes to the ad set, then to the ad. Close first-run tours and "what's new" boxes before you start.
- The editor body scrolls inside its own panel, not the window: plain scroll works (DeepPilot scrolls the panel), and find jumps to a section such as "Budget & schedule" or "Audience controls".
- Budget: in "Budget & schedule" type the number into the budget field (it is pre-filled with a default), press Tab, and read back "We'll spend around …" to confirm.
- Locations, age and other audience rows show their value as text with an Edit pencil that appears when the row is hovered. Click the row's Edit control; if it isn't listed, hover the row first. Locations: add the new country from the search box and pick the suggestion marked "Country", then remove the default with the X on its chip — a default can only be removed once another location exists.
- Age: with Advantage+ audience on (the default) the only hard limit is "Minimum age"; a full range such as 25–45 is entered as an age suggestion, or as a hard limit after choosing "Further limit the reach of your ads" / switching to the original audience options. Look for those before reporting that a maximum age is unavailable, and tell the user which of the two you set.
- Do NOT press Escape inside the editor — it closes the whole editor. Close pickers by clicking an empty area of the panel.
- Everything is saved automatically as a draft. Closing the editor (X) shows "Publish draft items?": click "Close" to keep the draft. Draft rows show Delivery "In draft". "Review and publish" and "Discard drafts" are in the top bar — leave both alone unless asked.
- Each row has an on/off toggle in the first column. Budgets live on the campaign (Advantage campaign budget) or on the ad set. Nothing goes live before "Publish".
- HIGH STAKES (real money): never publish, turn on ads, or raise budgets/bids unless the user explicitly asked for that exact change; state the old and new values in your answer. If a payment method or identity check is requested, stop and tell the user.`,
  },
  {
    name: 'cPanel', match: /(:2083|:2082|cpanel)/i,
    text: `- The home page has a "Search Tools" box at the top — type the tool name (e.g. "File Manager", "Email Accounts", "Zone Editor") instead of scrolling the sections.
- Common tools: File Manager (files; toolbar Upload / + File / + Folder; right-click an item for Edit/Rename/Delete), Email Accounts, MySQL Databases, phpMyAdmin (opens in a new tab), Domains, Zone Editor (DNS), SSL/TLS Status, WordPress / Softaculous installers, Backup.
- Several tools open in new tabs or use frames — the page state lists frame elements under "INSIDE FRAME".
- HIGH STAKES: deleting files, databases or email accounts is permanent — only do it when explicitly asked and confirm the exact item names.`,
  },
  {
    name: 'WordPress admin', match: /\/wp-admin|\/wp-login\.php/,
    text: `- Left menu: Posts, Media, Pages, Plugins, Appearance, Users, Settings. Plugins › Add New › search › "Install Now" › "Activate".
- Block editor: title field at the top, "+" opens the block inserter, text is typed into editable blocks. "Publish" (or "Update") is top right; the first Publish opens a pre-publish panel that needs a second Publish click. "Save draft" keeps it private. Featured image is in the right sidebar (Post tab).
- Elementor: the page canvas is inside an iframe (its elements appear under INSIDE FRAME); the widget panel is on the left; click a widget in the canvas to edit it in the left panel; "Update"/"Publish" is at the bottom of the left panel.
- After saving, confirm the success notice (ALERT line) or reload the page to verify.`,
  },
  {
    name: 'Hostinger hPanel', match: /(^|\.)hpanel\.hostinger\.com$/,
    text: `- Websites list › "Manage" (or "Dashboard") on the website opens its sidebar: Files (File Manager), Databases, Emails, Domains, WordPress, Performance, Advanced.
- Domains › pick the domain › "DNS / Nameservers" to manage records (Type, Name, Points to, TTL, Add Record).
- Many sections load slowly; wait for tables to appear before reading them.`,
  },
  {
    name: 'GoDaddy', match: /(^|\.)godaddy\.com$/,
    text: `- Domains: "My Products" / Domain Portfolio › select the domain › "DNS" (Manage DNS) › DNS Records table › "Add New Record" (Type, Name — "@" is the root domain, Value, TTL) › Save. Nameservers are on the same DNS page.
- Upsell pop-ups are common — close them with their X and continue.`,
  },
  {
    name: 'Namecheap', match: /(^|\.)namecheap\.com$/,
    text: `- Domain List › "Manage" next to the domain › "Advanced DNS" tab › "Add New Record" (Type, Host — "@" is the root, Value, TTL) › click the green check mark on the row to save it.
- Nameservers are set on the Domain tab ("Nameservers" dropdown: Namecheap BasicDNS / Custom DNS).`,
  },
  {
    name: 'Google Ads', match: /(^|\.)ads\.google\.com$/,
    text: `- Left navigation: Campaigns (Campaigns / Ad groups / Ads & assets / Keywords), Goals, Tools. The date range picker is top right.
- Changes (status, budgets, bids) apply immediately when saved — there is no separate publish step. Only change what the user asked; report old and new values.
- Tables are long: use find / extract by campaign name.`,
  },
  {
    name: 'Google Search Console', match: /search\.google\.com\/search-console/,
    text: `- The property selector is at the top left. "Performance" shows clicks/impressions; the tabs below the chart are Queries, Pages, Countries, Devices; "Export" is top right. The date range is a filter chip above the chart.
- The "Inspect any URL" bar at the top checks indexing of one URL; "Request indexing" appears on the result.
- Indexing › Pages lists why pages aren't indexed (click a reason to see the URLs).`,
  },
  {
    name: 'Google Analytics', match: /(^|\.)analytics\.google\.com$/,
    text: `- Reports › Life cycle › Acquisition / Engagement / Monetization; the date range is at the top right of each report. Use extract to read the report table instead of scrolling.
- The property/account switcher is at the top left.`,
  },
  {
    name: 'LinkedIn', match: /(^|\.)linkedin\.com$/,
    text: `- Connections: linkedin.com/mynetwork/invite-connect/connections/ (sorted by recently added). Each card has a "Message" button that opens a chat overlay at the bottom right.
- Chat overlays stay open across pages and pile up; close each one with its X ("Close your conversation") — Escape doesn't close them. When an overlay opens, earlier messages in it mean you've already written to this person.
- Messaging search results load late; trust the conversation you open over search results.
- Keep a human pace and small batches; LinkedIn limits automated activity and may restrict accounts.`,
  },
  {
    name: 'Facebook', match: /^(www\.|m\.|web\.)?facebook\.com$/,
    text: `- Posting: click the composer ("What's on your mind"), type in the dialog, then "Post" (it may take a moment to appear). Pages and groups have their own composer.
- Meta Business Suite (business.facebook.com/latest) is better for scheduling posts and the inbox.
- Many menus are "…" buttons without text — rely on the "— in:" context and the screenshot.`,
  },
  {
    name: 'Gmail', match: /(^|\.)mail\.google\.com$/,
    text: `- "Compose" opens a draft window: To (type an address, then Enter or Tab to turn it into a chip), Subject, body, then "Send". Check the recipient chip before sending.
- Search supports operators: from:, to:, subject:, has:attachment, newer_than:7d, is:unread.
- Threads open in place; use back (the arrow) to return to the list.`,
  },
  {
    name: 'Canva', match: /(^|\.)canva\.com$/,
    text: `- The design is drawn on a canvas: the element list shows toolbars and panels only. Select objects with click_xy on the screenshot; double-click text to edit it; Ctrl+A selects all text in the box being edited.
- Left panel: Design (templates, styles), Elements, Text, Uploads, Tools. Share › Download › choose "PDF Standard" or "PDF Print" to export.
- If a design edit fails twice, stop and offer the user options (or build the document with create_file) instead of experimenting.`,
  },
  {
    name: 'Google Sheets', match: /docs\.google\.com\/spreadsheets/,
    text: `- The grid is a canvas. Jump to a cell with the Name box (top left, type e.g. "B2" then Enter), type the value, press Enter (moves down) or Tab (moves right).
- Reading data: extract or File › Download is more reliable than reading cells one by one.`,
  },
  {
    name: 'Shopify admin', match: /admin\.shopify\.com|\.myshopify\.com\/admin/,
    text: `- Left navigation: Orders, Products, Customers, Content, Analytics, Marketing, Discounts, Online Store, Settings.
- After editing a product or setting, a "Save" bar appears at the top — click Save and wait for the "saved" toast.`,
  },
];

// Generic advice for dashboards that have no playbook.
export const GENERIC_DASHBOARD = `- Dashboards: find the left/top navigation first; use find to jump to a setting by name; tables are read with extract; after Save, confirm the success message (ALERT line) or that the table shows the new value.`;

const norm = d => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();

export async function loadUserPlaybooks() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return Array.isArray(list) ? list : [];
}

// Save (or merge into) the learned playbook for a domain.
export async function saveUserPlaybook(domain, notes) {
  const d = norm(domain);
  const text = String(notes || '').trim().slice(0, 3000);
  if (!d || !text) throw new Error('Give the domain and the notes to save.');
  const list = await loadUserPlaybooks();
  const cur = list.find(p => p.domain === d);
  if (cur) { cur.text = text; cur.updatedAt = Date.now(); }
  else list.push({ id: crypto.randomUUID(), domain: d, text, createdAt: Date.now(), updatedAt: Date.now() });
  await chrome.storage.local.set({ [KEY]: list.slice(-100) });
  return d;
}

export async function deleteUserPlaybook(id) {
  await chrome.storage.local.set({ [KEY]: (await loadUserPlaybooks()).filter(p => p.id !== id) });
}

// Playbooks for a URL: built-in ones whose pattern matches, plus the user's learned notes for the domain.
export async function playbooksFor(url) {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch (_) { return []; }
  const out = [];
  for (const p of BUILTIN) if (p.match.test(host) || p.match.test(url)) out.push({ name: p.name, text: p.text, builtin: true });
  const d = host.replace(/^www\./, '');
  for (const p of await loadUserPlaybooks()) if (d === p.domain || d.endsWith('.' + p.domain)) out.push({ name: `Your notes for ${p.domain}`, text: p.text, builtin: false });
  return out;
}
