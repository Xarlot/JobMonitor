---
name: flow-blame
description: Find who broke a CI flow — which commit and which author — weighing the candidates by what they changed when several landed between runs. Use when a workflow on a branch has started failing and you need the commit and the person to talk to, rather than why one run failed.
---

# Who broke this flow

You are naming **the commit that broke a flow and the author who wrote it**. That is a
different question from "why did this run fail" — you are reading run *history* and diffs,
not one log.

The answer someone wants from you is a name and a commit. Get there — but only through
evidence, because a wrong name costs more than no name: it sends the wrong person digging
and teaches everyone to distrust the next answer.

Answer in this order. Stop at the first one that fits: naming a developer's commit for
someone else's flaky test is the expensive mistake here, and it is the one that happens
when you look for a commit first.

## 1. Find the boundary

List recent runs of this workflow on this branch, newest first:

```
gh run list --workflow <file> --branch <branch> --limit 30 \
  --json databaseId,number,headSha,conclusion,createdAt,displayTitle
```

Find the **last successful run** and the **first failing run after it**. Those two commits
bound the change that could be responsible. If every run in the window failed, say so and
widen with `--limit 60` once — a boundary outside the window is a different situation and
you should report that rather than blame the oldest commit you can see.

**Compare like with like.** One workflow file behaves as several different pipelines
depending on what triggered it: a `push` run, a `schedule` run and a `workflow_dispatch` run
of the same file routinely execute different jobs, because the conditions inside it say so.
A green push next to a red dispatch is not a boundary — it is two different pipelines. Group
by `event` and find the boundary *within one event*:

```
gh run list --workflow <file> --branch <branch> --limit 60 \
  --json databaseId,number,headSha,event,conclusion,createdAt \
  --jq 'group_by(.event)[] | {event: .[0].event, runs: [.[] | {number, conclusion, headSha: .headSha[0:8]}]}'
```

**If nothing on this branch has ever passed**, the boundary is not here. Look at the branch it
merges into — that is where a working baseline would be, if one exists.

## 1b. Check the good run actually ran the failing test

This is the step that is easiest to skip and most likely to produce a wrong name.

A green run only counts as a baseline if it **executed the thing that is now failing**. Jobs
are conditional, test suites are gated behind flags or paths, and a suite that never ran
cannot have passed. A "last good run" that skipped the failing test proves nothing — treat it
as no baseline at all.

Compare what the two runs actually did:

```
gh run view <last-good-run-id> --repo <owner>/<repo> --json jobs \
  --jq '[.jobs[] | {name, conclusion}] | sort_by(.name)'
```

If the failing job is **absent** from the good run, or present but skipped, say so plainly:
*the last green run never ran this test*. Then the honest verdict is usually not that someone
broke it — it is that **nobody had verified it**, and it is failing the first time it is
actually exercised. That is a real and useful answer, and it belongs to whoever made the test
start running, not to whoever wrote the code it is failing in.

## 2. Ask whether it is intermittent before you ask whose fault it is

Look at the runs *after* the first failure. Then:

- **Passing and failing alternately** — this is a flake. Do not name a commit. Say which
  test is intermittent and how often it failed in the window.
- **Failing every time since the boundary** — consistent, so continue to step 3.
- **A deterministic error on a fixed input** — the same exception, from the same file, on the
  same fixture, every time — is never a flake, whatever the run pattern looks like. Say so and
  keep going.
- **Only the one failure, everything since is green** — a one-off. Say so; it is most
  likely a flake or infrastructure and there is nothing to bisect.

## 3. Rule out infrastructure

Read the failing run's log. If it fails **without naming a test** — a runner that died, a
registry or network timeout, disk exhaustion, a rate limit, a cancelled job, an image that
would not pull — it is infrastructure. Say so and stop. Infrastructure failures are not
anybody's commit, and attributing them to one sends the wrong person looking.

## 4. Name the commits in the range

```
gh api repos/<owner>/<repo>/compare/<last-good-sha>...<first-bad-sha> \
  --jq '.commits[] | {sha: .sha[0:8], author: .author.login, message: (.commit.message | split("\n")[0])}'
```

**One commit in the range?** That is your answer. Name the commit and its author plainly.

**Several?** Then the job is to work out which of them is responsible — that is the rest of
this skill, and it is the part that earns the answer.

**No usable boundary at all?** Then there is no range to compare, and you fall back to the
tree — see the next section. Do not invent a range by picking two runs that are not a real
boundary.

## 4b. No boundary: search the tree by path

When the branch has never been green, or the green runs never ran this test, run history
cannot tell you when it broke. The history of the *code* still can.

Start from the failure, not from the commit list. The stack trace names a file; that file has
a history:

```
gh api "repos/<owner>/<repo>/commits?path=<file-from-the-stack-trace>&sha=<branch>" \
  --jq '.[] | {sha: .sha[0:8], author: .author.login, date: .commit.author.date, message: (.commit.message | split("\n")[0])}'
```

Do this for each file the failure actually implicates — the class in the exception, the test
itself, and any fixture or input file it reads. Then read the content of the commits that
come back and judge them the way section 5 describes. A commit touching the exact class that
throws is worth more than any amount of proximity in time.

