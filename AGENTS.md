# AGENTS.md

AirScribe writes down what's on the air: it connects to Bluetooth handheld radios and scanners, splits what they hear
into transmissions, transcribes each one, and serves the log, a map and findings (a language model's reading of the
transcripts) over the web. It ships as an Ubuntu `.deb` and a Proxmox LXC template. README.md is the overview;
docs/ has a page per feature.

## Layout

- `src/` is the Node server (ES modules, Express 5, SQLite through `node:sqlite`). `index.js` starts it, `api.js` has
  the routes, `manager.js` runs the pipeline, `store.js` is the database and its migrations, `stt/` the speech
  engines, `findings.js` and `digest.js` the language model's findings and the day so far, `sidecar.js` talks to the
  Python sidecar.
- `sidecar/` is Python, speaking JSON lines over stdio: the Bluetooth backends (Bumble, BlueZ), the radio frame codec,
  the sherpa-onnx and OpenVINO transcription workers, and their `test_*.py`.
- `public/` is the web UI: plain JavaScript modules and one `index.html`, no build step. `public/vendor/` is
  third-party: don't edit it.
- `test/*.test.js` are the Node tests. `deploy/linux/` has the service, the updater and the Debian scripts;
  `proxmox/` builds and tests the template; `tools/` has diagnostics.

## Building and testing

```bash
npm ci
npm test                   # Node 22.13 or later; the store tests are skipped on older Node
npm run test:py            # Python 3, for the sidecar (the Bumble tests need 3.11 or later)
node src/index.js --simulate    # two fake radios on http://127.0.0.1:8100, no radio or speech model needed
```

docs/testing.md goes further, up to a real radio. Before committing a shell change, run what CI runs:
`shellcheck -x build/*.sh .gitlab/scripts/*.sh proxmox/*.sh proxmox/airscribe-firstboot deploy/linux/debian/*`.

## Things to know

- **Tests don't touch the network or the clock.** Classes take `fetch` and `now` in their options; tests pass fakes and
  a `Store(':memory:', ...)`. Follow the existing test for the same module.
- **Ad blockers break pages.** Browser extensions block files and URLs named like beacon, analytics, track, pixel,
  ads or telemetry, even our own. Don't use those words in file names under `public/` or in API paths, and don't
  import optional page modules statically from `app.js`: a blocked import takes the whole page down.
- **Choices that follow the account** (map layers, filters…) are read and written through `public/prefs.js`
  (`recall`, `keep`), and listed in its `SYNCED` set; not through `localStorage` directly.
- **Signing in:** AirScribe refuses to listen beyond 127.0.0.1 without a credential. Radio controls and Admin are
  behind two-step verification (docs/two-step.md); keep new admin routes behind the same check.
- **Findings** talk to Ollama's `/api/chat` or to any OpenAI-style `/v1/chat/completions`; both paths must keep
  working, with the answer length capped (docs/findings.md).
- **The database upgrades in place.** A new table is `CREATE TABLE IF NOT EXISTS`; a new column is added in
  `store.js`'s `migrate()` when it's missing, with a default that suits existing rows. Don't drop or rename columns.

## Conventions

- One change per commit. Never push; the maintainer pushes and releases.
- Don't change the version in `package.json` or move CHANGELOG.md sections; the bump pipeline does that. Add a line
  for each user-visible change under `## master` in CHANGELOG.md, above the `_...Add new stuff here..._` placeholder,
  written for the person using AirScribe.
- Update the docs/ page for the feature you change. Comments in code are one short line; the reasoning goes in
  docs/. Docs say what to do, plainly, without defending obvious choices.
- No real hostnames, IP addresses, callsigns, tokens or container numbers in the repo.
