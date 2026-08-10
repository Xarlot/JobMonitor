# Changelog

All notable changes to **Job Monitor** are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [3.0.0]

**Everything this app is built on moved a major version at once** — React, Primer, Electron,
TypeScript and the table library. Nothing about what the app *does* has changed; this is the release
that pays off six accumulated upgrades so the next feature is written against current parts. It is a
major version because the user interface was rewritten to get there, not because the product was
redesigned.

The upgrades are not independent: Primer 36 requires React 18 exactly, so React 19 is unreachable
without Primer 38 — which removes the `sx` prop, `Box` and `Octicon` outright. There is no
incremental path, so the styling layer moved in one change: **804 `sx` props, 402 `Box` elements and
53 `Octicon` elements across 41 files**, now 43 CSS module files.

### Changed
- **Styles are a stylesheet rather than generated in the browser.** Primer 38 ships plain CSS, so the
  app no longer builds its own at startup through styled-components — and that dependency is gone.
- **How far each feature branch is behind the default branch**, shown in warning colour next to the
  fork standing — `47 commits behind 2026.1`. A branch can match the upstream exactly and still have
  drifted months behind the branch it merges into, and of the two numbers on that row only this one
  gets worse while nobody touches anything. Measured on the upstream's copy, since that is the shared
  branch, and absent when the branch is level or ahead. One more comparison per branch per poll,
  ETag-cached like the rest.
- **The Feature branches tab is on by default.** It costs two requests per poll to establish that a
  repository has no shared branches under the prefix — cheap enough that defaulting to off mainly
  meant the tab went unfound by the people it was built for. Switching it off under **Settings → PR
  automation** stops all of it, and an existing installation keeps whatever it had set.
- **Flows and Feature branches swapped places** in the navigation, which now reads
  Overview · Pull requests · Flows · Feature branches · Failures. Feature branches sat next to Pull
  requests because that is what it deals in; in practice Flows is the everyday tab of the two.
- **Some components look slightly different** because Primer restyled them — labels have an outline
  they did not have, and some spacing shifted a pixel or two. Nothing moved.
- **The runs grid moved to the TanStack Table v9 API**, not to the compatibility entry point the
  package also ships: features are opt-in, the row model is constructed rather than passed as a
  getter, and the cell accessor changed. A compatibility shim is a decision to do the work later with
  less context.
- **Dependencies**: React 18.3 → 19.2, Primer 36.27 → 38.35, Electron 42.5 → 43.3 (Chromium 150,
  Node 24.18), TypeScript 6.0 → 7.0 (the native compiler; no source changes needed), TanStack Table
  8.21 → 9.1, jsdom 29 → 30, jest-dom 6 → 7. styled-components removed.

### Fixed
- **Tooltips are reachable by keyboard.** Primer 38 refuses to attach a tooltip to something that
  cannot be focused, which surfaced three badges — the "analysed" marker, the rate-limit badge and
  the per-depth Claude markers — whose explanations appeared on hover only and were therefore
  invisible to anyone not using a mouse. They are focusable controls now.
- **Navigation icons stay at every window width.** Primer 38 hides them below 1440px by default to
  make room in a crowded nav; this one has five tabs that fit at any size the window can be.

### Added
- **A test for the runs grid**, which had none. Column definitions are data, so a table configured
  with the wrong feature set builds a valid object that typechecks and renders nothing — the new test
  asserts output rather than construction: rows arrive, in order, carrying the values the accessors
  were supposed to reach.

## [2.2.0]

**Long-lived feature branches get a tab of their own, and it answers "why is this sitting there".** Work
on a branch shared between your fork and the upstream was invisible here: both ends of its pull requests
live in the upstream, so the PR tab's fork-head filter excluded them entirely. The new tab tracks those
branches, shows how far each merge has actually got, and does the three things the routine around such a
branch consists of. The interesting part is the second one — a pull request that is merely "open" tells
you nothing, while one that is open, green, mergeable and *unarmed* tells you it is waiting for a person.

### Added
- **A Feature branches tab** (opt-in under **Settings → PR automation**). A feature branch is one under a
  prefix — `feature/` by default — that exists in **both** your fork and the upstream; a branch only one
  of them has is not shared work and does not appear. Branches are found through GitHub's prefix-matching
  refs endpoint rather than by listing every branch and filtering here, so a repository with hundreds of
  them costs two requests instead of sixteen.
- **A stage strip per pull request** — opened → checks → mergeable → auto-merge armed → merged — with the
  reason it is stuck spelled out: *waiting on required checks or a review*, *behind the base branch*,
  *conflicts — this one needs a working copy*. That last piece comes from `mergeable_state`, which only
  the single-pull-request endpoint carries and which GitHub computes asynchronously, so it is polled
  until it means something rather than read once and believed.
- **Three actions, one loop, and none of them merge.** Bring the default branch into the feature branch;
  pull the upstream's copy of the branch down into your fork; offer your fork's work back to the
  upstream's copy of the same branch — a cross-fork pull request, the only one this app opens, with the
  same branch name on both sides. Nothing here targets the default branch: getting a feature branch into
  `main` is somebody else's decision. Every action **opens a pull request and arms auto-merge**, and
  GitHub does the merging when the required checks pass — landing directly in a feature branch is
  forbidden by branch protection, so a merge button here would be a route around the rule that forbids it.
  If GitHub declines to queue one, that is reported rather than worked around.
- **The actions are icons with tooltips.** Four labelled buttons naming two branches filled the row and
  still read alike ("Sync from main" beside "Ship to main"); the tooltip carries a sentence naming both
  ends of what is about to happen, which no button label could — including *why* an action is
  unavailable, since a disabled control that explains nothing is a dead end. Disabled ones stay
  hoverable for exactly that reason.
- **Claude writes the offered pull request's title and description** (desktop app), from the commits your
  fork has that the upstream's copy of the branch does not — which the app fetches itself, so the task is one turn with no tools
  and no shell. You see and edit the result before anything is published, and a browser, a missing CLI or
  a slow reply all fall back to a template rather than stopping the pull request. Issue references and
  @mentions are stripped from whatever comes back: a hallucinated `Fixes #123` closes somebody's issue the
  moment the pull request merges. Model and effort are configurable under **Settings → AI integration**.
- **A fork repo name** under **Settings → Repository**, for the rare fork that was renamed. Blank still
  means "same name as the upstream", which is what every earlier version assumed outright.