Two things this turns up that a run range never would:

- **The test is new.** If the test or its generated form was added recently and has never run
  green anywhere, it is not a regression at all. Say that.
- **The input changed, not the code.** A fixture, a baseline image, an expected-output file:
  these break a deterministic test exactly like a code change, and they are easy to miss
  because they are not source.

**When the same failure appears in two ports of the same code** — the .NET suite and the Java
suite failing on the same input with the same exception — the cause is in the **shared
source**, not in either port and not in whatever generates one from the other. Narrow the
path search to that shared code and say why you did; it removes a whole side of the tree from
suspicion in one step.

Attribute a merge commit to the **author of the merged work**, not whoever pressed the
button. `gh pr view <n> --json author,files` gets you both.

## 5. Weigh the candidates by what they changed

You have several commits and one failing test. Read what each commit actually touched and
score it against the failure. Fetch the diff for a candidate only when you need it:

```
gh api repos/<owner>/<repo>/commits/<sha> --jq '.files[] | {file: .filename, +: .additions, -: .deletions}'
```

Signals that a commit is responsible, strongest first:

1. **It touches the code the failing test exercises.** Same class, same module, same
   feature. The strongest signal there is, and usually decisive on its own.
2. **It touches the test, its fixtures or its baselines.** A changed expected-value file or
   a rewritten assertion breaks a test as surely as changed production code.
3. **The failure text names something it changed** — a symbol, a file, a config key. Match
   the exception message and the stack frames against the file list.
4. **It changes shared machinery** — build config, a dependency version, the test harness,
   a workflow file. Weaker per-commit, but it explains failures far from what it touched, so
   it goes up sharply if nothing else fits.
5. **It is large or a refactor.** Weak on its own — breadth is not guilt — but it raises the
   prior when the failure is diffuse.
6. **It changed a fixture, a baseline or an expected-output file.** Not source, and easy to
   overlook for that reason, but it breaks a deterministic comparison exactly as a code change
   does.

Signals *against*, which matter just as much:

- **It touches nothing the failure could reach** — docs, an unrelated module, comments,
  formatting. Say so and rank it near zero rather than leaving it in the list unexplained.
- **The same test failed before this commit landed.** Then it is not the cause, whatever
  else it looks like.
- **The commit only changed which jobs run** — a workflow condition, a path filter, a matrix
  entry. It did not break the test; it revealed a test that was already broken and had not
  been running. Say exactly that, because the fix belongs to a different person than a break
  would.

Order of arrival is a **weak** signal. The commit nearest the first bad run is not more
likely for being nearest; content decides.

## 6. Give each candidate a share of the blame

Report a **likelihood per candidate**, as a percentage across the ones you considered,
summing to about 100. It has to follow from the signals above and you must say which ones —
"70%: touches `PdfExporter.cs`, which is exactly what the failing assertion compares" is
useful; "70%: seems likely" is noise, and inventing a number you cannot justify is worse
than declining to.

Calibrate honestly:

- **One candidate at 90%+** only when it touches the code under test and the others plainly
  cannot reach the failure.
- **Two or three between 20% and 50%** is the normal shape of a real range. Say that the
  evidence does not separate them and name what would.
- **Everything under 40%** means you do not know. Say that in the verdict rather than
  promoting the least-bad guess to an accusation.

Never move a percentage to make the list look decisive.

## Is this test already known to misbehave?

Worth knowing before blaming anyone — but keep it cheap. **Scan only the branch you are
analysing.** Do not fan out across other branches: that turns a bounded question into a
survey of the repository, and it is the single most expensive thing you can do here. If
evidence from another branch turns out to be necessary, say which branch and why, and stop —
let whoever asked decide whether to spend it.

One call, for this branch:

```
gh run list --workflow <file> --branch <branch> --status failure \
  --limit 30 --json databaseId,number,headSha,createdAt,url
```

Then take the **few most recent** failing runs — three or four is enough to tell intermittent
from constant — and read what actually failed. Annotations are far cheaper than logs:

```
gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs --jq \
  '.jobs[] | select(.conclusion=="failure") | {name, id, url: .html_url}'
gh api repos/<owner>/<repo>/check-runs/<check-run-id>/annotations \
  --jq '.[] | select(.annotation_level=="failure") | {path, start_line, title, message}'
```

**What the answer means depends on which branch you are on.**

- **A merge-gated branch** — `main`, or a release branch named by version (`2026.1`,
  `2026.2`) — is only written through a gate: nothing lands until `check-pull-request.yml`
  has passed on the merge result. So a failure of that same workflow there is a failure on
  code that has already passed it, which is strong evidence of an unreliable test rather
  than a broken one.
- **A pull-request branch** carries no such guarantee — the code genuinely may be wrong. Here
  the history tells you only whether the test is intermittent *on this branch*: alternating
  results still mean a flake, but a consistent failure means nothing about whose fault it is
  and you should go back to the commit evidence.

Two things to hold on to either way:

