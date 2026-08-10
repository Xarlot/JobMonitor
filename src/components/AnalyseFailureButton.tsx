/**
 * "Take me to this failure in the Failures tab", on a failing check or job.
 *
 * The Failures tab is where a failure can be explained, its log rewritten and its report
 * copied — but getting there meant leaving the run you were reading, finding the same job
 * in a list grouped differently, and hoping it was the one. This is that trip, in one click.
 *
 * Two conditions, and both are about not offering a dead end:
 *
 *  - **The AI integration has to be on.** Without it the Failures tab still works, but the
 *    thing this button is *for* — going somewhere to have the failure explained — is not
 *    there, and a button that moves you to a list you were already looking at is noise.
 *  - **The failure has to actually be in that tab.** Its list is bounded (a week's window,
 *    a bounded set of tracked pull requests), so a job failing outside those bounds has no
 *    row to land on. Asked of the live list rather than re-derived, so the two cannot
 *    disagree about what exists.
 */

import { IconButton } from '@primer/react';
import { SparkleFillIcon } from '@primer/octicons-react';
import { useFailures } from '../context/FailuresContext';
import { useNavigation } from '../context/NavigationContext';
import { useAiAvailable } from '../hooks/useAiAvailable';
import styles from './AnalyseFailureButton.module.css';

/**
 * Find the failure a row stands for.
 *
 * Matched on the ids GitHub guarantees unique — a check-run id, an Actions job id — rather
 * than by rebuilding the key, which is formed differently for a pull request
 * (`pr:{number}:{checkId}`) and a flow (`flow:{flowId}:{jobId}`); a caller would have to
 * know which it was and would get it wrong exactly when the two meet.
 */
export function useFailureKey(ids: {
  checkRunId?: number | null;
  jobId?: number | null;
}): string | null {
  const { failures } = useFailures();
  const { checkRunId, jobId } = ids;
  if (checkRunId == null && jobId == null) return null;
  return (
    failures.find(
      (f) =>
        (checkRunId != null && f.checkRunId === checkRunId) ||
        (jobId != null && f.jobId === jobId),
    )?.key ?? null
  );
}

export function AnalyseFailureButton({
  checkRunId,
  jobId,
  size = 'small',
}: {
  checkRunId?: number | null;
  jobId?: number | null;
  size?: 'small' | 'medium';
}) {
  const navigation = useNavigation();
  const available = useAiAvailable();
  const failureKey = useFailureKey({ checkRunId, jobId });

  if (!available || !navigation || !failureKey) return null;

  return (
    <IconButton
      size={size}
      variant="invisible"
      icon={SparkleFillIcon}
      aria-label="Analyse in Failures"
      className={styles.mr1}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        navigation.openFailure(failureKey);
      }}
    />
  );
}
