# Job Monitor — Development & Architecture

> Developer-facing notes (build, deploy, internals). For the **user guide**, see [README.md](README.md).

A **frontend-only** GitHub Actions dashboard (React + Vite, GitHub's Primer design system).
It watches your fork → upstream pull requests and configurable workflow "flows" — no backend,
no webhooks. Data is read directly from `api.github.com` with a read-only PAT that is stored
**encrypted** in your browser.

## Features

- **Overview** — the landing tab: a tile per PR (by title, with status + branch) and a tile
  per flow (showing its **latest run** — title, event, when). Clicking a PR tile opens the
  Pull requests tab; clicking a flow tile jumps to the Flows tab and highlights that flow.
- **PR dashboard** — open PRs from your fork into upstream, with an aggregated status
  (success / failure / pending / in progress) and an expandable list of check-runs + commit
  statuses. Filters: All / Active / Failed / Success. Manual refresh.
- **Flows** — a master-detail grid (TanStack Table) per configured flow: workflow **runs** as
  master rows, **jobs** as lazily-loaded detail rows. Filter runs by branch and event
  (e.g. `workflow_dispatch`). Expand/collapse state is persisted and **invalidated on critical
  changes** (re-run or new commit) so stale detail is never shown.
- **Job summary & logs** — each job row has three icon buttons (with tooltips): **Summary**
  (a dialog with the job's annotations — failure/warning/notice + file:line + message — and a
  step status breakdown), **Logs** (a dialog where each step expands to show its log lines,
  fetched once per job and split by step timestamps), and **Open on GitHub**. The job-logs
  endpoint is CORS-enabled, so logs render in-app — but it requires a token that can download
  logs: a **classic PAT with the `repo` scope** (a read-only fine-grained PAT returns 404,
  and the Logs dialog then links out to GitHub).
- **Timeline (Gantt)** — a button on each PR and flow run opens a Gantt-style timeline: bars
  positioned by start offset and sized by duration. For flow-run jobs, each bar is split into
  **runner allocation** (queue + “Set up job”) and **payload** (actual work) so slow setup vs
  slow work is obvious.
- **Overall summary** — a button on each flow run and PR opens a summary: a status roll-up plus
  the **actual annotation content** (errors/warnings with file:line + message) of every job/check
  that needs attention. (Per-job/check Summary shows that one's annotations; the run/PR summary
  shows them all.) GitHub's `$GITHUB_STEP_SUMMARY` markdown isn't exposed by the API, so
  annotations are the summary content shown.
- **PR checks = flow jobs** — PR check-runs get the same per-check Summary / Logs / GitHub
  buttons as flow jobs (the job is resolved from the check-run's `details_url`).
- **All run jobs fetched** — job lists are paginated, so a run with >100 jobs still surfaces a
  failing job beyond the first page (previously a run could read `failure` while all visible jobs
  were green).
- **Request stats** — a header badge shows API requests in a **sliding 1-hour window** against the
  hourly limit (`N / 5000/h`); tooltip breaks down fresh / cached-304 / error + remaining. Events
  are persisted and pruned to the window.
- **Caching with TTL** — fetched job logs are cached in memory (reused when re-opening a dialog),
  the persistent ETag cache and flow-runs cache carry timestamps and are evicted past their TTL.
- **Compact view** — an **All / Compact** toggle in both the Flows and Pull-requests tabs
  (persisted, lives in the tab — not Settings). Compact hides quiet items (success + skipped)
  from the job/check lists so only failures and in-progress/pending work shows.
- **Flow filters** — filter runs by status (All / Active / Failed / Success) and by a
  **job condition**: runs that contain a job whose name matches and that is e.g. *not skipped*,
  succeeded, failed, or in progress. The job filter loads jobs for all runs to evaluate.
- **Per-flow empty filter** (Settings) — each flow can opt in to "Hide when empty" and choose
  the signal: *no runs* (misconfigured / never triggered), *only skipped runs*, *no / tiny
  artifacts* (latest completed run's total `size_in_bytes` at/below a KB threshold), or *a job
  in a state* (latest run has a job whose name contains X and is e.g. skipped — "if a `test`
  job was skipped, hide the flow"). Hidden flows drop from both the Flows view and the Overview.
- **Cached on reload** — flow runs render instantly from a local cache on reload, and the
  ETag cache is persisted so the first refresh is a cheap `304`.
- **Secure token storage** — the PAT is encrypted with AES-GCM using a key derived from your
  passphrase (PBKDF2-SHA256). Only the `{salt, iv, ciphertext}` envelope is persisted (IndexedDB);
  the plaintext lives only in memory. "Forget token" wipes both.
- **Rate-limit aware** — every GET uses ETag / `If-None-Match`; `304` responses don't cost quota
  and don't churn state. A badge shows remaining/limit + reset countdown and warns when low or
  throttled (with backoff on 403/429).
- **Polling, not realtime** — PR list & flow runs poll slowly (~3 min), active checks/jobs every
  ~60 s, completed items aren't polled, and everything slows down when the tab is hidden.
- **Desktop notifications** — opt-in (Settings), separately for **PRs** and **Flows**. A system
  notification fires when a tracked PR's checks finish or a flow run completes — only on an observed
  *in-progress → finished* transition, so reloads and already-done items never spam you. Uses the
  browser's Web Notification permission; nothing leaves the browser.

## Getting started

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # tsc --noEmit && vite build  -> dist/
npm run test           # vitest
VITE_MOCK=1 npm run dev  # offline UI with fixtures, no token / no rate-limit cost
```

> **Node ≥ 22.12 is required** (the repo pins **Node 24** in `.nvmrc`). This is enforced:
> `npm install` aborts with `EBADENGINE` on older Node, and the `electron:*` scripts run a
> `check-node` preflight first. The reason is Electron's installer — it `require()`s the ESM-only
> `@electron/get`, which only works on Node ≥ 22.12 (older Node fails with `ERR_REQUIRE_ESM` and the
> Electron binary never downloads). With nvm: `nvm use` (reads `.nvmrc`), or `nvm install 24 && nvm use`.

### Publish via GitHub Pages

A workflow (`.github/workflows/deploy-pages.yml`) builds the app and deploys it to GitHub Pages
on every push to `master` (or via **Run workflow**). One-time setup:

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `master` — the site publishes to `https://<owner>.github.io/<repo>/`.

The production build uses a **relative base** (`./`), so it works under the `/<repo>/` subpath.
It's a static, backend-less site: each visitor enters their own PAT, encrypted in their browser;
nothing is sent anywhere except `api.github.com`.

## Desktop app (Windows / macOS / Linux)

An **Electron** wrapper ships the same UI as a native app — so it can live in the system tray
and fire OS notifications even when the window is closed (the GitHub Pages site stays available
for browser users too). The desktop app **bundles** the built UI (no dependency on Pages being up).

- **Tray** — closing the window hides it to the tray; the app keeps polling in the background
  (`backgroundThrottling` is off) so completion notifications still arrive. Tray menu: Open /
  Check for updates / About / Exit. Single-instance.
- **System notifications** — the same opt-in PR/Flow notifications (Settings) render as native OS
  notifications; Electron grants the Notification permission by default.
- **Auto-update** — `electron-updater` checks GitHub Releases on launch (and every 6 h), downloads
  in the background, and installs on restart. Toggleable in **Settings → Updates**; only
  active where the build can self-update (NSIS / dmg / AppImage — not a `.deb` or a dev run).
- **Window state** — position/size are remembered and validated against the current displays so the
  window can't reopen off-screen.
- **Remember passphrase** — optionally stored in the OS keychain (`safeStorage`) to auto-unlock.

### Build locally

```bash
npm run electron:dev      # build the UI + run the app
npm run electron:dist     # build installers into release/ (current OS only)
```

For a live HMR dev loop: run `npm run dev` in one terminal, then
`ELECTRON_RENDERER_URL=http://localhost:5173 electron .` in another.

`npm run icons` rasterizes `build/icon.svg` → `build/icon.png` (+ tray icon) via `@resvg/resvg-js`;
the `electron:*` scripts run it automatically.

### Installers & releases (CI)

`.github/workflows/desktop-release.yml` builds on a **win / mac / linux** matrix and uploads
installers to a **GitHub Release** (NSIS `.exe`, `.dmg`/`.zip`, `AppImage`/`.deb`). To cut a release:

```bash
npm version patch          # bumps package.json + tags vX.Y.Z
git push --follow-tags
```

The workflow also **derives the release version from the tag** (so a manually-created `vX.Y.Z`
tag publishes `vX.Y.Z` even if `package.json` wasn't bumped). It publishes a **draft** Release —
review it, then click **Publish** on GitHub. electron-updater serves auto-updates only from
*published* releases, and only when the release assets are **publicly** downloadable.

> **Code signing:** CI builds are **unsigned** (no Apple/Windows certs), so first launch shows a
> Gatekeeper / SmartScreen warning. Add `CSC_LINK`/`CSC_KEY_PASSWORD` (Win) and Apple notarization
> secrets later to remove it.

## Token

Use a **classic personal access token** with the **`repo`** scope (or **`public_repo`** if the
repo is public). That grants read access to PRs, checks, commit statuses, Actions runs, jobs, and
**logs**. The app only makes read (GET) requests.

> A read-only **fine-grained** PAT works for most data, but **can't download Actions logs**
> (GitHub returns 404 for the logs endpoint), so the per-step logs feature needs a classic
> `repo` token. Annotations, statuses, timelines and summaries work with either.

The token is encrypted (AES-GCM, key derived from your passphrase) and stored only in this
browser's IndexedDB; the plaintext is only in memory, never logged, and sent only to
`api.github.com`.

## Configuration (JSON)

The monitor config is validated with zod and can be edited via the Settings form or imported/
exported as JSON:

```json
{
  "version": 1,
  "upstream": { "owner": "acme", "repo": "rocket" },
  "fork": { "owner": "octodev", "branch": null },
  "prAuthor": "octodev",
  "polling": { "prListSeconds": 180, "checksSeconds": 60, "flowRunsSeconds": 180, "hiddenSeconds": 240 },
  "notifications": { "pr": false, "flow": false },
  "autoUpdate": true,
  "rateLimitWarnAt": 50,
  "flows": [
    {
      "id": "uuid",
      "name": "CI",
      "owner": "acme",
      "repo": "rocket",
      "workflowFile": "ci.yml",
      "branches": ["main", "release/*"],
      "events": ["workflow_dispatch", "push"],
      "maxRuns": 5,
      "emptyFilter": { "enabled": false, "by": "no_runs", "minArtifactKB": 0, "jobName": "", "jobState": "skipped" }
    }
  ]
}
```

Flow `owner`/`repo` default to upstream when omitted. Empty `events` means any event.

## Security / deployment notes

- A strict **Content-Security-Policy** is injected into the production `index.html`
  (`connect-src` limited to `https://api.github.com`, `script-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, …). When hosting, also send it as a real **HTTP header**. The dev
  server relaxes `script-src`/`connect-src` for HMR only.
- Clickjacking guard: a small frame-buster runs in `main.tsx` (GitHub Pages can't send
  `X-Frame-Options` / a header CSP).
- `style-src` includes `'unsafe-inline'` because Primer (styled-components v5) injects styles at
  runtime.
- No third-party runtime scripts, no analytics — everything is bundled by Vite.
- Workflow runs are **monitored only**; the read-only PAT cannot trigger `workflow_dispatch`.

## Architecture

```
src/crypto/webcrypto.ts        PBKDF2 + AES-GCM
src/storage/                   IndexedDB (secret) + localStorage (config, expand-state)
src/api/                       githubClient (ETag/304), rateLimit, endpoints, types
src/hooks/                     usePolling, useVisibility, useGitHubDashboard, useFlows, useExpandState
src/context/                   Auth + Config providers
src/components/                PrList, CheckRunsTable, FlowRunsGrid, JobsTable, SettingsPage, …
src/lib/                       status/completion/flowFilter/flowEmptiness helpers
src/mocks/                     VITE_MOCK fixtures + fetch
electron/                      Electron main + preload (tray, notifications, auto-update, window state)
```

## Limitations

- Webhooks/live logs are out of scope (no upstream admin needed; polling only).
- Logs/jobs load lazily on expand; deep log streaming is not implemented.