### Changed
- **Dialogs no longer close when you click outside them.** The ✕ and Escape close them; the backdrop
  dims and blocks, and that is all it does. Several of these windows hold text you have typed — a pull
  request's title and description, a custom prompt — and a mis-aimed click threw it away with no warning
  and no undo. Escape stays because it is the keyboard route out of a dialog, and because it is not
  something you hit by missing.
- **A pull request with nothing to merge gets an empty description**, and no model is asked about it.
  Handed an empty change set a model does not answer "nothing to say" — it hedges from the branch name
  at length ("appears to relate to…", "a reviewer should check the actual diff"), which fills the space a
  reader scans and tells them less than a blank body would. The brief now forbids that shape of writing
  outright, for the thin-but-not-empty case that still reaches it.
- **Auto-rerun now covers the feature-branch pull requests too.** Its rule has always been "auto-merge is
  armed", and these arm it — but the dashboard cannot see them, so without this a single flaky check would
  park an armed pull request indefinitely. All the existing brakes still apply unchanged.
- **Write failures say what was refused.** Every refusal message was phrased for re-running jobs, which was
  true when that was the only write; "this run is too old to re-run" in answer to a failed pull request is
  not.
- The `development.md` claim that everything is read-only bar one feature has been replaced with a table
  of every write the app can make and how each is reached. It was already stale at 2.1.0.

- **The bundle is split by dependency instead of shipped as one 1.1 MB file.** Not for the download —
  it is ~275 KB gzipped either way — but for caching: in one chunk, a one-line change to a component
  invalidated React, Primer and styled-components along with it, so every release re-downloaded all of
  them. They change a few times a year; this app changes weekly. Grouped by how they version rather
  than by size, and the largest chunk is now 456 KB, which also silences the build's size warning.
- **The desktop app's `app://` file server is now a tested module** (`electron/appAssets.cjs`). Every
  JS chunk reaches the desktop app through it and nowhere else, so a change to how the bundle is split
  could break the desktop build while the browser build kept working perfectly. Its failure mode is
  also invisible: unknown paths fall back to `index.html`, and a browser will not execute HTML as a
  module, so a renamed chunk meant a blank window. A `.js` request that hits the fallback is now
  logged as the fault it is.

### Fixed
- **Syncing a branch into your fork reported a failure after succeeding.** `merge-upstream` answers with
  an **owner-qualified** branch — `DevExpress:feature/x`, not `feature/x` — and the check that GitHub had
  acted on the branch asked for compared it against the bare name, so it fired on every successful sync:
  *GitHub synced "DevExpress:feature/x" rather than "feature/x"*. Not a harmless false alarm, either — the
  sync had already happened, so the fork **was** updated while the app said it wasn't. Only the owner is
  stripped now, so a branch with slashes of its own still compares correctly, and the check still catches
  GitHub genuinely acting on another branch.
- **The merge commits this app makes are no longer counted as your work.** Pulling a diverged branch
  into a fork *merges* rather than fast-forwarding, and that merge is then a commit the upstream does not
  have — so a branch with two commits on it read as *"3 commits of your own"* after one press of the sync
  button. The count now excludes merges (`parents > 1`), and a difference that is *only* a merge says so
  instead of naming a number.
- **The fork/upstream comparison is no longer inverted.** It compared base=fork against head=upstream, so
  `ahead_by` meant "how far behind" and needed a comment saying the names read backwards — the kind of
  thing that survives review and then quietly gets a sign wrong. Base is the upstream now, head the fork,
  so every number reads from the fork's point of view; the same request also returns the fork's own
  commits, which is what makes the merge-commit count above possible.
- **A fork that is ahead no longer reads as a problem.** *"2 commits ahead — nothing to pull"* was the
  expected state right after a sync that had commits of its own to merge, and it looked like a
  discrepancy. It now says both halves in the order that matters: *"your fork is up to date, plus 2
  commits of your own"* — nothing to pull, and something to offer.
- **"Validation Failed" now says what failed.** For a 422, GitHub's `message` *is* the constant string
  "Validation Failed" — everything naming the problem sits in the `errors` array beside it, and the app
  read only `message`. So opening a pull request could fail with a sentence that identified nothing, and
  worse: the two ordinary outcomes recognised by their wording — *No commits between …* (there is simply
  nothing to merge) and *A pull request already exists for …* (adopt the open one) — never matched, so
  both were reported as hard failures. The reason is now lifted out of `errors`, including field-level
  entries as readable phrases (`PullRequest.head is invalid`).
- **Refused writes are logged.** Writes were the one thing the app never recorded, so a failure left
  nothing behind: the diagnostics log showed the work leading up to it and then stopped, and the only
  account of what GitHub said was a sentence in a dialog already dismissed. Path, status, refusal kind
  and GitHub's message — no token, no request body.
- **`failures.test.ts` was a time bomb.** Its fixtures carry absolute dates and the code under test drops
  anything older than a week, so all 26 of its assertions passed until seven days after they were written
  and then failed for good, saying nothing about the code. The clock is now frozen to the date they were
  written against.

## [2.1.0]

**The auto-rerun engine stops being a black box.** It used to work out a precise reason for every run it
passed over and then throw it away, so a pull request that quietly stopped being retried looked
identical to one with nothing to do. Every decision is now recorded — including the decisions *not* to
act — and readable inside the app. Three real bugs were hiding behind that silence, and all three are
fixed here. Pull requests also gain a **merge** button that clears the description and hands the PR to
GitHub to merge once its checks pass.

### Added
- **A Diagnostics tab** (desktop, opt-in under **Settings → Diagnostics**) that reads Job Monitor's own
  log inside the app: the tail of the file, newest first, following live. Filter by scope, or search —
  the search covers each record's attached details, so a run id, PR number or failure fingerprint finds
  its own lines even when the sentence never mentions them. Every line expands into the facts behind it.
  It reads a bounded tail rather than the whole 5 MB, says so (`the last 512 KB of 4.1 MB`) instead of
  implying it has everything, and shows a line that failed to parse rather than leaving a silent gap
  where a crash mid-write happened. Off by default: it is a window on the app rather than on the work.
