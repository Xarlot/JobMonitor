---
name: failure-triage
description: Work out why one specific CI job failed, using its logs, artifacts and diff. Use when triaging a failed GitHub Actions job and you need the actual cause rather than a summary of what the workflow reported.
---

# Triaging one failed job

You are finding the cause of **one specific failure** so a developer can act on it without
opening the logs themselves.

## Stay on the failure you were given

Answer for the job named in the request. Do not survey the pull request, do not audit the
workflow, and do not report every problem you notice on the way — a triage that comes back
with five findings makes the reader do the sorting you were supposed to do.

If you notice something else genuinely broken, mention it in one clause at the end. Do not
investigate it.

## Look at a neighbouring job only when this one cannot answer

Sometimes the job you were given is not where the failure is. The clearest case is an
**aggregator**: a job like `publish-test-summary` that exits non-zero only because a job it
`needs:` failed. Its own log and annotations say nothing but "a dependent job failed", and
no amount of reading them will produce a cause.

Go upstream **only** when the evidence in front of you cannot name a cause:

- the failing step is a summary, gate or aggregation step, or
- the log says a dependency failed, or
- the log ends without an error of its own.

Then find the job that actually failed — `gh run view <run-id>` lists them — and triage
that one. Say in your answer which job you ended up in and why, because the reader clicked
on a different one.

Anything else in the run is out of scope. Two unrelated failing jobs are two triages, not
one.

## Budget: enough evidence, not all of it

Aim to answer in **two to four tool calls**. Stop as soon as you can name the failing test
or step and quote the line that proves it — more evidence after that point costs time and
changes nothing.

Cheapest first, and stop when you have an answer:

1. **The failed step's log.** Grep for the runner's own failure lines — `FAILED`,
   `AssertionError`, `Error:`, `Caused by`, `Failed `, a stack trace — not the workflow's
   summary text. Logs are large; grep them rather than reading end to end.
2. **The test report, if the run uploaded one.** JUnit XML or TRX names the failing tests
   and shows assertion diffs directly, and is far more precise than console output. Worth a
   download when the log's own failure lines are unclear — not otherwise.
3. **The workflow file**, when you need the exact command that ran, or how a matrix or
   shard entry picks its subset. This is what makes a reproduce command real.
4. **The diff**, when you need to tell "a test this PR touched" from an unrelated
   regression. That distinction belongs in the answer; the rest of the diff does not.

Skipping a step you did not need is correct. Reading everything before answering is not
thoroughness — it is a slower answer of the same quality.

## Retry a download before giving up on it

`gh run download` and `gh api` fail transiently: rate limits, blob-storage timeouts, and
HTTP/2 stream errors (`stream error: ... CANCEL; received from peer`) are all common and
none of them mean the artifact is missing.

On failure, **retry once**. If it fails again:

- try `GODEBUG=http2client=0 gh ...`, which drops the transfer to HTTP/1.1 and is the
  documented way around the stream error;
- or fall back to a cheaper source — the log you already have, or `gh api` for the
  artifact list instead of the whole zip.

Two failed attempts is enough. Say in your answer that the artifacts were unavailable and
what you concluded without them, rather than retrying a third time or presenting a guess as
if it were evidence.

## What the answer must contain

- **The cause, named.** The failing test or step, and the decisive line quoted verbatim in
  backticks — the assertion, the exception, the diff.
- **Whether it is the code or the infrastructure.** A dead runner, a registry timeout, disk
  exhaustion or a rate limit changes who should pick this up, so say which it looks like.
- **Where you looked**, if you had to go to another job — name it.
- **One recommendation**, not a list of possibilities. Where the evidence genuinely does not
  determine the cause, say what to check next and which output would settle it.

Never invent a URL, an issue number, a commit SHA, a file path, a test name or a line
number. Everything you state comes from the input you were given or from output you
actually obtained.
