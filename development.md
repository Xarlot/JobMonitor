# Job Monitor — Development & Architecture

> Developer-facing notes (build, deploy, internals). For the **user guide**, see [README.md](README.md).

A **frontend-only** GitHub Actions dashboard (React + Vite, GitHub's Primer design system).
It watches your fork → upstream pull requests and configurable workflow "flows" — no backend,
no webhooks. Data is read directly from `api.github.com` with a PAT that is stored **encrypted**
in your browser.

**Reading is the default; writing is exceptional and enumerated.** Every write the app can make
is listed here, and every one of them is either behind an explicit click or off by default:

| Write | Reached by | Default |
| --- | --- | --- |
| `POST .../actions/runs/{id}/rerun-failed-jobs` | the re-run button, or the auto-rerun engine | engine off |
| `PATCH .../pulls/{n}` (clears the body) | the arm-auto-merge dialog only | on click |
| `POST /graphql` — `enablePullRequestAutoMerge` | arming auto-merge, either tab | on click |
| `POST .../pulls` | the Feature branches tab | on click |
| `POST .../git/refs` (the sync branch) | the Feature branches tab | on click |
| `POST .../merge-upstream` | the Feature branches tab | on click |

**Nothing in this app merges a pull request.** Every action arms auto-merge and lets GitHub do it,
which is why `PUT .../pulls/{n}/merge` is absent from the table — the "Merge now" path it served was
removed with the clean-versus-blocked branching in `finishMerge`.

Nothing writes on a timer except the auto-rerun engine, which re-runs failed jobs and does
nothing else. Every write control is hidden outright unless the token is *proven* able to
perform it — see [Token capability](#token-capability) — and `ghWriteRaw` enforces that in one
place rather than trusting each caller to have checked.

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
- **Feature branches** (opt-in tab) — branches under a prefix (`feature/` by default) that exist
  in **both** the fork and the upstream. Per branch: how the two copies stand (`compare` in the
  fork with the upstream's commit as `{owner}:{sha}`, only when the tips differ — the direction is
  what decides whether the fork sync fast-forwards or writes a merge commit) and a **stage strip**
  for each of its two pull requests (opened → checks → mergeable → auto-merge armed → merged) and the reason it is stuck,
  read from `mergeable_state`, which only the single-PR endpoint carries. Three actions, each
  confirming first and reporting which of its steps ran: **sync** (a pull request from the default
  branch into the feature branch, armed if GitHub will queue it and merged if it won't — GitHub
  refuses auto-merge on a pull request it could merge already), **ship** (the reverse direction,
  armed but never merged unprompted), and **pull into my fork** (`merge-upstream`). Its pull
  requests are handed to the auto-rerun engine, since the PR tab's fork-head filter cannot see
  them. Desktop-only extra: the ship pull request's title and description are written by `claude`.
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
- **Regex flows** — a flow can name a **regex** instead of one workflow: the repo's workflow list is
  fetched once per repo (ETag-cached, re-polled every 15 min) and every match becomes its own flow —
  own runs, own filters, own place in a group. Matching is against the workflow name, its file name
  or either, case-insensitive by default, capped by `maxMatches`.
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
- **Desktop notifications** — opt-in (Settings), separately for **PRs**, **Flows** and
  **auto-reruns**. A system notification fires when a tracked PR's checks finish or a flow run
  completes — only on an observed *in-progress → finished* transition, so reloads and already-done
  items never spam you. Uses the browser's Web Notification permission; nothing leaves the browser.
- **Arm auto-merge** (manual, a write) — clears a PR's description, then enables auto-merge. The one
  place the app speaks **GraphQL**: `enablePullRequestAutoMerge` has no REST equivalent. See
  `src/api/autoMerge.ts`.
- **Auto-rerun failed jobs** (opt-in, a write) — for a PR with **auto-merge armed**, when a
  run of a listed workflow file finishes as `failure`/`timed_out`, its failed jobs are re-run.
  Never for `cancelled` (usually deliberate) or `action_required` (needs a human). Two brakes:
  `maxAttempts` against GitHub's own `run_attempt`, and `maxIdenticalFailures` — how many times in a
  row the same failure fingerprint may come back before it counts as real rather than flaky. Unlike
  the notification path the trigger is **state-based**, so a run that failed while
  the app was closed is still picked up — which is why the attempt log is persisted
  (`src/storage/rerunStore.ts`), or every reload would re-POST.
- **Failures tab** — every failing job across open **and** recently-merged PRs **and** the latest run
  of each tracked flow, refreshed by the existing polls, each with a Markdown report (test names from
  annotations + the failing step's log tail) formatted for a GitHub issue or a Teams message.
  Split into **Pull requests** / **Flows** sections, each holding a group per PR or flow. Groups start
  **collapsed** and sections start open, so each is persisted as its exceptions
  (`src/storage/failureGroupsStore.ts`); prefetching is scoped to the rows actually on screen, so a
  closed group costs nothing. Both panes fill the viewport via a measured height
  (`src/hooks/useFillHeight.ts`) rather than a `calc(100vh - …)` offset, since the chrome above varies.
- **A one-week scan window** (`SCAN_WINDOW_MS` in `src/lib/failures.ts`, matching the cache TTL) bounds
  what the tab considers — and, importantly, what it *fetches*: a flow whose latest run failed longer
  ago than that gets no job-list request, and merged PRs are filtered by `merged_at` before their
  checks are read. Without it a months-red nightly or a long tail of stale PRs would cost requests
  every poll forever.
- **Week-long failure caches** — a finished job's annotations, log tail and a run's job list are
  immutable, so they are cached in localStorage for 7 days (`src/storage/failureCaches.ts`) and the
  tab hydrates from them, making a revisit cost zero requests. Keys are attempt-unique (a re-run
  mints new check-run/job ids), which is what makes a week safe. The shared
  `src/storage/localTtlCache.ts` enforces entry *and* byte caps, because `githubClient` reacts to a
  localStorage quota error by wiping its whole ETag namespace — an unbounded cache here would
  degrade something unrelated.
- **Merged PRs** — a bounded list of recently-merged PRs polled alongside the open ones, so a
  failure that landed anyway stays reviewable. Their checks are terminal, so each is fetched once
  and then skipped by `needsChecks` forever.
- **Explain with Claude** (desktop only, two depths) — shells out to the developer's own `gh` and `claude` CLIs to
  turn a failed job into a problem statement plus a suggested fix. See
  [Local CLI integration](#local-cli-integration).

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
nothing is sent anywhere except `api.github.com`. This stays true with telemetry in the tree —
collection lives entirely in the Electron main process, so the hosted build has no code path that
can record or transmit anything.

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
repo is public and you only want to read). That grants read access to PRs, checks, commit
statuses, Actions runs, jobs, and **logs** — and, for `repo`, the Actions write access that
re-running failed jobs needs.

> A read-only **fine-grained** PAT works for most data, but **can't download Actions logs**
> (GitHub returns 404 for the logs endpoint), so the per-step logs feature needs a classic
> `repo` token. Annotations, statuses, timelines and summaries work with either.

The token is encrypted (AES-GCM, key derived from your passphrase) and stored only in this
browser's IndexedDB; the plaintext is only in memory, never logged, and sent only to
`api.github.com`.

### Token capability

`src/api/tokenCapability.ts` decides whether the token may re-run jobs, and every write control is
gated on it. `canRerun` starts `false` and only a positive check flips it, so a button can never
render before the answer is known.

```
scopes = response.headers.get('X-OAuth-Scopes')   // null ⇒ header absent
if (scopes !== null)   // classic PAT / OAuth token
  canRerun = scopes.includes('repo') && repo.permissions.push === true
else                   // fine-grained PAT, app token, unknown
  canRerun = false
```

Why it is shaped this way:

- **Scopes are free.** GitHub lists `X-OAuth-Scopes` in `Access-Control-Expose-Headers`, so the
  browser can read it off responses the app already makes — `recordTokenScopes` is called from
  `ghGet`/`ghPost` on *every* status (200, 304, 403), since the header is always present.
- **`repo` only.** `public_repo` alone is not documented as sufficient for the re-run endpoints, and
  the `workflow` scope governs workflow *file contents*, not run control. GitHub omits `public_repo`
  from the header when `repo` is present, so `repo` is expanded rather than looked for twice.
- **Scope is a ceiling, not a grant.** Re-running needs the **Write** repository role too, so
  `permissions.push` from `GET /repos/{owner}/{repo}` must agree — otherwise a `repo`-scoped token
  belonging to a read-only collaborator would show the control and then 403. `useCapabilityProbe`
  only spends that request when the scope check already passed.
- **Fine-grained PATs are unverifiable, so they are treated as read-only.** There is no
  token-introspection endpoint for them; `X-Accepted-GitHub-Permissions` is *not* CORS-exposed so a
  browser can never read it; and no side-effect-free probe exists, because every repo-level Actions
  `GET` needs only `actions: read`. `permissions.push` cannot substitute — it reports the **user's**
  role, not the token's grants (`GET /repos` needs only `metadata: read`). There is deliberately no
  override: a fine-grained token never gets the feature, and Settings → Token says so.

Token prefixes (`ghp_`, `github_pat_`, legacy 40-char hex) are used *only* to word that message —
they are changelog convention, not an API contract. Capability is decided by the header.

A `403` whose message begins `Resource not accessible by` flips `canRerun` off, so the feature hides
itself rather than retrying against a wall.

### The one write

`ghPost` (`src/api/githubClient.ts`) is separate from `ghGet` on purpose: never conditional, never
cached (a write has no cacheable representation), and it never parses the response body on success —
the re-run endpoints answer `201` with an empty body, and `res.json()` would throw a bare
`SyntaxError` outside the `GitHubApiError` contract callers rely on.

Failures are classified into a `WriteRefusal` so callers can tell "retry later" from "this run is a
lost cause" from "hide the feature". Matching is by substring, never equality:

| Signal | Meaning | Handling |
|---|---|---|
| `retry-after`, or `/secondary rate limit/i` | secondary limit | retryable; attempt not recorded |
| `x-ratelimit-remaining: 0` | primary limit | retryable |
| `Resource not accessible by …` | token can't write | `canRerun = false`, feature hides |
| `…created over a month ago` | past GitHub's 30-day window | permanent for that run only |
| **`404`** | private repo hides itself from an under-scoped token | a refusal, **not** a missing run |
| any other `403` | token grant vs. repo role, indistinguishable | attempt recorded so it isn't hammered |

The `404` row is the easy one to get wrong: read as "run gone", it would retry forever.

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
  "notifications": { "pr": false, "flow": false, "autoRerun": false },
  "prAutoRerun": {
    "enabled": false,
    "workflowFiles": ["check-pull-request-java.yml"],
    "maxAttempts": 10,
    "maxIdenticalFailures": 5,
    "maxRunAgeHours": 72
  },
  "mergedPrs": { "count": 10 },
  "failureReports": { "prefetchAnnotations": true, "logTailLines": 80, "format": "github" },
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
      "emptyFilter": { "enabled": false, "mode": "hide", "by": "no_runs", "minArtifactKB": 0, "jobName": "", "jobState": "skipped" },
      "match": { "pattern": "", "by": "name", "caseSensitive": false, "maxMatches": 12 }
    },
    {
      "id": "uuid-2",
      "name": "nightly",
      "branches": ["main"],
      "events": [],
      "maxRuns": 5,
      "match": { "pattern": "^nightly-", "by": "file", "caseSensitive": false, "maxMatches": 12 }
    }
  ],
  "groups": [{ "id": "g1", "name": "Nightly", "flowIds": ["uuid-2"], "collapsed": false }],
  "ungroupedOrder": []
}
```

Flow `owner`/`repo` default to upstream when omitted. Empty `events` means any event.

There is **no migration step** — `version` is a hard `z.literal(1)` and `loadConfig` falls back to
`DEFAULT_CONFIG` on any parse error. So every new field **must** carry a `.default()`/`.prefault()`,
or an existing user's stored config would fail to parse and be silently wiped. `DEFAULT_CONFIG` and
`MOCK_CONFIG` are hand-written literals typed `MonitorConfig`, so `tsc` flags them when a field is
added; `config.test.ts` also asserts they match the schema's own defaults.

`autoMerge.mergeMethod` is stored lower-case and upper-cased at the call site, because the GraphQL
`PullRequestMergeMethod` enum is upper-case and a mismatch is a 400 rather than a helpful error. There
is no `enabled` flag: the button is gated on write capability like every other write control, and a
click is its own authority. Arming is *not* idempotent — GitHub errors on an already-armed PR — which
is why the button is absent rather than disabled for those.

`prAutoRerun.workflowFiles` holds **exact file names** — never patterns, so the allow-list cannot
widen by accident. `maxAttempts` is compared against GitHub's `run_attempt`, which is why the limit
survives restarts without any local bookkeeping.

`maxIdenticalFailures` replaced a `stopOnIdenticalFailure` boolean, which was the same rule with the
count hard-wired to 2. It is a **consecutive** streak of matching fingerprints, so one different
failure starts it over, and it spans `attempts` *and* `declined` — otherwise re-running by hand would
reset the count and the tolerance would never run out. `0` disables the brake (and with it the
annotation fetches behind each fingerprint); `1` needs no special case, since the first failure is
already one occurrence. A config still holding the old boolean parses fine and takes the current
default: the key has no counterpart to migrate to, and zod strips it.

`match.pattern` turns a flow into a **regex flow**: `workflowFile` is then unused, and the flow is
expanded into one flow per matching workflow of the repo (`match.by` selects what the regex is
tested against: `name`, `file` or `any`). The expansion is virtual — derived flows are never
persisted — but their ids are stable (`<flowId>::<workflow file>`), so `groups[].flowIds`,
`ungroupedOrder`, the run cache and expand state all stick to them. A `flowIds` entry that names the
*regex flow itself* means "every match that isn't placed by hand", which is how a pattern's matches
(including ones that appear later) share a group. `ungroupedOrder` records the Ungrouped section's
order; it's also what marks a match as deliberately taken out of its pattern's group.

## Getting a report into Teams

Teams **does not render Markdown from the clipboard**. It applies Markdown-*like* shortcuts as the
user types, over a limited subset — pasting a whole `.md` yields literal `**` and `####`. What it does
accept is rich text.

