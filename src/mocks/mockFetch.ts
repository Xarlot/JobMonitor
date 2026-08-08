/**
 * A `fetch` stand-in for mock mode. Routes api.github.com paths to fixtures,
 * emits realistic ETag + rate-limit headers, and returns 304 when If-None-Match
 * matches the (content-derived) ETag — exercising the same code paths as the
 * real client without network or rate-limit cost.
 */

import { strToU8, zipSync } from 'fflate';
import { fnv1aHex } from '../lib/hash';
import {
  MOCK_FEATURE_PULLS,
  MOCK_MERGED_PULLS,
  MOCK_PULLS,
  flowHasRuns,
  mockComparison,
  mockMatchingRefs,
  mockAnnotations,
  mockArtifacts,
  mockCheckRuns,
  mockCombinedStatus,
  mockJobLog,
  mockJobs,
  mockRepoRuns,
  mockRepository,
  mockRunsForSha,
  mockSingleJob,
  mockSingleRun,
  mockWorkflowRuns,
  mockWorkflows,
  recordMockRerun,
} from './fixtures';

let callCount = 0;

function rateLimitHeaders(): Record<string, string> {
  callCount += 1;
  const remaining = Math.max(0, 5000 - callCount);
  return {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-used': String(callCount),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    // Pose as a classic PAT with `repo` so the write-gated features (re-run failed
    // jobs) are reachable offline. GitHub sends this on every status, including
    // the 304 branch below — hence putting it here rather than at each route.
    'x-oauth-scopes': 'repo, workflow',
  };
}

function json(body: unknown, ifNoneMatch: string | null): Response {
  const text = JSON.stringify(body);
  const etag = `W/"${fnv1aHex(text)}"`;
  const headers = { ...rateLimitHeaders(), etag, 'content-type': 'application/json' };
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: 200, headers });
}