- **A run that failed without naming a test is infrastructure, not a flake.** Count it
  separately and keep it out of the test list; a flake list padded with dead runners is one
  nobody trusts.
- **A test that fails on _every_ run in the window is not flaky — it is broken.** Intermittency
  is the whole signal. Report those separately and say they look like a real break, which on a
  gated branch means one that got past the gate — rare, and worth someone's attention.

Do this once, in as few calls as the API allows, and reuse what you gathered for the rest of
your answer.

## Output

Use these sections, in this order. Omit one whenever it has nothing that bears on **who broke
this failure** — that is the test for every line you write, not just for whole sections.

**The reader wants a name, or to be told there isn't one.** Everything else earns its place
only by supporting that. A verdict padded with the state of the build farm, a catalogue of
unrelated tests, or an account of everywhere you looked makes the reader do the filtering you
were supposed to do — and buries the one line they came for.

Leave out, unless it changes who to talk to:

- tests and runs unrelated to this failure, however interesting the pattern;
- a tour of your investigation, or of the places that turned out to be dead ends;
- observations about the CI infrastructure in general, team ownership, or process;
- restating the same conclusion in a second and third way.

If you noticed something broader worth raising, that is **one sentence at the very end**, not
a section.

### Summary

Open with exactly these four lines, in this order, so the answer can be read at a glance and
pasted into a chat without editing:

```
**Who:** @login (`a1b2c3d4`) — 70% confidence
**What happened:** one sentence, plain English, naming the test or step that fails.
**When:** first failed in run #418 (2026-07-30 11:40); last good run #417.
**Kind:** commit
```

- **Who** — the login and short SHA of the most likely commit, with its likelihood. When it is
  not a person, write `nobody — flaky test`, `nobody — infrastructure`, or
  `nobody — never verified` and say so in the same words under **Kind**.
- **What happened** — one sentence. Not the investigation, not the evidence: what is broken.
- **When** — the boundary, or plainly `no usable boundary` and which kind (see below).
- **Kind** — one of `commit`, `flaky test`, `infrastructure`, `never verified`.

The last of those is the one people forget exists: **never verified** means the test is
failing the first time it has actually run, because the green baseline skipped it or the test
is new. Nothing regressed; something started being checked. That belongs to whoever made it
start running, if that is knowable — and the failure itself is older than any run you can
see. Say so rather than reaching for the nearest commit.

Always write a login as `@login`, so it is unmistakably a person and the reader can search
for it. Never invent one: if the author cannot be resolved, write `@unknown`.

Then **at most three sentences** on the evidence behind that attribution, and nothing else.
Not a survey of the branch, not what else is failing, not how the farm is doing: the reason
this name (or this "nobody") is the right answer. The four lines above must stay scannable and
this paragraph must stay about the attribution.

### Boundary

Two lines: the last good run and the first bad one, each as `run #N` with its short SHA and
date, and the trigger event they share. Not a table of every run you listed — the boundary is
two runs, and the rest were how you found it.

If there is no usable boundary, say which of these it is rather than leaving it blank — they
lead to different next steps:

- nothing on this branch has ever passed;
- every run in the window failed;
- the green runs are a different trigger event, so they are not comparable;
- the green runs never ran this test.

### Who

Only when the verdict is a commit. A table, most likely first:

```
| Likelihood | Author | Commit | What they changed | Why it is implicated |
|---|---|---|---|---|
| 70% | @jdoe | `a1b2c3d4` | `PdfExporter.cs`, `FontCache.cs` | The failing assertion compares exporter output; this rewrote the font-embedding path. |
| 25% | @asmith | `e5f6a7b8` | `build.gradle` | Bumped the PDF library a minor version — could change rendering, but nothing points at it. |
| 5% | @bwong | `c9d0e1f2` | `README.md` | Documentation only; cannot reach the failing code. |
```

Every author and SHA comes from output you actually obtained — never invent either. If you
could not resolve an author, write `unknown` rather than guessing from the commit message.

### Flaky tests

**Only the test that failed in the run you were asked about.** One row, usually. This section
exists to show whether *this* test is intermittent — it is not a catalogue of everything the
scan happened to see, and a table of twenty unrelated tests is noise the reader has to read
past to reach the answer.

```
| Test | Failures | Last seen | Runs |
|---|---|---|---|
| `ExportToPdfTests.exportsInvoice` | 3 of 30 | 2026-07-30 | [#412](url), [#398](url) |
```

Keep the run links — "where it failed" is the half that makes it actionable.

If the scan showed a wider pattern — many different tests each failing once, which means the
whole branch is unreliable rather than any one test — say that in **one sentence** with the
counts. Do not list them. Leave the section out entirely if you did not scan.

### What would settle it

Only when you could not decide, and only about **this** failure: a re-run to confirm
intermittency, a specific artifact you could not retrieve, a commit worth reverting to test
the theory. One or two lines.

Not a recommendation about the build farm, the team, or the process. If something broader
needs saying, it is the single closing sentence described above — not a paragraph here.

Never invent a URL, a SHA, an author, a run number or a test name. Everything you state
comes from output you actually obtained.