- **Every auto-rerun decision is logged**, with the facts needed to act on it — the age against the
  configured window for a run judged too old, the fingerprint and the streak for a repeated failure, the
  record that settled it for one already handled. The engine's own state is logged whenever it changes,
  since `off`, `no-permission` and `no-workflows` stop the poll entirely and a tick-side log would go
  quiet exactly when someone asks why nothing happened. A verdict is written when it *changes* rather
  than on every poll, so a size-capped file cannot fill with one repeated sentence.
- **An arm auto-merge button** on every open pull request. It clears the PR's description and asks GitHub
  to merge as soon as the required checks pass. It confirms first and shows you the description it is
  about to delete, because that text cannot be recovered — a pull request body has no edit history for
  this app or the API to restore from. Clearing happens *before* arming, deliberately: a PR that is
  already green merges within seconds of being armed, so clearing afterwards would race the merge and
  lose. Pick the strategy — squash, merge commit or rebase — under **Settings → PR automation**.
- **An `auto-merge` badge** on pull requests that already have it armed, naming the strategy and who
  armed it. It is also how you tell at a glance which PRs the auto-rerun engine will act on at all,
  which the list previously gave no way to see.
- **Auto-rerun activity now shows on the pull request itself**, as a `re-run ×3` badge with the detail in
  a hint: every attempt with its workflow and time, and, if the engine has since gone idle, why.

### Changed
- **A second write exists.** Arming auto-merge writes twice — `PATCH .../pulls/{n}` to clear the
  description, and the `enablePullRequestAutoMerge` GraphQL mutation, which has no REST equivalent and is
  the only GraphQL call in the app. Both go through the same gate as re-running jobs: every write in the
  codebase funnels through one function that refuses to run unless the token has been proven able, and
  the controls stay hidden otherwise. Nothing else is written — no dispatching, cancelling, pushing,
  commenting, or merging a PR directly.
- **"Stop when the failure repeats identically" is now a count**, not a switch: *Allow the same failure
  this many times*, **5 by default**. The old behaviour was this same rule with the count fixed at 2 —
  which gave a flaky test that fails identically twice and passes on the third go no chance. A
  *different* failure in between starts the count over, and `0` switches the brake off.
- **Auto-rerun activity moved out of the Failures tab.** One shared list there put it in the wrong place
  twice: you had to be on that tab, and with more than one PR being retried it said nothing about which.
- **The diagnostics log path moved into its own Settings tab**, out of **AI integration** — the log
  covers the whole app, not just the analyses.

### Fixed
- **A pull request being actively retried would silently stop being retried.** The "ignore runs older
  than" window was measured from the run's `created_at`, which GitHub never moves — so a run re-run for
  three days still reported itself as three days old and fell out of a 72-hour window while its last
  attempt was minutes ago. It is now measured from `run_started_at`, which resets with each attempt.
  GitHub's own refusal to re-run anything more than 30 days after its first run is enforced separately,
  from `created_at`, because that is the clock GitHub uses; conflating the two is what caused this.
- **The engine reported "this attempt was already re-run" about attempts it had never re-run**, and the
  number of re-runs could not be read from its own records. A decision *not* to re-run was filed among
  the re-run requests, which both overstated the count by one and hid the real reason behind a false one.
  Requests and declined verdicts are now separate, the stored verdict is reported as itself, and existing
  records are migrated on read so nothing has to be cleared.
- **The identical-failure limit lapsed whenever a failure could not be fingerprinted.** An uncomputable
  fingerprint was treated as permission to proceed, so an intermittently failing lookup let a run climb
  to the attempt ceiling on a failure nobody had ever compared — observed doing exactly that. Now: if it
  can't check, it doesn't re-run, and it says why, on the PR and in the log. It retries on the next poll.
- **A stored "gave up" verdict is reconsidered when the limit is raised.** A stopped run's attempt number
  never changes again, so a verdict cached under a tighter limit would otherwise stand forever and make
  the new setting look inert.
- **A pull request whose runs couldn't be listed no longer looks like one with nothing to do** — that
  failure was swallowed silently, and the two want different fixes.

## [2.0.0]

**Failures stop being something you go looking for.** They get collected into one live list, written up
as a bug report you can paste straight into Teams or a GitHub issue, and — for pull requests waiting on
auto-merge — retried without you. On the desktop, your own `claude` will read a failure and tell you
what broke, why, and who broke it.

Three things worth knowing before the detail:

- **Job Monitor is no longer strictly read-only — the reason this is 2.0.** Exactly one write exists — re-running failed jobs —
  and it is off by default, limited to workflow files you name, and hidden entirely unless your token is
  verified as able to use it.
- **The AI features are the only thing that leaves GitHub**, they run your local CLIs rather than any
  service of ours, they only ever run when you click, and your GitHub token is never passed to them.
- **Everything expensive is cached for a week** — analyses, logs, annotations — keyed so that a re-run
  can never be shown a previous attempt's answer.

### Added
- **Auto-rerun failed jobs.** For a pull request with **auto-merge enabled**, when a run of a
  workflow you've named finishes as *failed* or *timed out*, Job Monitor asks GitHub to re-run its
  failed jobs. Configure it under **Settings → PR automation**, where the workflow field is a
  combobox over the repo's real workflows (exact file names, so a typo can't silently arm nothing).
  Two brakes keep a genuinely broken PR from burning CI: **Max attempts** (10 by default), counted
  against GitHub's own attempt number so it survives restarts, and **stop when the failure repeats
  identically**, which compares the failing tests and steps against the previous attempt. Cancelled
  runs are never re-run — a cancel is normally deliberate — and neither are runs waiting on a human
  approval. The trigger is state-based, so a run that failed while the app was closed is picked up
  too; what has already been requested is remembered, so reopening the app never repeats itself.
- **Re-run failed jobs by hand.** Pull requests (and their Overview tiles) get a re-run button that
  lists the failed runs for that commit, so you don't have to find the run on GitHub. The PR's
  checks start being watched again immediately.
