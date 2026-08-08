/**
 * Produce the title and description for a pull request about to be opened.
 *
 * Two paths to the same answer, and the caller cannot tell which it got:
 *
 *  - **Desktop, with the AI integration on and `claude` installed** — the commit subjects
 *    and file list go to the local CLI, which writes prose.
 *  - **Everywhere else** — a template built from the same material.
 *
 * The template is not a degraded mode to apologise for. It is required for the browser
 * build regardless, so it has to be good enough to open a pull request with; the model
 * makes it better, not possible. Every failure on the model path — no bridge, no CLI, a
 * timeout, a reply that ignored the contract — lands back on the template, because
 * nothing about writing a description should be able to stop a pull request opening.
 */

import { useCallback, useState } from 'react';
import { comparePath } from '../api/endpoints';
import { ghGet } from '../api/githubClient';
import type { Comparison } from '../api/types';
import { useConfig } from '../context/ConfigContext';
import { forkRepo } from '../storage/configStore';
import { buildComposePrompt, summariseComparison } from '../lib/composePr';
import {
  hasMaterialToDescribe,
  parseComposedPr,
  staticPrBody,
  staticPrTitle,
  type ChangeSummary,
} from '../lib/featureBranch';
import { devLog, devWarn } from '../lib/devLog';
import { newRequestId } from './useClaudeTriage';
import { claudeToolsReady, composeAvailable, composeWithClaude, probeClaudeTools } from '../storage/desktopClaude';

export interface ComposedText {
  title: string;
  body: string;
  /** How the text was produced, so the dialog can say so rather than imply authorship. */
  source: 'claude' | 'template';
  /** What the change looks like, for the dialog to show alongside the text. */
  summary: ChangeSummary | null;
  /** Set when the model was meant to write this and something stopped it. */
  note?: string;
}

export interface ComposeState {
  status: 'idle' | 'working' | 'ready';
  text: ComposedText | null;
}

/** The two ends of the change being described: the fork's commit against the upstream's. */
export interface ComposeTarget {
  branch: string;
  /** Tip of the branch in the fork — the work being offered. */
  forkSha: string;
  /** Tip of the same branch in the upstream — what it is offered against. */
  upstreamSha: string;
}

export function useComposePrText(): ComposeState & {
  compose: (target: ComposeTarget) => Promise<ComposedText>;
} {
  const { config } = useConfig();
  const [state, setState] = useState<ComposeState>({ status: 'idle', text: null });

  const compose = useCallback(
    async ({ branch, forkSha, upstreamSha }: ComposeTarget): Promise<ComposedText> => {
      setState({ status: 'working', text: null });
      const { owner, repo } = config.upstream;
      const forkOwner = config.fork.owner;
      const fallbackTitle = staticPrTitle('offer', branch, branch);

      /**
       * What this pull request actually contains: the commits the fork has and the
       * upstream's copy of the same branch does not.
       *
       * Compared **inside the fork**, base first, with the upstream's commit as a bare SHA.
       * The other way round would ask the upstream to resolve a commit that has never been
       * pushed there — which is the whole reason the pull request is being opened.
       *
       * A failure here is not fatal: an empty description on a real pull request beats no
       * pull request.
       */
      let summary: ChangeSummary | null = null;
      try {
        const { data } = await ghGet<Comparison>(
          comparePath(forkOwner, forkRepo(config), upstreamSha, forkSha),
        );
        summary = summariseComparison(data);
      } catch (e) {
        devWarn('api', 'compose: the branch comparison could not be read', e);
      }

      const finish = (text: ComposedText): ComposedText => {
        setState({ status: 'ready', text });
        return text;
      };

      const template = (note?: string): ComposedText => ({
        title: fallbackTitle,
        body: staticPrBody('offer', summary),
        source: 'template',
        summary,
        note,
      });

      /**
       * Nothing to merge, so nothing to describe — and, crucially, nothing to *ask about*.
       *
       * Checked before the model is reached rather than after, because a model given an
       * empty change set does not answer "nothing to say": it hedges from the branch name
       * at length. `staticPrBody` already returns an empty string here, so this is the
       * whole fix — leave the description empty and say why.
       */
      if (!hasMaterialToDescribe(summary)) {
        return finish(
          template(
            summary
              ? `Nothing to commit — the upstream's ${branch} already has everything on your copy of it, so the description is left empty.`
              : 'The branch comparison could not be read, so the description is left empty.',
          ),
        );
      }

      if (!config.ai.enabled || !composeAvailable()) return finish(template());
      if (!claudeToolsReady(await probeClaudeTools())) {
        return finish(template());
      }

      const prompt = buildComposePrompt({
        branch,
        // Head and base are the same branch in two repositories, so the brief says which
        // side is which rather than naming two different branches.
        baseBranch: `${owner}/${repo}'s ${branch}`,
        repoSlug: `${owner}/${repo}`,
        summary,
        extraInstructions: config.ai.extraInstructions,
        promptOverride: config.ai.pr.prompt,
      });

      const result = await composeWithClaude({
        prompt,
        requestId: newRequestId(),
        task: 'pr',
        model: config.ai.pr.model,
        effort: config.ai.pr.effort,
      });

      if (!result.ok) {
        devWarn('claude', 'compose: falling back to the template', result.error);
        return finish(template(`Claude could not write this one (${result.error}).`));
      }

      devLog('claude', `compose: ${result.reply.length} chars`);
      const parsed = parseComposedPr(result.reply, fallbackTitle);
      return finish({
        title: parsed.title,
        body: parsed.body,
        source: 'claude',
        summary,
        note: result.incompleteReason
          ? `Claude stopped early (${result.incompleteReason}), so this may be unfinished.`
          : undefined,
      });
    },
    [config],
  );

  return { ...state, compose };
}
