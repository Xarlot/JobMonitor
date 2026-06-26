# Job Monitor

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
  logs: a **classic PAT with `repo` + `workflow`** (a read-only fine-grained PAT returns 404,
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

## Getting started

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # tsc --noEmit && vite build  -> dist/
npm run test           # vitest
VITE_MOCK=1 npm run dev  # offline UI with fixtures, no token / no rate-limit cost
```

> This repo pins **Node 20**. If `node` isn't on your PATH, install it (e.g. via nvm) before `npm install`.

### First run

1. Open **Settings**.
2. Paste a **fine-grained PAT** (see below) and choose a **passphrase** to encrypt it.
3. Set **upstream owner/repo**, **fork owner**, optional **branch filter** and **PR author**.
4. Add one or more **Flows** (workflow file + branches + optional events), or paste a JSON config.
5. On reload you'll be asked for the passphrase to decrypt the token for the session.

## Token (read-only)

Create a **fine-grained personal access token** scoped to the upstream repo with **read-only**:

- Pull requests: **Read**
- Actions: **Read**
- Checks: **Read**
- Commit statuses: **Read**

The token is sent only to `api.github.com`, is never written to localStorage/sessionStorage,
and is never logged.

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
src/mocks/                     VITE_MOCK fixtures + fetch
```

## Limitations

- Webhooks/live logs are out of scope (no upstream admin needed; polling only).
- Logs/jobs load lazily on expand; deep log streaming is not implemented.