So for the `teams` target the report is converted to HTML (`src/lib/markdownToHtml.ts`) and written to
the clipboard as **`text/html` plus `text/plain`** via `ClipboardItem` (`useCopy.copyRich`); Teams
takes the HTML flavour, anything plain-text-only still gets the Markdown. That is the same thing a
user achieves by copying out of a Markdown preview pane, done for them. `github` still copies plain
Markdown, which GitHub's editor renders on paste.

`markdownToHtml` is **not a general Markdown parser and must not become one** — it covers exactly what
`buildFailureReport` emits plus the simple prose the model is told to return. Two details that are
load-bearing:

- **Everything dynamic is escaped before markup is added**, and link targets are restricted to
  http(s). The input carries CI log text and model output; the same string is also fed to
  `dangerouslySetInnerHTML` for the Teams preview, so treating it as trusted markup would be an
  injection waiting to happen. The escaping cases are the bulk of `markdownToHtml.test.ts`.
- **Code spans are parked behind an `<n>` sentinel**, not a numeric one. `<` cannot survive
  `escapeHtml`, so the sentinel is collision-proof — whereas a `" 0 "` placeholder collides with the
  report's own prose ("Expected 0 diffs but got 3") and restores the wrong span.

Every declaration in `CODE_BLOCK_STYLE` is load-bearing in a paste target, where no stylesheet follows
the content: `color` beside `background` (setting only the background inherited the host's text colour,
which is invisible against a light block in Teams' dark theme), `pre-wrap` + `overflow-wrap` instead of
a scroll container a chat message cannot scroll, an explicit monospace stack because Teams does not
reliably keep `<pre>`'s default, and a border so the block survives the background being stripped.

`TEAMS_LOG_LINES` caps the inline log at 20. GitHub can fold eighty lines behind a `<summary>`; Teams
cannot, and an unfoldable wall of runner output buries the metadata and the suggested fix below it. The
omission is stated with a link to the full log rather than cut silently — otherwise a short log and a
truncated one look identical.

Single newlines become `<br>`, matching how GitHub's comment renderer treats them: the metadata block
(`**PR** …` / `**Workflow** …` / `**Failed step** …`) is written expecting three lines, and collapsing
them would run three distinct facts together.

### Two timeouts, not one

`REQUEST_TIMEOUT_MS` covers getting *headers*; `BODY_TIMEOUT_MS` covers reading the **body**, on its own
`setTimeout` re-armed after the first is released.

They have to be separate. Releasing the request timer once headers arrive is correct — a large but
healthy download must not be killed mid-transfer — but doing only that left every body read unbounded.
Job logs and artifact zips 302-redirect to blob storage, so the body *is* the slow part, and a response
whose headers came back fine and whose body then stalled hung indefinitely: no HTTP status, no timeout,
no error. Nothing in the app could give up on it, and it only ever surfaced because a caller upstream
had a timeout of its own.

`readBody` wraps the three body reads (`ghGet`, `ghGetText`, `ghGetBlob`) so the abort controller still
covers them, and a stall raises a `GitHubApiError` like any other failure rather than a bare `AbortError`
outside the contract every caller relies on.

## The log viewer

Three views, because they are three different things rather than three qualities of one thing
(`src/components/LogPanel.tsx`):

| | Source | Needs `gh` | Shows an upstream job |
|---|---|---|---|
| Job log | `fetchJobLog` (GitHub API) | no | no |
| Whole run | `gh run view --log-failed` | yes | **yes** |
| Claude | the `log` task | no | whatever the log it was given shows |

The **Whole run** view exists for the aggregator case: a job like `publish-test-summary` exits 1 because
`needs:` failed, so its own log and annotations can never name the cause. Fetched on demand — never as a
side effect of switching tabs — because `gh` pulls it from blob storage and that is the slow path.
Cached in `runLogCache` for a week, keyed by run *attempt*, with few entries and a hard byte ceiling:
these are the largest things the app stores and one big log must not evict everything else.

### Colour is local

`src/lib/logHighlight.ts` classifies lines; `LogLines` renders them with Primer tokens so they follow
the theme. Not a model call: the structure is documented and mechanical, and syntax colour has to be
instant, free and identical every time. The model's job is the explaining.

The restraint matters more than the coverage. `FAILURE_RE` and friends are anchored or specific enough
not to fire on prose — "Configuring error handling middleware" stays plain — because a log where
everything is tinted reads no better than one with no colour, and it teaches the reader to distrust the
colour. False negatives look plain; false positives make the whole scheme worthless. `dotnet test`'s
`Failed Name [12 ms]` is anchored at line start for exactly this reason.

### Markdown is rendered, not injected

`src/lib/markdownBlocks.ts` parses the subset the app emits and asks Claude for; `MarkdownView` renders
it as React. Deliberately **not** shared with `markdownToHtml`, which produces a string for the
clipboard: sharing would mean either injecting HTML into the app — the content embeds log text and model
output, both untrusted as markup — or building the clipboard payload out of React. Parsing twice is
cheaper than either. Fenced blocks are handed to `LogLines`, so a log quoted inside an explanation is
coloured like the log.

`<details>` is the one piece of raw HTML the app's own reports emit, so `parseMarkdownBlocks` parses it
into a block with its own children rather than escaping it — otherwise the preview shows the literal
tags, which is what the report pane used to do. The body tracks its own fence state: a log tail can
contain a line that looks like a closing tag, and that must not end the section early.

Underscore emphasis is bounded by whitespace or punctuation on both sides. Log text and test names are
full of snake_case, and eating those underscores corrupts the identifiers a reader needs to copy.

`ClaudeTriageDialog` renders the verdict, the narration and the log rewrite through `MarkdownView` for
the same reason the report pane does. Its commands feed keeps a local `ActivityLine` instead: `$`,
`read`, `grep` and `glob` are labels the app writes (`describeToolUse`), not CI vocabulary, and teaching
the log classifier about them would make it fire on log text that happens to begin with "read".

### Settings, and what may cross the IPC boundary

`config.ai` holds the master switch, the appended instructions, and per-task model/effort/prompt.
`useClaudeTriage` reads it and reports `available = ai.enabled && claudeToolsReady(tools)`, so one
setting hides every AI control rather than each call site remembering to check. `ai` is a **real
dependency** of the `run` callback: with `[]` deps it would keep the settings as of mount, and changing
the model would look like the setting being ignored.

Two distinct permissions, easily conflated: `ghLogAvailable(tools)` gates the whole-run log, `available`
gates anything that calls a model. Fetching a log with `gh` is not an AI feature and survives the switch
being off; the Claude tab does not, and `LogPanel` falls back off a tab that has just been hidden so
turning AI off mid-session can't leave a blank pane.

`--model` and `--effort` now originate in settings, so `claudeVariants` re-checks them against
`ALLOWED_MODELS`/`ALLOWED_EFFORTS` and falls back to the task's own pairing. `shell: false` means there
is no injection to worry about; the reason to validate is that an unrecognised value either wastes a
whole run or silently drops to the CLI default.

A custom prompt replaces the brief's *wording*, never the contract: `buildClaudePrompt` restates
`OUTPUT_CONTRACT` after an override, so a well-meaning custom prompt cannot produce a reply that fails
to parse. The `log` task is exempt because it returns a document rather than marked sections.

### Two size limits, not one

`MAX_REPLY_BYTES` bounds the answer; `MAX_STREAM_BYTES` bounds the raw `stream-json` output. Sharing one
number between them was a bug: the stream echoes every tool call *and* every tool result — a
`gh api .../contents/x.yml` returns the file base64-encoded inside JSON — and it measured ~126× the
answer on a four-turn run. At 256KB the reader stopped forwarding, so the `result` event never reached
the parser and the reason for stopping was lost with it.

The raw cap is now a memory guard only, applied per variant (`variant.streaming ? MAX_STREAM_BYTES :
MAX_REPLY_BYTES` — for a plain `-p` run stdout *is* the reply). The answer is capped in the parser, and
both kinds of truncation are reported as reasons rather than silently changing the outcome.

### Continuing an unfinished run

`claude --resume <session-id>` replays a whole prior conversation, and the stream carries the
`session_id` on every event. So a run that stops with more to do returns that id, the renderer stores it
with the partial answer, and **Continue** re-invokes with `--resume` plus a short nudge
(`CLAUDE_RESUME_PROMPT`) rather than the original prompt — which is already in the conversation, and
re-sending it would invite the model to start over.

The constraint that shapes this: **`--resume` looks a session up by the directory it ran in** (verified —
resuming from a different cwd reports "No conversation found"). So the scratch directory is derived from
`owner/repo/runId/depth` instead of `mkdtemp`, and is *kept* when the run left something resumable.
Deleting it would take the session with it and turn "continue" into "start again". It is swept on the
next completed run of the same analysis.

Timeouts are deliberately generous — 25 minutes for the deep pass, 40 for blame — because a timeout that
stops a run part-way costs the whole run. The bounded budget is the turn limit.

### When the CLI exits non-zero

`claude` reports a turn-limit exit as **code 1 with empty stderr** — the reason is only in the final
`result` event (`subtype: "error_max_turns"`). `createStreamParser.outcome()` captures it, and
`describeExit` turns it into something a reader can act on; `err.trim() || "exited with code N"` could
only ever produce the latter.

More importantly, `analyze` keeps the accumulated answer when there is one. A run that spent its whole
budget investigating has usually written a partial verdict, and discarding it discards the cost too. It
comes back as `ok: true` with an `incompleteReason`, and the dialog says so rather than letting a
truncated commit list read as a finished one.

### Two skills, two questions

`SKILLS_BY_TASK` installs per task rather than all of them: a skill the model cannot use is one it has
to read past. `deep` gets `failure-triage` (why did this run fail — reads one run), `blame` gets
`flow-blame` (when did it start and what caused it — reads a branch's history). Sharing one skill would
produce a model that reads run history when it should be reading a log.

The skills are plain Markdown under `electron/skills/`, read at require time by
`electron/skills.cjs`. They used to be template literals in JS, where every backtick and fence needed
escaping — and a slip produced either a syntax error or, worse, a skill that loaded with stray
backslashes in it. `electron/**` is packaged, so the files ship.

Model and effort per task are set from a benchmark, not from feel — the table and reasoning live above
`CLAUDE_MODEL` in `claudeBridge.cjs`. The short version: Haiku was slower than Sonnet on both
single-turn tasks and got the quick read wrong, high effort buys nothing on one turn, and `log` runs at
low because it is a transformation with objectively checkable output. `quick` stays at medium because
the case that separates it from low is a messy log, which a single sample cannot produce.

`blame` runs Opus at **medium** effort. It is judgement work, hence Opus; but it is breadth across many
small facts rather than depth on one, hence medium rather than the deep pass's high.

The mode answers **who**, so the output leads with an author and a SHA. The hard part is that several
commits usually land between two runs: the skill ranks them by what each changed against the failing
test, with arrival order explicitly demoted to a weak signal, and asks for a likelihood per candidate
with the evidence behind it. The calibration bands exist so "least-bad guess" never gets promoted to an
accusation — under 40% is "I don't know", said out loud.

The output contract is as much about what to leave out as what to include. Padding is the failure mode
that showed up in practice: a correct verdict buried under a survey of the branch, a catalogue of
unrelated flaky tests and advice about the build farm. The skill states the test — every line must bear
on who broke *this* failure — and caps the parts that grow: three sentences of reasoning, two lines of
boundary, one row of flaky test, one sentence for anything broader.

The flake check is scoped to **one branch** — the one under analysis. It was the most expensive thing
the skill did, and a repository-wide sweep is rarely what the question needs; the branch's own history
already separates intermittent from constant. Whether that history is *evidence about the code* depends
on the branch being merge-gated, and the skill says so explicitly rather than assuming.

The skill's ordering — flake, then infrastructure, then commits — is the load-bearing part, and there is
a test asserting those three sections appear in that order. On a merge-gated branch the code has already
passed the workflow that is now failing, so a flake and a dead runner are both likelier than a bad
commit; naming a developer's commit for someone else's flake is the failure mode worth designing
against.

`blame` and `log` return whole documents rather than the two marked sections, so they bypass
`parseClaudeAnalysis` and land in `TriageState.document`. Two consequences that were both bugs first:
the "reply didn't contain the expected sections" error must not apply to them, and the dialog's open
state is now keyed off the open depth rather than a chain of ternaries — the chain knew only about
quick and deep, so blame's dialog was silently unopenable.

### The triage procedure is a skill

`electron/failureTriageSkill.cjs` holds the procedure; `installSkill()` writes it to
`<scratch>/.claude/skills/failure-triage/SKILL.md` before the CLI is spawned, which is where `claude`
discovers skills — the bridge already runs each analysis in a throwaway scratch directory, so that
happens to be exactly the right place. Verified end to end: the model invokes it through the `Skill`
tool, so `Skill` is in `ALLOWED_TOOLS`.

Why a skill rather than more brief: the investigation is a repeatable procedure with judgement calls in
it, which is what skills are for — and putting it in a file means the same steps are available to a
developer running `claude` by hand in this repo. `.claude/skills/failure-triage/SKILL.md` is generated
from the same string by `npm run skills:sync`, and a test fails if they diverge. It is **not** read from
the repo at runtime: a packaged app has no repo, and an analysis must not depend on where it was
launched from.

Installing is best-effort. A failed write is logged, not thrown — the brief still carries the output
contract, the verified facts and the COMMANDS block, so the analysis degrades to a less methodical one
rather than failing. That is also why the brief repeats the two constraints that matter most (one job,
two-to-four calls) instead of delegating everything.

### The `log` task

`ClaudeDepth` is `'quick' | 'deep' | 'log'` — no longer strictly a depth, but the same pipeline, and the
shared key means the three results coexist per failure instead of overwriting each other. `log` runs
Sonnet at medium effort with one turn and no tools: it is a mechanical rewrite of a large input, not an
investigation. Its reply is a whole Markdown document, so it bypasses `parseClaudeAnalysis` (which would
reject every reply for having no markers) and is stored as `CachedAnalysis.rewrittenLog`.

`CLAUDE_LOG_BRIEF` asks for the log *back*, not a report about it — the failure mode being that a model
asked to "make this readable" writes a summary, and a summary is not a log. It is told to annotate
sparingly for the same reason the highlighter is conservative.

## Screenshots

`npm run screenshots` regenerates everything under `docs/screenshots/` from **mock mode**:

```sh
VITE_MOCK=1 npx vite --port 5199 --strictPort &
npm run screenshots            # or: node scripts/shoot-screenshots.mjs failures who-broke-it
```

Mocks rather than a live repository for three reasons: the shots are reproducible, they contain nobody's
real branch names or logins, and the AI features can be shown at all — they need a desktop bridge and a
`claude` that answers, neither of which exists in a browser. The script installs a stand-in bridge that
returns fixed, obviously-fictional analyses, so a screenshot never implies the model said something it
didn't.

Each shot runs in its own page, so one failing does not take the rest with it, and the whole set takes a
few minutes — pass shot names to regenerate only some.

## Diagnostics

### The log file — start here when something went wrong

`electron/runLog.cjs` writes an NDJSON record of what the app did, to
`<userData>/logs/job-monitor.ndjson`:

| Platform | Path |
|---|---|
| Linux | `~/.config/Job Monitor/logs/job-monitor.ndjson` |
| macOS | `~/Library/Application Support/Job Monitor/logs/job-monitor.ndjson` |
| Windows | `%APPDATA%\Job Monitor\logs\job-monitor.ndjson` |

`<userData>` is named after the app, and the app is named differently in development: `electron .`
takes `name` from `package.json`, so a dev run writes to `job-monitor/logs/` (lower case, hyphen)
while a packaged build uses the `productName` `Job Monitor`. Two separate files — check which one you
are reading before concluding that nothing was logged.

The exact path is printed to stdout at startup and shown under **Settings → Diagnostics** (desktop
only — there is no on-disk log in a browser tab), with buttons to copy it or open the folder. Capped
at 5 MB with one previous file kept as `.ndjson.1`.

**Reading it in the app.** Ticking *Read the log in a Diagnostics tab* there adds a **Diagnostics**
tab to the main navigation that follows the tail live, filtered by scope and searchable — the search
covers `detail`, since the id being chased (a run id, a PR number, a fingerprint) is in there rather
than in the sentence. Opt-in because it is a window on the app rather than on the work, and the
file is written either way.

The split is the usual one: `logs:read` in `electron/main.cjs` hands over a bounded *tail* (default
512 KB of a possible 5 MB — 5 MB of NDJSON is more than anyone reads and more than is sensible to
re-parse every few seconds), `readRunLogTail` drops the partial line the byte offset cuts into and
reports `truncated` so the viewer can say "showing the last N of M", `lib/diagnosticsLog.ts` parses
and filters as pure functions, and `components/DiagnosticsView.tsx` renders. Unparseable lines are
shown rather than dropped: one is usually a crash mid-write, and knowing it is there beats a silent
gap. Parsing is memoised on the text alone, so typing in the search box doesn't re-parse half a
megabyte per keystroke.

One JSON object per line: `{ at, scope, message, detail? }`. `scope` is `app`, `claude`, or
`renderer:<devLog scope>`; anything belonging to an analysis carries `detail.requestId`, so a whole run
comes out with one filter:

```sh
# everything one analysis did, in order
jq -r 'select(.detail.requestId == "…") | "\(.at[11:19]) \(.message)"' job-monitor.ndjson

# just the failures, across every run
jq -c 'select(.message | startswith("WARN") or contains("failed"))' job-monitor.ndjson

# how each analysis ended, with the numbers that explain it
jq -c 'select(.message | startswith("claude ok") or startswith("claude failed")) | .detail' \
  job-monitor.ndjson

# why auto-rerun did or didn't fire — the whole engine, in order
jq -r 'select(.scope == "renderer:auto-rerun") | "\(.at[11:19]) \(.message)"' job-monitor.ndjson
```

That last one carries what every post-mortem so far has needed: `ms`, `answerChars`, `toolCalls`,
`streamTruncated`, `answerTruncated` and the CLI's own `outcome`.

**Written synchronously**, deliberately. A buffered stream loses whatever had not flushed when the
process died, and the lines just before a crash are exactly the ones worth having; a handful of small
appends per analysis costs nothing against that.

**What is not in it:** never the GitHub token (it never reaches the main process at all), and never log
*contents* — only sizes. A CI log can hold anything a build printed, and a diagnostics file that quietly
accumulates it is a liability rather than an aid.

**DevTools: F12** (or Ctrl/Cmd+Shift+I) in the desktop app. It needs an explicit
`before-input-event` handler in `electron/main.cjs` because the app menu is removed, and the default
accelerators live on that menu — without it a packaged build has no way to open DevTools. It's scoped
to the window's input rather than a `globalShortcut`, which would take F12 from every other app.

`src/lib/devLog.ts` writes scoped, colour-tagged lines to that console: `api`, `log-cache`, `claude`,
`auto-rerun`, `failures`, `desktop`. On in dev; off in a packaged build, since logging every poll would
bury the console and the lines name repositories and branches. `installDevLogControls()` announces
itself on startup and exposes `jobMonitorDebug.enable()` / `.disable()` — a diagnostic channel that
defaults to off and isn't discoverable is one nobody finds at the moment they need it. `devWarn` ignores
the flag, because a genuine problem should surface for someone who never turned logging on.

`detail` is passed to `console.log` as a live object rather than stringified, so DevTools renders it
expandable. Callers must not compute anything purely to log it — `devLog` may be a no-op.

**Main-process lines reach the same console.** `claudeBridge` sends diagnostics over a `claude:log`
channel (separate from `claude:progress`, which feeds the dialog): the exact argv it spawned, the log
source and size, exit codes and stderr. `forwardClaudeLogsToConsole` pipes them in under the `desktop`
scope. Without this, everything the main process does is visible only in the terminal that launched the
app, which nobody has when the interesting run already happened. `onLog` is optional on the bridge so
an older preload doesn't break the renderer.

## Local CLI integration

`electron/claudeBridge.cjs` runs two local commands on behalf of the renderer:
`gh run view <id> --log-failed --repo <o>/<r>` for the full failed-step log, and `claude -p` for the
analysis. Desktop only — in a browser `window.desktop.claude` is absent and the UI never offers it.

### Two depths

`ClaudeDepth` is `'quick' | 'deep'`, and it changes the model, the budget, the tools and the brief:

| | `quick` | `deep` |
|---|---|---|
| Model / effort | `--model sonnet --effort medium` | `--model opus --effort high` |
| Timeout | `QUICK_TIMEOUT_MS` (90s) | `CLAUDE_TIMEOUT_MS` |
| `--max-turns` | 1 | 24 |
| `--allowedTools` | none passed | `ALLOWED_TOOLS` |
| `gh` | skipped entirely | used for the full run log |
| Brief | `CLAUDE_QUICK_BRIEF` | `CLAUDE_INVESTIGATION_BRIEF` |

The pairing is the point rather than a knob: a single-turn summary of a log we already have is what
Sonnet is good at and finishes in seconds, while reasoning across a run's artifacts, its workflow file
and a PR diff is what the deep pass exists for. Giving both the same model would collapse the
distinction the two buttons promise. The quick pass gets **no tool allowlist at all** — with one turn
and a one-minute brief there is nothing for it to use, and not passing the flag is a stronger guarantee
than passing an empty one.

A quick run never calls `gh`, so its `logSource` is always `app` — which is the *designed* path there,
not the fallback it means for a deep run. `sourceNote` in the dialog distinguishes the two; reporting
"gh couldn't supply a log" for a quick read would invent a failure that never happened.

**Model aliases, not pinned ids.** `sonnet` and `opus` let the CLI resolve whatever its current
version of each is, so a retired model id can't strand the feature.

### Degrading across CLI versions

`claudeVariants(quick)` returns the argv variants to try, most capable first, and each is a **strict
subset** of the one before it — enforced by a test, because a non-subset retry would be rejected for
the same reason as its predecessor and burn the remaining attempts for nothing. A rejected flag fails
in milliseconds, so walking the list costs almost nothing:

1. everything, including `--model` and `--effort`
2. drop `--effort`, expressing the same intent through `MAX_THINKING_TOKENS`, which older CLIs read
3. `-p --model <m>` — no streaming, no tools, so `toolsUnavailable` is emitted
4. bare `-p`

`--model` survives to the second-to-last variant deliberately: losing it is the one degradation that
makes the depth distinction meaningless. An unrecognised `--effort` *value* only warns and falls back
to the CLI default, so only a missing flag needs handling.

### Working around `gh`'s log download

`gh run view --log-failed` aborts on larger run logs with
`failed to get run log: stream error: stream ID 1; CANCEL; received from peer` — Go's HTTP/2 client
giving up on the download. Three things handle it:

1. `gh` is spawned with `GODEBUG=http2client=0`, dropping it to HTTP/1.1, which is the documented way
   out. It's applied on the *first* attempt, not as a retry, since the failure is common enough on real
   logs that a doomed HTTP/2 attempt would only add latency.
2. One retry, because the failure is also plain flaky.
3. A **fallback**: the renderer passes the failing job's own log, which the app has already fetched
   through the GitHub API and cached (`fetchJobLog`). `gh` gives the whole run's failed steps and is
   preferred, but it isn't worth failing the feature over.

Consequently `gh` is an *enhancement*, not a requirement — `claudeToolsReady` gates on `claude` alone.
The result carries a `logSource` (`gh` | `app`) and the dialog reports it, so a narrower analysis is
visible rather than silent.

### Progress is reported, not guessed

The call can run for a minute or more, so the main process emits `claude:progress` events keyed by a
renderer-supplied `requestId`: a phase when it starts fetching the log, the bytes as they arrive, a
phase when the log is handed over, and then **the reply forwarded chunk by chunk as it is written**.
`ClaudeTriageDialog` renders those directly, so nothing in it is a decorative spinner — a progress bar
that advanced on a timer would be a lie about where the time went.

`createStreamParser` separates consecutive assistant text blocks with a newline. Each block is a
complete message from one turn, so bare concatenation fused them — and irrecoverably, since a sentence
splitter needs whitespace after the full stop to find the boundary. This is safe **only** because these
are whole blocks: the non-streaming fallback emits raw stdout, which splits at arbitrary byte
boundaries, and inserting newlines there would break words mid-token.

`claude:cancel` kills the tracked children (the bridge keeps them per `requestId`), so **Stop** means
stopped rather than "hidden while it keeps burning tokens". The hook resets the row immediately rather
than waiting for the kill to land, and ignores late results whose `requestId` no longer matches — a
superseded or cancelled run must not overwrite the current one.

### The model investigates; that is the point

`claude` is run **with tools** and briefed to go and find the evidence
(`CLAUDE_INVESTIGATION_BRIEF`). Without that it answers from the workflow's summary annotation, which
for a failing test suite says little beyond "the step failed" — and then quite correctly replies that
there is not enough evidence to name a cause, listing the raw log, the JUnit artifacts, the workflow
file and the PR diff as what it would need. All of which it can fetch. So the brief hands it the exact
commands for *this* failure (`buildClaudePrompt` emits a `COMMANDS` block from the verified facts, so
it never reconstructs an owner/repo/run id and gets one wrong) and states that "insufficient evidence"
is only acceptable *after* trying, with a note of what was tried.

`canInvestigate` and `depth` together select the brief. When the installed CLI rejects the tool flags
the bridge falls back to a plain completion and emits `toolsUnavailable`, and the dialog says the
analysis is log-only — degrading honestly rather than letting it imply it had investigated.

### The renderer's log fetch is the quick pass's critical path

The quick pass has no `gh`, so its only log is the one the renderer fetches through
`fetchJobLog` — and that happens **before** the bridge is called, which means none of the bridge's
progress events exist yet. Anything slow there is invisible, so two things guard it:

- `logCache` **dedups in-flight requests**. Focusing a failure starts a log download for the report
  pane; clicking *Quick read* immediately after used to start a second one for the same job, because
  there was no cache entry yet for it to hit. Both callers then waited on the slower of two identical
  downloads. Concurrent callers now share the one promise, and a rejection reaches all of them.
- The wait is **bounded** (`LOG_FETCH_TIMEOUT_MS`). The deep pass loses nothing by giving up, since
  `gh` can still supply a log; the quick pass reports that it has nothing to summarise and points at
  the deep one.

### A log is not the only evidence

`jobId` comes from `jobIdFromUrl(details_url)`, which only matches an Actions job URL. A failing check
run that isn't one — and there are plenty — has **no job log to fetch at all**, so the quick pass used
to refuse. It shouldn't: the check-run annotations name the failing test with file, line and message,
and summarising those is what a quick read is for.

So the renderer passes `evidenceInPrompt` (true when there are annotations) and the bridge refuses only
`!logText && !evidenceInPrompt`. `logSource` gains `none` for that case, which the dialog reports —
the answer's reach is bounded and shouldn't look otherwise. `buildClaudePrompt` also takes `hasLog`, so
with no log it emits an explicit "no log could be read, don't describe contents you weren't given"
instead of a bare header over an empty section; the prompt is therefore built *after* the fetch rather
than before it.

The renderer keeps *why* the log is missing (`logProblem`) and puts it in the error when it really has
nothing — one generic message for "no Actions job log", "the download failed" and "it timed out" left
the one case the user can't see into indistinguishable from the others.

`hasCachedLog` exists so the dialog's first phase can say which of the two it is doing. Labelling a
live download "Reading the log already fetched" made a working-but-slow fetch indistinguishable from a
hang, which is how it was first reported.

### Persisting analyses

`claudeAnalysisCache` (`src/storage/failureCaches.ts`) keeps results for a **week**, keyed by
`analysisKey(failureKey, depth)`. This reverses an earlier decision not to persist them, and the reason
it's safe is the same one the other week-long caches rest on: the key contains the job id, and
re-running failed jobs mints new job ids, so a new attempt **misses** rather than being served the
previous attempt's verdict. Keying by depth as well keeps a Sonnet one-liner from overwriting an Opus
investigation. `useClaudeTriage` hydrates from the cache on mount and writes through on success, so a
finished analysis survives a restart and reopening it spends nothing.

`analysedFailures()` returns `failureKey -> {'quick','deep','log'}` in one pass, so rendering a list of
rows costs a single scan rather than a lookup each. The depth is split off the **last** `|`: a flow
failure key is `flow:<id>:<jobId>`, colons throughout, so splitting on the first separator would take
the key apart in the wrong place. Like `analysedOrigins`, it is recomputed per render rather than
subscribed to — the view re-renders on every poll, so an icon appears within a cycle.

`CachedAnalysis` holds more than the prose: the **activity trail** and the log provenance
(`logSource`, `logTruncated`) go in with it. Storing only the conclusion meant a reopened analysis
showed a verdict with no evidence behind it, and those fields are exactly what bounds how far to trust
it. Both are optional so entries written before this still load. The dialog renders the trail whenever
it is non-empty — running or restored — and switches the heading to past tense once the run is over.

`FailuresView` prefers the deep analysis over the quick one when building a report — both are real
answers, but the deep one saw more.

**The tool allowlist is read-only and enumerated** (`ALLOWED_TOOLS` in `electron/claudeBridge.cjs`):
`Read`, `Grep`, `Glob`, and `Bash` scoped *per command* — `gh run view`, `gh run download`, `gh api`,
`gh pr view/diff`, plus `unzip`/`ls`/`cat`/`head`/`tail`/`find`/`grep`/`rg`/`base64`. There is no
`Write`, no `Edit`, and no bare `Bash`: granting a model unrestricted shell on a developer's machine
is not something prompt wording can make safe. The run's cwd is a `mkdtemp` scratch directory, so
artifact zips and extracted reports land somewhere disposable and are removed in the `finally`.
`--max-turns` bounds cost and duration, and the timeout is 10 minutes because the run is agentic.

### Streaming an agentic run

`--output-format stream-json --verbose` rather than `text`: in text mode an agentic run prints nothing
until the very end, leaving the dialog blank for minutes. `createStreamParser` consumes the NDJSON and
emits two kinds of progress — `activity` for each tool call (`$ gh run download …`, `read
artifacts/test-results/TEST-Foo.xml`) and `chunk` for assistant text — so the window shows both what
it is doing and what it is writing. The `result` event's text is authoritative for the final answer;
the deltas are for display.

### Why the model writes prose only

`src/lib/claudePrompt.ts` asks for exactly two sections behind sentinel markers — the problem
statement and the suggested fix — and nothing else. Every link, SHA, workflow name and test name in
the finished report comes from data the app already fetched, and the prompt says outright not to
invent any. The reason is practical: a bug report carrying a confident, wrong URL is worse than one
carrying none, and supplying a plausible link is precisely what a model does when the prose calls for
one. `buildFailureReport` then places the problem first (it is what a human reads), the verified facts
next, and the suggestion **last and collapsed**, labelled as generated — a suggestion sitting beside
evidence, with the distinction visible.

Markers rather than JSON because the payload is multi-paragraph Markdown full of backticks and
newlines, which survives a marker split far more reliably than a model escaping it into JSON.
`parseClaudeAnalysis` is deliberately lenient about preambles and a missing section, since throwing
away a slow, billable call over a formatting slip would be the wrong trade.

### Security posture

The renderer is treated as untrusted even though it is our own code:

- `spawn` with an argv array and `shell: false`, so nothing in an argument can become a command.
- Every renderer-supplied value is re-validated **in the main process** — owner/repo against a strict
  pattern, `runId` as a positive safe integer, the prompt length-capped.
- Fixed argv shapes: the renderer chooses *data*, never flags or executables.
- Timeouts and output caps on every call, so a hung or runaway CLI can't wedge the app.
- The app's GitHub token is never passed to `gh`, which has its own auth.

The prompt goes to `claude` on **stdin**, not as an argument: it embeds a log that can run to tens of
kilobytes and would risk the platform's argument-length limit.

### The data-flow caveat

This is the only feature that moves data anywhere other than `api.github.com`: the log reaches
Anthropic via the user's own CLI. It therefore runs **only** on an explicit click — never on a poll,
never in the background — and both README's Privacy section and the in-app copy say so. Results are
session-only and never persisted, unlike annotations and logs: a suggestion is not a fact about the
run, and a stale one read as authoritative is worse than none.

## Security / deployment notes

- A strict **Content-Security-Policy** is injected into the production `index.html`
  (`connect-src` limited to `https://api.github.com`, `script-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, …). When hosting, also send it as a real **HTTP header**. The dev
  server relaxes `script-src`/`connect-src` for HMR only.
- Clickjacking guard: a small frame-buster runs in `main.tsx` (GitHub Pages can't send
  `X-Frame-Options` / a header CSP).
- `style-src` includes `'unsafe-inline'` for the handful of `style` attributes carrying values that
  only exist at runtime — the width of a timeline bar as a percentage of a run's duration, a status
  colour looked up from a table. It is no longer needed for Primer: since v38 the component library
  ships plain CSS and the styled-components dependency is gone.
- No third-party runtime scripts — everything is bundled by Vite.
- **Telemetry runs in the Electron main process only**, so the CSP is untouched and the hosted web
  build collects, stores and sends nothing. The renderer keeps in-memory counters and flushes deltas
  over IPC; with no `window.desktop` bridge every call is an early return and no timer is ever
  armed. See [docs/telemetry.md](docs/telemetry.md).
- The **only** non-`GET` request the app can make is
  `POST /repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs`. It is off by default, restricted to an
  explicit list of workflow file names, and gated on a proven-writable token. Nothing else is ever
  triggered or changed — in particular the app cannot dispatch a workflow, cancel a run, push, or
  comment.
- CSP needs no change for the write: `connect-src` already allows `https://api.github.com`, and CSP
  does not distinguish HTTP methods (`form-action 'none'` applies to `<form>`, not `fetch`).

## Architecture

```
src/crypto/webcrypto.ts        PBKDF2 + AES-GCM
src/storage/                   IndexedDB (secret) + localStorage (config, expand-state, rerun log)
src/api/                       githubClient (ETag/304 + the one POST), rateLimit,
                               tokenCapability, endpoints, types
src/hooks/                     usePolling, useVisibility, useGitHubDashboard, useFlows,
                               useExpandState, usePrAutoRerun, useFailureDetails, useCapabilityProbe
src/context/                   Auth + Config + Dashboard + AutoRerun providers
src/components/                PrList, CheckRunsTable, FlowRunsGrid, JobsTable, SettingsPage,
                               FailuresView, RerunFailedJobsButton, WorkflowFilesField, …
src/lib/                       status/completion/flowFilter/flowEmptiness helpers,
                               autoRerun (policy), failures + failureReport (bug reports)
src/mocks/                     VITE_MOCK fixtures + fetch
electron/                      Electron main + preload (tray, notifications, auto-update, window state)
```

The write path is deliberately split so the policy is testable without a network: `lib/autoRerun.ts`
is a pure `decideRerun` (every skip reason unit-tested), and `hooks/usePrAutoRerun.ts` does the I/O.
The engine re-checks token capability itself rather than trusting the UI, because `prAutoRerun.enabled`
persists and the token can be swapped for a read-only one at any time.

**Staleness is measured from the latest attempt, not from `created_at`.** GitHub never moves
`created_at`, but `run_started_at` resets on every re-run — so judging age by the former means a PR
that is actively being retried ages out of `maxRunAgeHours` while its last attempt was minutes ago,
which is exactly the silent stall this engine is supposed to avoid. `runAgeBasis` is
`run_started_at ?? created_at` (a first attempt has only the one stamp). GitHub's own 30-day refusal
is a *separate* check against `created_at`, since that is the clock GitHub uses and re-running cannot
hold a run open past it; conflating the two is what produced the bug.

**A decline is not an attempt.** `RerunRecord.attempts` means "re-runs we asked GitHub for" — so
`attempts.length` (or `rerunRequestCount`) is the number of requests made — while a terminal verdict
reached *without* asking sits in `declined`. Both are persisted, because the point of the latch is
never to re-derive the verdict, and for `identical_failure` re-deriving means re-fetching every
failed job's annotations on every tick. Filing the verdict among the attempts, as an earlier version
did, cost twice: the re-run count was overstated by one, and `decideRerun` answered
`already_requested` — "this attempt was already re-run" — about an attempt it had never re-run,
hiding the real reason behind a false one. `decideRerun` now replays `declined.reason`, and
`loadRerunRecords` migrates the old shape on read (matched on the frozen literal the latch used to
write) so existing installs correct themselves.

The replay is **conditional**, because a decline is a cached decision: raising
`maxIdenticalFailures` must invalidate one taken under a tighter limit. A stopped run's attempt
number never changes again, so nothing would otherwise reconsider it and the new setting would look
inert. Re-checking costs nothing — the streak comes from fingerprints already in the record — and
falling through to the full decision is safe because the engine computes this attempt's fingerprint
before the decision that can act on it.

**Can't check, don't retry.** A fingerprint that fails to compute leaves the brake with nothing to
compare, and treating that as permission to re-run suspends `maxIdenticalFailures` exactly while
something is already wrong — a run then climbs to `maxAttempts` on a failure nobody ever compared,
which is how it was found. `fingerprintRun` therefore returns a result rather than `string | null`,
naming which of the three things went wrong (jobs unlistable / a "failed" run with no failed job /
nothing identifying to hash), and `decideRerun` answers `fingerprint_unavailable`. The cause reaches
both the log sentence and a `held` event on the PR badge, because a refusal with no stated cause is
the silence this engine has already been fixed for once. `fingerprintProblem` is deliberately
separate from `fingerprint`: the cheap pre-pass passes no fingerprint on purpose, and mistaking that
for a failed lookup would refuse every run before anything ever tried. Nothing is latched — the next
tick may manage it.

**Every decision is logged, including the ones to do nothing.** A skip reason that is computed and
then dropped on the floor makes an idle engine indistinguishable from a broken one, so each verdict
goes to the `auto-rerun` scope with the facts behind it — `ageHours` against `windowHours` for
`too_old`, the fingerprint for `identical_failure`, the latching record for `already_requested`. Two
things keep that affordable. `not_matched` is reported once per PR as a matched/ignored split rather
than once per ignored run, because a repo with thirty workflows would otherwise spend the whole file
saying so. And everything goes through `createVerdictLog` (`lib/devLog.ts`), which writes only when
the verdict for a subject *changes*: the engine re-derives the same answer every minute forever, and
`devLog` persists to a 5 MB file whether or not the console flag is on. The engine's own state is
logged from an effect rather than the tick, since `off` / `no-permission` / `no-workflows` disarm the
poll entirely — a tick-side log would go quiet exactly when someone is asking why nothing happened.

One subtlety worth knowing before touching the PR dashboard: `needsChecks` goes permanently false
once every check-run has completed, and `targetSig` only changes on PR number + head SHA. So after a
re-run is requested, nothing would look at that PR again and it would show its old `failure` forever
— hence `invalidateChecks(prNumber)`, which clears `checksUpdatedAt`, evicts the check-run/status
ETag entries, and bumps a tick that re-polls *after* the cleared state has rendered (calling
`refresh()` inline would run the previous closure and skip the PR).

## Limitations

- Webhooks/live logs are out of scope (no upstream admin needed; polling only).
- Logs/jobs load lazily on expand; deep log streaming is not implemented.
- A **fine-grained PAT can never unlock the re-run feature**, even one granted `actions: write` —
  GitHub exposes no way for a browser to verify that, so it is treated as read-only. Use a classic
  `repo` token.
- The failure fingerprint is built from **annotations**, not raw log text: downloading logs for every
  failed job on every poll would be far too heavy for a background loop, and annotations are the
  failure content with much less noise. A repo that emits no annotations falls back to job/step
  names, which is coarse — `maxAttempts` is the backstop there.
- A **pull-request** failure report reads the run once (`GET /actions/runs/{id}`) for its workflow
  file, run number and attempt, because a check-run carries no workflow identity; it is fetched only
  for the report being opened, and ETag-cached. A **flow** failure needs no such read — its run is
  already in hand — so `FailedJobRef` carries that identity and the fetch is skipped.
- Only a flow's **latest** run is examined, because that is what says whether the flow needs
  attention now (the same rule the Overview uses); failures from older runs in the tracked window
  would bury today's break. Its jobs are fetched on demand, keyed by run attempt, capped.