- **Failures tab.** Every failing job the app can see — across your open pull requests, the recently
  merged ones, **and the latest run of every flow you track** — in one live list that refreshes on the
  normal polling cycle, with a count on the tab. The list is split into **Pull requests** and
  **Flows** sections with a group per PR or flow inside; every group starts **collapsed**, so a red
  board reads as a short list of what is broken. Each header carries a count, clicking it opens the
  group, sections collapse too, and what you open or close stays that way across reloads. Nothing is
  fetched for a group you haven't opened, and both panes fill the window height rather than being
  capped. The tab looks back **one week** and no further — older failures are history, and not
  scanning them keeps stale PRs and a long-red nightly from costing requests on every poll. Each failure comes
  with a **Markdown report** — one per job, so one per matrix worker — carrying the PR and branch,
  the workflow and run, the step that failed, the **failing tests** with `file:line` and message, and
  a tail of that step's log. The **GitHub / Teams** switch changes how it reaches the clipboard:
  GitHub gets Markdown, which its editor renders on paste, while **Teams gets rich text** — Teams
  doesn't render pasted Markdown (it only applies its shortcuts as you type), so the report is copied
  as rendered HTML and a plain **Ctrl+V** keeps the headings, bold, links, bullets and log block. Tick
  several failures to copy them all at once. Test names load
  as failures appear, so nothing has to be clicked first. Each report ends with a short **fingerprint**
  of the failure, so two reports about the same break are recognisable — the same value the auto-rerun
  uses to decide a failure is deterministic. Since a finished job's annotations and logs never change,
  what has been fetched is **remembered for a week**, so revisiting a failure is instant and costs no
  API requests — and a re-run is never served stale data, because it mints new job ids.
- **Recently-merged pull requests** are now tracked (10 by default, configurable, 0 to switch off),
  so a failure that landed anyway stays reviewable instead of vanishing with the PR.
- **Auto-rerun notifications**, opt-in alongside the existing PR and flow ones. Fires when jobs are
  re-run for you *and* when a re-run is refused, so nothing happens silently.
- **Explain with Claude** (desktop app only), at **two depths, with a button each**. A **Quick read**
  answers "what failed" from the log Job Monitor already has — Sonnet at medium effort, told it has
  about a minute, no tools, no fetching; if the log doesn't say, it says so and names the one thing
  worth looking at next. A **Deep analysis** answers "why" — Opus at high effort, with read-only tools
  and the whole run to dig through. Triaging a red board asks the first question five times and the
  second one once, and a single button served one of them badly. Both feed the report; the deep one
  wins when you've run both. Claude **investigates** on the deep pass rather than reading the
  summary: it greps the raw log for the runner's own failure lines, **downloads the run's artifacts** to
  read the JUnit/HTML test report for failing test names and assertion diffs, reads the workflow file for
  the exact command and how a shard selects its subset, and reads the PR diff to tell a test the PR
  touched from an unrelated regression. Its tools are read-only and enumerated — no write or edit tool,
  no general shell, a throwaway scratch directory, and no access to your GitHub token. The progress
  dialog shows the phase, the log size, an elapsed counter, **what Claude is doing** (each command and
  file read as it happens) and **what it is writing** as the answer streams in — with a **Stop** that
  really kills the local processes. The deep pass prefers the whole run's failed-step log via
  `gh run view --log-failed` — far more than the tail the report shows — falling back to the job's own
  already-fetched log when `gh` is absent or its download aborts; the quick pass skips `gh` entirely. Only `claude` is required; `gh` just makes the analysis wider. The report is then led by **the problem in prose** (what broke, where, quoting the decisive
  log lines, and whether it looks like infrastructure rather than code), followed by the verified links
  and facts, and ending with the **suggested fix collapsed and labelled as generated**. Only the prose
  comes from the model: every link, SHA, workflow and test name is supplied by Job Monitor, and the
  prompt forbids inventing any — a bug report with a confident wrong link is worse than one with none.
  This is the one feature that sends data outside GitHub, so it runs only on that click, never in the
  background, and never touches your GitHub token. What it writes is streamed into the dialog **one
  sentence per line**, scrolling to follow the newest line — and stopping the moment you scroll up, so
  it never drags the view away mid-read.
- **Analyses are kept for a week**, per failure *and* per depth, so reopening a failure you looked at
  yesterday doesn't spend another call and a quick read never overwrites a deep one. Safe for the same
  reason as the other week-long caches: the key contains the job id, and re-running failed jobs mints
  new ones, so a new attempt is never shown a previous attempt's verdict.
- **A log viewer with three views, and a switch between them.** **Job log** is the failing job's own
  output through the GitHub API — no `gh` needed, and usually already in hand. **Whole run** is every
  failed step of the run via your local `gh`, which is the only view that shows an *upstream* job's
  output: when the failure you clicked is an aggregator reacting to `needs:`, its own log can never say
  what broke. **Claude** is the log rewritten — decisive lines first, noise cut, a short italic note
  where a line needs one, and a closing list of what the log doesn't show. All three coexist; none
  replaces another, and the two raw ones cost nothing.
