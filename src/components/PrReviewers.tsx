/**
 * The reviewers of one pull request, as a row of avatars each carrying its verdict.
 *
 * Sits in the PR row's meta line rather than behind the expander: whether a PR is waiting on
 * a person or on CI is the first thing you want to know about it, and it fits in a glance.
 */

import { Avatar, Link, Tooltip } from '@primer/react';
import {
  CheckIcon,
  CommentIcon,
  DotFillIcon,
  FileDiffIcon,
  PeopleIcon,
  SkipIcon,
} from '@primer/octicons-react';
import type { ComponentType } from 'react';
import type { PullRequest, PullReview } from '../api/types';
import {
  REVIEWER_STATE_LABEL,
  summarizeReviewers,
  type ReviewerState,
} from '../lib/reviewers';
import styles from './PrReviewers.module.css';

const STATE_ICON: Record<ReviewerState, ComponentType<{ size?: number; className?: string }>> = {
  changes_requested: FileDiffIcon,
  requested: DotFillIcon,
  approved: CheckIcon,
  commented: CommentIcon,
  dismissed: SkipIcon,
};

export function PrReviewers({
  pr,
  reviews,
  className,
}: {
  pr: PullRequest;
  reviews: readonly PullReview[] | undefined;
  className?: string;
}) {
  const reviewers = summarizeReviewers(pr, reviews);
  if (reviewers.length === 0) return null;

  return (
    <span className={className ? `${styles.row} ${className}` : styles.row} aria-label="Reviewers">
      {reviewers.map((r) => {
        const StateIcon = STATE_ICON[r.state];
        const text = `${r.name}: ${REVIEWER_STATE_LABEL[r.state]}`;
        return (
          <Tooltip key={r.key} text={text} direction="n">
            <Link
              href={r.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.reviewer}
              aria-label={text}
              data-state={r.state}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {r.avatarUrl ? (
                <Avatar src={r.avatarUrl} size={20} alt="" />
              ) : (
                <span className={styles.team}>
                  <PeopleIcon size={14} />
                </span>
              )}
              <span className={styles.badge}>
                <StateIcon size={10} className={styles.badgeIcon} />
              </span>
            </Link>
          </Tooltip>
        );
      })}
    </span>
  );
}