export async function mockFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const path = url.pathname;
  const inm = new Headers(init?.headers).get('if-none-match');

  // Simulate a little latency so the UI's loading states are observable.
  await new Promise((r) => setTimeout(r, 120));

  // Writes come first: this is the only route that cares about the method, and it
  // must not be shadowed by a GET route further down.
  const rerunMatch = path.match(/\/actions\/runs\/(\d+)\/rerun-failed-jobs$/);
  if (rerunMatch) {
    if ((init?.method ?? 'GET').toUpperCase() !== 'POST') {
      return new Response(JSON.stringify({ message: 'Method Not Allowed (mock)' }), {
        status: 405,
        headers: { ...rateLimitHeaders(), 'content-type': 'application/json' },
      });
    }
    recordMockRerun(Number(rerunMatch[1]));
    // GitHub answers 201 with an empty body — deliberately not via json(), which
    // always returns a body and a 200.
    return new Response(null, { status: 201, headers: rateLimitHeaders() });
  }

  // The feature-branch writes. Like the re-run above, these are method-sensitive and must
  // not be shadowed by the GET routes further down. None of them mutate the fixtures:
  // mock mode exists to exercise the UI's paths, and a mock that "merged" a pull request
  // would then have to model everything that follows from it.
  if (/\/merge-upstream$/.test(path)) {
    return json({ message: 'Successfully fetched and fast-forwarded', merge_type: 'fast-forward' }, null);
  }
  if (path === '/graphql') {
    // enablePullRequestAutoMerge is the app's only GraphQL call. A refusal here would be
    // HTTP 200 with an `errors` array — worth remembering, but success is what the tab
    // needs to be walkable offline.
    return json(
      {
        data: {
          enablePullRequestAutoMerge: {
            pullRequest: { number: 38100, autoMergeRequest: { enabledAt: new Date().toISOString(), mergeMethod: 'SQUASH' } },
          },
        },
      },
      null,
    );
  }

  const refsMatch = path.match(/^\/repos\/[^/]+\/([^/]+)\/git\/matching-refs\/heads\/(.+)$/);
  if (refsMatch) return json(mockMatchingRefs(refsMatch[1], refsMatch[2]), inm);

  if (/\/compare\//.test(path)) return json(mockComparison(), inm);

  const jobLogsMatch = path.match(/\/actions\/jobs\/(\d+)\/logs$/);
  if (jobLogsMatch) {
    return new Response(mockJobLog(Number(jobLogsMatch[1])), {
      status: 200,
      headers: { ...rateLimitHeaders(), 'content-type': 'text/plain' },
    });
  }

  const singleJobMatch = path.match(/\/actions\/jobs\/(\d+)$/);
  if (singleJobMatch) return json(mockSingleJob(Number(singleJobMatch[1])), inm);

  const jobsMatch = path.match(/\/actions\/runs\/(\d+)\/jobs$/);
  if (jobsMatch) return json(mockJobs(Number(jobsMatch[1])), inm);

  // A single run — read for its workflow file and attempt when building a failure
  // report. Must come after the /runs/{id}/… routes above.
  const singleRunMatch = path.match(/\/actions\/runs\/(\d+)$/);
  if (singleRunMatch) return json(mockSingleRun(Number(singleRunMatch[1])), inm);

  const artifactsMatch = path.match(/\/actions\/runs\/(\d+)\/artifacts$/);
  if (artifactsMatch) return json(mockArtifacts(Number(artifactsMatch[1])), inm);

  // Artifact zip download: serve a small but real zip so the download +
  // unpack/repack bundle path is exercised end-to-end.
  const artifactZipMatch = path.match(/\/actions\/artifacts\/(\d+)\/zip$/);
  if (artifactZipMatch) {
    const id = artifactZipMatch[1];
    const zip = zipSync({
      'report.txt': strToU8(`Mock artifact ${id}\nGenerated by Job Monitor mock mode.\n`),
      'meta/info.json': strToU8(JSON.stringify({ artifactId: Number(id) }, null, 2)),
    });
    return new Response(zip, {
      status: 200,
      headers: { ...rateLimitHeaders(), 'content-type': 'application/zip' },
    });
  }

  const annotationsMatch = path.match(/\/check-runs\/(\d+)\/annotations$/);
  if (annotationsMatch) return json(mockAnnotations(Number(annotationsMatch[1])), inm);

  const runsMatch = path.match(/\/actions\/workflows\/([^/]+)\/runs$/);
  if (runsMatch) {
    // Each known workflow has its own run history; unknown ones stay empty
    // (demonstrates the empty-flow filter).
    const wf = decodeURIComponent(runsMatch[1]);
    return json(flowHasRuns(wf) ? mockWorkflowRuns(wf) : { total_count: 0, workflow_runs: [] }, inm);
  }

  // Repo-wide runs (browse picker) — matched before the workflows list, distinct
  // from the per-workflow `/actions/workflows/{file}/runs` route above. Honors the
  // `created` window and paginates (page > 1 is past our small fixture set).
  if (/\/actions\/runs$/.test(path)) {
    // head_sha narrows to one commit — how a PR is mapped to its workflow runs.
    const headSha = url.searchParams.get('head_sha');
    if (headSha) return json(mockRunsForSha(headSha), inm);
    const page = Number(url.searchParams.get('page') ?? '1');
    if (page > 1) return json({ total_count: 0, workflow_runs: [] }, inm);
    return json(mockRepoRuns(url.searchParams.get('created')), inm);
  }

  // The workflow list paginates (the real one caps at 100 per page); the whole
  // fixture set fits on page 1, so anything beyond it is empty.
  if (/\/actions\/workflows$/.test(path)) {
    const page = Number(url.searchParams.get('page') ?? '1');
    if (page > 1) return json({ total_count: 0, workflows: [] }, inm);
    return json(mockWorkflows(), inm);
  }

  const checkMatch = path.match(/\/commits\/([^/]+)\/check-runs$/);
  if (checkMatch) return json(mockCheckRuns(checkMatch[1]), inm);

  const statusMatch = path.match(/\/commits\/([^/]+)\/status$/);
  if (statusMatch) return json(mockCombinedStatus(statusMatch[1]), inm);

  if (/\/pulls$/.test(path)) {
    // POST — opening one. Answered with the fixture rather than a new object, so the
    // dialog's success path has a real pull request to report on.
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      return json(MOCK_FEATURE_PULLS[0], null);
    }
    // state=closed feeds the merged-PR list (which then filters on merged_at).
    if (url.searchParams.get('state') === 'closed') return json(MOCK_MERGED_PULLS, inm);

    // The feature-branch tab narrows by head and base; the dashboard does not. Filtering
    // here rather than returning everything is what keeps the two apart — the tab must not
    // adopt an unrelated pull request as its own.
    const head = url.searchParams.get('head');
    const base = url.searchParams.get('base');
    if (head || base) {
      // `head` arrives as `owner:branch`; both halves matter, because the feature-branch tab
      // asks for the same branch name on both sides of a cross-fork pull request and the
      // owner is the only thing distinguishing the two queries.
      const [headOwner, ...rest] = (head ?? '').split(':');
      const headRef = rest.join(':') || null;
      return json(
        [...MOCK_PULLS, ...MOCK_FEATURE_PULLS].filter(
          (pr) =>
            (!headRef || pr.head.ref === headRef) &&
            (!head || (pr.head.user?.login ?? '').toLowerCase() === headOwner.toLowerCase()) &&
            (!base || pr.base.ref === base),
        ),
        inm,
      );
    }
    /**
     * Unfiltered: everything open in the repository, which is what GitHub answers and what
     * the dashboard asks for. The feature-branch offers belong here too — their head is in
     * the fork, so `matchesFork` keeps them and they appear in the Pull requests tab. Leaving
     * them out made the tab look narrower than it is and hid the jump between the two.
     */
    return json([...MOCK_PULLS, ...MOCK_FEATURE_PULLS], inm);
  }

  // One pull request — the only source of mergeable/mergeable_state, which is what the
  // feature-branch tab reads to say why a merge is stuck. Must sit above the list route's
  // sibling patterns and below /pulls/{n}/merge.
  const singlePullMatch = path.match(/\/pulls\/(\d+)$/);
  if (singlePullMatch) {
    const number = Number(singlePullMatch[1]);
    const found = [...MOCK_PULLS, ...MOCK_FEATURE_PULLS, ...MOCK_MERGED_PULLS].find(
      (pr) => pr.number === number,
    );
    if (found) return json({ ...found, mergeable: found.mergeable ?? true }, inm);
  }

  // The repository itself — read for `permissions.push` (the Write-role half of
  // the token-capability check). Anchored to exactly two path segments, so it
  // can't shadow any of the /repos/{o}/{r}/… routes above.
  const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repoMatch) return json(mockRepository(repoMatch[1], repoMatch[2]), inm);

  return new Response(JSON.stringify({ message: 'Not Found (mock)' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