- **Logs are coloured.** Workflow commands (`##[error]`, `##[group]`), the command each step ran, test
  failures (Gradle/JUnit, pytest, jest **and** `dotnet test`'s `Failed X [12 ms]` form), stack frames,
  build-tool section headers and success lines each get their own colour, with ANSI escapes stripped
  first so colour codes can't hide a match. Done locally rather than by a model: it's instant, free,
  offline and identical every time, and prose that merely mentions "error" is deliberately left plain —
  colouring everything trains you to ignore the colour.
- **"Who broke it" copes when run history can't answer.** Two things a real investigation hit. A green
  run only counts as a baseline if it **actually ran the failing test** — jobs are conditional, and a
  suite that was skipped cannot have passed; treating a green-but-skipped run as a boundary is how an
  innocent commit gets named. And one workflow file behaves as several pipelines depending on its
  trigger, so a green `push` beside a red `workflow_dispatch` is two pipelines rather than a boundary.
  When there is no usable boundary it now **searches the commit tree by path** instead — starting from
  the file in the stack trace and reading what those commits changed. That surfaces two things a run
  range never would: a test that is simply new and has never been green anywhere, and an input file — a
  fixture, a baseline — that changed while the code did not. It also adds a fourth verdict, **never
  verified**: nothing regressed, something started being checked, which belongs to whoever made it run
  rather than to whoever wrote the code. A commit that only changed *which jobs run* revealed the break;
  it did not cause it.
- **The verdict stays about who broke it.** A real answer came back as three paragraphs of evidence, a
  table of eighteen unrelated tests from other branches, an accounting of infrastructure failures and a
  recommendation about the build farm — wrapped around one line saying nobody broke it. Every line now
  has to bear on the attribution: the reasoning is capped at three sentences, the boundary is the two
  runs rather than every run listed, and the flaky table covers **only the test that actually failed**
  instead of everything the scan saw. A wider pattern is still worth reporting — as one sentence with
  the counts, not twenty rows — and anything broader is a single closing sentence rather than a section.
- **"Who broke it" opens with a fixed summary** — four labelled lines (`Who`, `What happened`, `When`,
  `Kind`) so the answer is scannable and pastes into a chat without editing, with the nuance in a
  paragraph below rather than mixed into it. Logins are written as `@login` and **rendered as
  highlighted chips**, so the person is the first thing the eye lands on. `Kind` is one of `commit`,
  `flaky test`, `infrastructure` or `never verified`, and when it is not a person the verdict says
  `nobody — …` rather than leaving it to be inferred.
- **Add verdict to report.** A button in the analysis window carries the verdict into the bug report,
  above the problem statement — naming a commit and an author is the most actionable line there is.
  Only the summary goes in, not the working. It is never included by default, because a bug report that
  names someone should be a deliberate act, and the choice is remembered with the analysis on the same
  week-long TTL: it survives closing the dialog and restarting the app, and expires when the analysis
  does, since a verdict about an attempt means nothing once that attempt has aged out.
- **Continuing an analysis continues it.** The resume prompt told the model to spend what was left on
  reaching an answer, so a continued run wrapped up instead of finishing the work — declining to judge a
  patch it had not read. It now says plainly that the interruption was a time limit rather than a
  request to conclude, that the budget is fresh, and that an unread diff is not an unknowable one.
- **Twenty-minute timeouts on the log paths.** Fetching a run's log with `gh` was capped at one minute
  and reading a response body at two — both far too short for a large repository, where the download
  itself is minutes of work. A log that never arrives costs the whole analysis, not just the fetch. The
  quick read keeps its short bound, since it promises about a minute and cannot spend twenty waiting.
- **Models and efforts picked by measurement.** Benchmarked on a realistic failing log: `haiku` was
  slower than `sonnet` on both single-turn tasks *and* missed the failing test's name, so it is not a
  default anywhere; `high` effort on a one-turn task cost 50% more time for an identical answer. The log
  rewrite drops to **low** effort — it is a transformation with checkable output, and low passed every
  structural check while being fastest. The quick read stays at **medium**: measurement could not
  separate it from low on a clean log, but the judgement it makes only gets hard on messy ones, which a
  single sample cannot test. Investigating tasks keep Opus — `deep` at high, `blame` at medium.
- **A third analysis: "Who broke it".** Where the quick read answers *what failed* and the deep analysis
  answers *why*, this one answers **who** — the commit and its author. It has its own skill
  (`.claude/skills/flow-blame/`) and runs Opus at medium effort: judgement, but breadth rather than
  depth.

  **Several commits usually land between two runs of a flow**, so the work is deciding which one is
  responsible. It reads what each commit actually changed and weighs it against the failing test —
  whether it touches the code under test, the test's own fixtures or baselines, something the failure
  text names, or shared machinery like a dependency bump. Order of arrival is treated as a weak signal:
  the commit nearest the first red run is not more likely for being nearest, and breadth is not guilt.
  Each candidate gets a **likelihood with the evidence behind it**, and the calibration is spelled out —
  90%+ only when one commit touches the code under test and the others plainly cannot reach the failure;
  everything under 40% means "I don't know", said in the verdict rather than promoted to an accusation.
  A merge commit is attributed to the author of the merged work, not whoever pressed the button, and an
  unresolvable author is `unknown` rather than a guess.

  It still rules out a **flaky test** and then **infrastructure** before naming anybody, because on a
  merge-gated branch the code has already passed the workflow that is now failing — so both are likelier
  than a bad commit, and a wrong name costs more than no name.

  It also checks whether a test is **already known to misbehave** — but only on the branch being
  analysed. Fanning out across branches turns a bounded question into a survey of the repository, which
  was by far the most expensive thing it did; if evidence from elsewhere is genuinely needed it says
  which branch and why and stops, rather than spending it unasked. What the history *means* depends on
  the branch: on a merge-gated one (`main`, or a release branch named by version) a failure is strong
  evidence of an unreliable test, because the code already passed that same workflow at the gate; on a
  pull-request branch it only tells you whether the test is intermittent. Two rules hold either way — a
  run that fails without naming a test is infrastructure rather than a flake, and a test that fails on
  *every* run is broken rather than flaky. Findings are reported as a table with **links to the runs
  they failed in**.
- **Markdown tables render**, in the analysis window and the report — needed for the flaky-test list,
  and they scroll inside their own container so a wide table never makes the page scroll sideways.
- **The triage procedure is a Claude Code skill** (`.claude/skills/failure-triage/`), not a wall of
  prompt. The bridge writes it into each run's scratch directory, which is where `claude` looks for
  skills, so the deep analysis loads it as a skill; the same file is checked into the repo, so a
  developer can run the identical procedure by hand in an ordinary `claude` session. One source, and a
  test fails if the two drift. It codifies four things the prompt only gestured at:
  - **Triage the job you were asked about, not the pull request.** A triage that returns five findings
    makes the reader do the sorting that was the point of asking.
  - **Go to a neighbouring job only when this one structurally cannot answer** — an aggregator that
    exits non-zero because a `needs:` job failed can never name a cause from its own log. Then say which
    job you ended up in, because the reader clicked a different one.
  - **Retry a failed download once**, then try `GODEBUG=http2client=0` or a cheaper source. Rate limits,
    blob-storage timeouts and HTTP/2 stream errors are transient and none of them mean the artifact is
    missing — but two attempts is the limit, and saying the artifacts were unavailable beats presenting
    a guess as evidence.
  - **Aim for two to four tool calls**, stopping as soon as the cause can be named and quoted. Reading
    everything first is not thoroughness; it is a slower answer of the same quality.
- **A "Check AI integration" button** under **Settings → AI integration**. It reports whether `claude`
  and `gh` are on PATH, their versions, and whether `gh` is signed in — each with what it is for and
  what to do when it is missing. `claude` is marked required and `gh` optional, because that is the
  actual dependency: without `gh` an analysis uses the log Job Monitor fetched itself. It is careful to
  say it checks *presence, not health* — `claude --version` succeeding does not prove it can reach the
  API — and points at the diagnostics log when the tools are found but a run still fails. Previously the
  only signal was the AI controls quietly not appearing, which tells you nothing about why.
- **"Who broke it" has settings like the other three tasks.** Its model, effort and custom prompt were
  in the config but had no controls, so they could not be changed from the app.
- **Settings → AI integration**, with one switch for the whole feature and per-task controls under it.
  **Enable AI integration** off hides every AI control — the analysis buttons and the Claude log view —
  whether or not `claude` is installed; it defaults on, since the feature was already gated on the CLI
  being present and on an explicit click. **Additional instructions** are appended to every request for
  standing context the model can't infer ("our Windows tests are flaky, say so rather than blaming the
  diff") — additive, so unlike a custom prompt it can't break anything. Each of the three tasks then has
  its own **model**, **reasoning effort** and optional **custom prompt**; a custom prompt replaces the
  wording but never the contract, since the verified facts, the failing tests, the log and the required
  output sections are still appended — an override can't produce a reply the app fails to read. Model and
  effort are re-checked against a closed list in the main process, because settings reach it over IPC and
  nothing from the renderer is trusted there.
- **`gh` and AI are now separate permissions.** Fetching the whole run's log with `gh` is not an AI
  feature, and switching AI off no longer takes it away — while the Claude log view goes with everything
  else.
- **The dashboard uses the whole window.** Every tab was capped at 1200px and centred, which left a
  wide monitor mostly empty — and made the Failures tab worst of all, where the failure list and its
  report had to share that 1200 between them. Settings keeps its cap: it's a form, and a text field
  stretched across a 4K monitor is worse, not better.
- **The analysis window is rendered too.** The problem and the suggested fix arrive as Markdown and the
  model uses it — the decisive log line comes back in backticks — but they were shown as monospace text,
  where that quoting was invisible. Both now render, with a quoted log line coloured like the log itself
  and a fenced reproduce command shown as a block. The live narration renders the same way, and the
  commands feed picks out its verb (`$`, `read`, `grep`, `glob`) from the argument.
- **The report is rendered, not shown as raw Markdown.** The Report view is the default and it was a
  wall of grey `###`, `**` and literal `<details>` tags. It now renders — headings, links, inline code,
  and the log tail as a real collapsible with the log coloured inside. GitHub renders this Markdown when
  you paste it, so a rendered preview is the truer preview; **Raw Markdown** toggles back to the exact
  text the Copy button puts on the clipboard.
- **Markdown renders properly in the log window** — headings, fenced blocks, bullets, bold, italics,
  inline code and links — and a log quoted inside Claude's explanation is coloured the same as the log
  itself. Rendered through React rather than injected HTML, because log text is whatever the build
  printed.
- **Logs paste into Teams properly.** Three fixes to the rich text Teams receives. The code block set a
  light background but no text colour, so it inherited the host's — in Teams' dark theme that was light
  text on a light background, i.e. invisible. It relied on `overflow-x: auto`, but a chat message can't
  scroll sideways, so long log lines were simply clipped; they now wrap. And it assumed `<pre>` would
  keep its monospace font, which Teams doesn't reliably preserve when it normalises pasted HTML — the
  font, size and line-height are now explicit, with a border so the block still reads as a block if the
  background is dropped. Inline code is styled for the same reason: no stylesheet travels with a paste.
- **The Teams report no longer pastes eighty lines of log.** GitHub folds the tail away behind a
  summary; Teams has no collapsible, so the full log buried the two lines that mattered and pushed the
  metadata and the suggested fix off the screen. Teams now gets the last 20 lines, says how many it
  dropped, and links to the full log.
- **Each failure row shows what already exists for it** — ⚡ a quick read, ✦ a deep analysis, 📄 a
  rewritten log. The list is where you choose what to spend a call on next, and the only way to find out
  whether a row had been looked at was to open it, which is the click the icons save. Results live a
  week, so on a Monday morning much of a red board may already be answered.
- **A ✦ analysed badge** on pull requests and flows whose failures already have a stored Claude result,
  so a week-old red board shows at a glance which parts have already been looked at.
- **Analyses run concurrently and show it.** A running analysis puts a spinner in its own button, and
  the quick read, deep analysis and log rewrite can all be in flight at once — they no longer share a
  slot, so starting one never discards another.
- **Token capability readout** on **Settings → Token & login**, next to "loaded in memory": it says
  whether the token can re-run jobs and, if not, why.
- **DevTools on F12** in the desktop app (Ctrl/Cmd+Shift+I also works). The app has no menu bar, so the
  usual accelerators didn't exist and a packaged build had no way to open them at all.
- **A diagnostics log on disk**, at `<userData>/logs/job-monitor.ndjson` — the path is printed at
  startup and shown under **Settings → AI integration → Diagnostics**, with buttons to copy it or open
  the folder. One JSON object per line, so a whole analysis can be pulled out with a single `jq` filter:
  the exact command line, every tool call in order, how long it took, how big the stream and the answer
  got, and how the run ended. The console only helps whoever had DevTools open at the time, and the run
  worth reading is always one that already happened. Renderer-side events (log fetches, cache hits,
  failed requests) go to the same file, so it tells the whole story rather than half of it. Capped at
  5 MB with one previous file kept; it records sizes and outcomes, never your token and never the
  contents of a log.
- **Diagnostics in the DevTools console**, scoped and colour-tagged: which log was downloaded or served
  from cache, why a log couldn't be read, what each analysis was given to work with, and — forwarded
  from the main process — the exact `claude` command line, the log source and any stderr. On in dev, off
  in a packaged build; `jobMonitorDebug.enable()` turns it on, and the console says so on startup.

### Changed
- **Job Monitor is no longer strictly read-only** — and the docs no longer claim otherwise. Exactly
  one write exists (`POST .../actions/runs/{id}/rerun-failed-jobs`); it is off by default, limited to
  workflow files you list, and **hidden entirely unless the token is verified as able to use it**.
  Verification needs a **classic token with the `repo` scope** on a repository you can write to. A
  read-only token, or one whose account only has read access to the repo, simply doesn't see the
  feature. A **fine-grained token never sees it either**, even one granted `actions: write`: GitHub
  offers no way for a browser to check that, so Job Monitor assumes it can't rather than offering a
  control that fails. Nothing else — dispatching workflows, cancelling runs, pushing, commenting,
  merging — is possible, then or now.
- The token guidance no longer says a read-only fine-grained PAT "also works": it works for most
  reading, but not for logs and not for re-running.

### Fixed
- **Regex flows now search the whole repository, not its first 100 workflows.** The workflow list was
  read as a single page — GitHub's maximum is 100 per page — so on a repo with more workflows than that,
  a regex simply never saw the rest: a matching workflow past the cut-off produced no card, and the
  match preview counted "of 100 workflows" as if that were the total. The list is now followed to the
  end (merged by workflow id, so a workflow added mid-walk can't yield two cards for one workflow), and
  each page is ETag-cached like everything else, so re-polling a big repo costs one cheap 304 per page.
  Naming a flow's workflow by its *display name* was limited the same way and is fixed with it.
- **The match preview no longer understates a broad regex.** It counted matches only up to the 50-flow
  ceiling, so anything wider looked like exactly 50; it now reports the true number and says that
  tightening the regex — not raising "Max matches" — is what will help.
- **A modal over the Failures tab could freeze the app.** `useFillHeight` measured after *every* render
  and relied on the measurement settling to stop itself. Opening a dialog makes it oscillate between two
  values, so it never settled and React aborted with "maximum update depth exceeded". It is now driven
  by a `ResizeObserver` on what is actually above it, with a pixel of tolerance so a scrollbar appearing
  and disappearing cannot start it again.
- **An unfinished analysis can be continued instead of restarted.** A blame run on a large repository
  spent twenty minutes and thirty tool calls, found the actual cause, and was then killed by the clock
  before it could write the answer — and the only option was to start again and pay for all of it a
  second time. The CLI session is now captured and kept, and an incomplete run offers **Continue**,
  which picks up with everything it had already established. It survives a restart of the app, since
  the session id is stored with the partial answer. (This needs the run's working directory to persist —
  `claude --resume` finds a session by the directory it ran in — so scratch directories are now derived
  from the analysis rather than random, and kept when there is something to continue from.)
- **Much longer timeouts.** Ten minutes killed a real investigation mid-answer. Deep analysis now gets
  25 minutes and "Who broke it" 40, because a timeout that stops a run part-way costs the entire run;
  the budget that actually guards against a runaway is the turn limit, which is bounded and cheap to
  reason about.
- **A cut-short answer is no longer shown twice.** On an unfinished run the "document" and the live
  narration are the same text, so the dialog was printing it once as each.
- **A long investigation is no longer cut off mid-stream.** One size cap covered both the *reply* and
  the raw `stream-json` output, but those differ by two orders of magnitude: the stream carries every
  tool call **and every tool result**, measured at ~126× the answer inside it. A real investigation blew
  past 256KB, the bridge stopped following, and because the `result` event comes last, the run's own
  reason for stopping was exactly what got dropped — leaving nothing to report but the exit code. The
  stream now has its own generous ceiling and the reply is capped in the parser, where the limit
  belongs. Truncation, if it does happen, is now itself a reported reason.
- **A run that ends early no longer throws away what it wrote.** `claude` exits non-zero with an *empty*
  stderr when it hits its turn limit — the reason lives only in the final event of its JSON stream, which
  the bridge was discarding along with everything the run had already produced. An investigation that
  spent twenty tool calls and written a partial verdict came back as `claude exited with code 1`. The
  reason is now read from the stream and said plainly ("it ran out of turns after 24"), and the partial
  answer is kept and shown under a warning that it is partial — throwing it away also throws away
  everything it cost.
- **"Who broke it" gets a much larger turn budget.** It fetches the run list, then a diff per candidate
  commit, then the flake evidence across several branches — each its own turn. 24 ran out on a real
  repository before it could finish, which is a wasted Opus run rather than a slow one.
- **Job logs are no longer downloaded twice at once.** Opening a failure's report starts a log
  download, and asking Claude to explain it straight after started a *second* one — the second caller
  couldn't see a cache entry the first hadn't written yet. On a large log both callers then waited on
  two identical multi-megabyte downloads, and the quick read sat on its first phase long enough to look
  hung. Concurrent callers now share one request.
- **The quick read no longer claims to be "reading the log already fetched" while it is downloading
  one.** It says which it is doing, and gives up on the app's own log after 45 seconds rather than
  waiting indefinitely — the quick read promises about a minute and can't spend it waiting for a log.
- **A failure with no job log can still be explained.** Not every failing check run is a plain Actions
  job — when its details link doesn't point at one there is no job log to fetch, and the quick read
  refused outright. It now works from the check-run annotations, which name the failing test with its
  file, line and message; the dialog says no log was available, and the model is told to say so too
  rather than describe a log it never saw. It only gives up when there is no log *and* no annotations.
- **When it does give up, it says why** — no Actions job log, a download that failed, or one that timed
  out — instead of a single generic message that covered all three.
- **"What Claude is doing" no longer disappears when an analysis is reopened.** Only the prose was
  stored, so a cached analysis came back as a verdict with its evidence trail missing — and the trail is
  how the verdict is judged: "downloaded the artifacts, read the TRX report" earns trust that the same
  words alone don't. The tool calls are now stored with the analysis, along with which log was read and
  whether it was truncated, and the heading reads **"What Claude did"** once the run is over.
- **Streamed turns no longer run together.** Each assistant message is a whole block, and consecutive
  blocks were concatenated bare — "…artifacts for this run." followed by "Root cause is upstream:…"
  arrived as "…for this run.Root cause is upstream:…", with no space left for a sentence splitter to
  recover. Blocks are now newline-separated at the source, so the live pane and the final answer both
  break where the turns do, and the live pane is sentence-split like the finished analysis instead of
  showing one paragraph per turn.
- **A response whose body stalls no longer hangs forever.** The request timeout was released as soon as
  headers arrived — it has to be, or a large healthy download would be killed mid-transfer — which left
  every *body* read with no deadline at all. Job logs and artifacts both redirect to blob storage, so the
  body is the slow part by design: headers came back fine, the body never finished, and nothing in the
  app was able to give up on it. Bodies now have their own deadline and report a real error.

## [1.1.0]

Flows can be described by a regex instead of one workflow: one pattern, one card per matching
workflow.

### Added
- **Regex flows.** A flow's workflow field now has two modes: **One workflow** (as before) or
  **Every workflow matching a regex**. Give it a pattern like `^nightly-`, choose whether it's
  tested against the workflow's **name**, its **file name** or **either**, toggle case sensitivity,
  and cap the expansion with **Max matches**; the editor lists the matching workflows live as you
  type. Every match becomes its own card on the **Overview** and the **Flows** board, with its own
  runs, run/job filters and per-flow visibility filter (all inherited from the regex flow), and
  workflows added to the repo later show up on their own.
  Matches take part in **groups and drag & drop** like ordinary flows: drag one anywhere and it
  keeps that spot (remembered per workflow, not per position), while the rest of the pattern —
  including future matches — stays where the pattern was placed. Dropping a card into a collapsed
  group now expands it, and a regex that matches nothing says so instead of showing an empty board.
  Existing configs are unchanged: no pattern means the old single-workflow behavior.
- **Unmatched places editor.** A spot on the board whose flow is gone — an edited regex, a renamed
  or deleted workflow — is kept, so the card comes back where it was when the workflow does. The
  group header now shows an **N unmatched** button that opens an editor listing those leftovers by
  workflow (and which regex flow they came from), where you can drop them individually, per group,
  or all at once. Removing one only forgets the placement: flow definitions and regexes are never
  touched.

### Changed
- **Tighter spacing between groups** on the Flows board and the Overview.

## [1.0.0]

The per-flow "hide when empty" toggle grows up into a two-way visibility filter.

### Changed
- **Per-flow visibility filter — Hide when / Show when.** The flow editor's old *Hide when empty*
  checkbox is now a filter with a direction. Pick **Hide when** to drop matching flows from the board
  (the previous behavior) or **Show when** to keep *only* the matching ones and hide the rest, then
  choose the condition: the flow has **no runs**, **all runs skipped**, **no / tiny artifacts**, or
  **a named job is in a given state** (e.g. a `test` job that was skipped). Applies to both the
  **Overview** and the **Flows** board. A flow whose state is still loading stays visible in both
  modes, so there's no flicker. Existing configs are read unchanged and default to *Hide when*,
  preserving the old behavior.

## [0.9.0]

A Settings overhaul plus a workflow picker that fills in a flow for you from the repo's recent runs.

### Added
- **Browse recent workflows** — the flow editor's workflow field now has a **Browse…** button that
  opens a dialog listing every workflow that ran in the repo **in the last 24 hours**, grouped by
  workflow × branch × trigger, showing each one's status, file, trigger event, branch and last-run
  time. **Search** by name/file and **filter** by trigger or branch; pick a row and the flow's name,
  workflow file, branch and event are filled in automatically. The full day is paged through (not
  just the newest 100 runs), and the list is ETag-cached so reopening is cheap.

### Changed
- **Settings is split into focused tabs** — **Token & login**, **Repository**, **Polling**, **Flows**,
  **Notifications**, and (desktop only) **Updates**. Previously the repository, polling, flows and
  updates settings were all stacked under one "Polling" tab.
- **Flow cards are tidier** — only **Name** and **Workflow** (with the new Browse button) show by
  default; owner/repo, branches, events, max-runs and the "hide when empty" filter now live under a
  collapsed **Additional settings** section.

### Fixed
- **Action-icon alignment** — the per-job icons under an expanded flow run (and the per-check icons
  under a PR) now line up with the run/PR row's icons instead of being inset by the nested table's
  padding; the remove-flow trash icon also aligns with its row.

## [0.8.0]

### Fixed
- **Creating/renaming a group now works in the desktop app.** It used `window.prompt`, which Electron
  doesn't implement (it silently returns null); replaced with an in-app input dialog (works in the
  browser too).
- **"Check for updates" no longer crashes the desktop app.** A missing `updateToken` declaration in
  the main process threw `ReferenceError: updateToken is not defined`.

### Changed
- When there are **no groups at all**, the lone "Ungrouped" header is hidden — flows just render one
  after another.

## [0.7.0]

### Added
- **Artifact downloads** — flow runs, pull requests and their Overview tiles now have an artifacts
  button that opens a dialog listing the run's artifacts (sorted by name, with sizes). Download one
  as its own `.zip`, or select several / **Download all** to get a single combined `.zip` with a
  folder per artifact. The list is fetched lazily (and ETag-cached) so it only costs a request when
  opened; expired artifacts are shown but disabled.
- **Desktop downloads panel** — in the Electron app, downloads no longer save automatically: a panel
  (top-right button, with an active-count badge) shows each download's progress and status, and you
  press **Save** to write it to the Downloads folder, with a "Show in folder" action and a completion
  toast (bottom-right). In the browser, the browser keeps handling downloads itself.

### Changed
- **Node ≥ 22.12 is now required** (the repo pins Node 24 in `.nvmrc`). It's enforced via `engines`
  + `engine-strict`, so `npm install` fails fast on older Node instead of breaking deep inside
  Electron's installer (`ERR_REQUIRE_ESM`); the `electron:*` scripts also run a `check-node`
  preflight.

### Fixed
- **Auto-update now works for the internal app repo.** electron-updater read the release feed
  anonymously and got a 404 (the repo is internal). The desktop app now authenticates the updater
  with your GitHub token (passed from the renderer after unlock, never persisted), and picks up the
  published pre-releases. _Requires one manual update to a build that includes this fix._
- Dialogs use a thin, subtle scrollbar instead of the chunky default, and the artifacts dialog row
  no longer changes height when a download starts.

## [0.6.0]

A big dashboard-organization update: flow groups, drag-and-drop, a theme switcher, and a dedicated
full-screen Settings screen.

### Added
- **Flow groups** — organize flows into named groups in both **Overview** and the **Flows** tab.
  Drag flows between groups and reorder them, with a clear drop indicator showing where they'll
  land. Collapse a group — the collapsed header shows a status tally (✅ passed · 🟡 in progress ·
  ❌ failed). Group layout and membership persist locally across restarts.
- **Export / import board** — export the whole layout (groups + flow order) as JSON and move it
  between machines in a single file. Import replaces the current board. Your token and credentials
  are **not** included in the export.
- **Collapsible flow cards** — collapse a card into a thin strip; "accordion" behavior means
  expanding one collapses the others. Drag-and-drop reordering with a visible drop panel. Expanded
  state and position are remembered.
- **Theme switcher** — an icon-only button in the header cycles 🖥️ auto → ☀️ light → 🌙 dark. The
  dark theme uses GitHub's softer **dark dimmed** palette. Your choice is persisted.

### Changed
- **Settings** moved out of the navigation — it now opens **full-screen** from the gear icon in the
  top-right corner.
