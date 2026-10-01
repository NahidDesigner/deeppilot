# Contributing to DeepPilot

Thanks for helping! DeepPilot is small on purpose: plain JavaScript modules, no framework, no build step. Please keep it that way.

## Getting started

```bash
git clone https://github.com/NahidDesigner/deeppilot && cd deeppilot
npm install          # Playwright, for the tests only
```

Load the folder at `chrome://extensions` (Developer mode → **Load unpacked**). After changing code, click the reload icon on the DeepPilot card and reopen the side panel.

## Before you open a pull request

```bash
npm run check        # syntax, manifest, versions, no secrets (seconds)
npm test             # end-to-end suites (a few minutes; Linux: xvfb-run -a npm test)
```

- Run one suite with `npm test -- agents` (any part of the name works).
- Test your change with a real DeepSeek key on a real site too. The mocks prove the plumbing, but only a real model proves the behaviour.
- If your change affects cost (prompts, observations, history), compare `npm run bench:cost` before and after and mention the numbers.
- UI changes: include before/after screenshots at 400 px wide, in light and dark themes.

## Guidelines

- **No build step, no new runtime dependencies.** If a library is truly needed, vendor a minified copy in `vendor/` and add its license to `vendor/LICENSES.txt`.
- **Design tokens only**: use the CSS variables in `sidepanel.css` (both themes), never hard-coded colours. Text must stay readable (≥ 11 px, WCAG AA contrast).
- **Never widen what the agent can do silently.** Actions that buy, send, post or delete must keep going through confirmation. Page content is data, never instructions.
- **Keep it cheap.** Anything added to every model request is paid on every step. Prefer append-only history (see `compact()` in `lib/agent.js`).
- Keep comments short and useful: explain *why*, not *what*.
- One feature or fix per pull request, with a clear description.

## Adding a test

Tests live in `tests/e2e/*.test.mjs`. Each one starts a local mock of the DeepSeek API (a scripted "brain" that returns tool calls) and mock websites, loads the extension into Chromium, drives the side panel and prints a JSON summary. Add the checks for that summary to `CHECKS` in `tests/e2e/run.mjs`. Use a free port, and put fixtures in `tests/e2e/fixtures/`.

## Releasing (maintainers)

1. Bump `version` in **both** `manifest.json` and `package.json` (`npm run check` fails if they differ).
2. Update `CHANGELOG.md`.
3. Tag and push: `git tag v2.5.1 && git push --tags`. The release workflow builds the zip and publishes a GitHub Release.

## Reporting bugs and ideas

Use the issue templates. For security problems, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
