import { Button, Heading, Text } from '@primer/react';
import { CheckCircleIcon, TrashIcon } from '@primer/octicons-react';
import { Modal } from './Modal';
import { useFlowGroups } from '../hooks/useFlowGroups';
import styles from './UnmatchedFlowsDialog.module.css';

/**
 * Editor for the layout leftovers the board keeps: places held for flows that
 * aren't there anymore — a deleted flow, or a workflow its regex stopped matching
 * (e.g. after the pattern was edited). They're kept on purpose, so a card returns
 * to its spot when the workflow does; this is where you throw them away.
 *
 * Only layout entries are removed — no flow definition is touched.
 */
export function UnmatchedFlowsDialog({ onClose }: { onClose: () => void }) {
  const { sections, describeId, forgetPlacements } = useFlowGroups();

  const stale = sections
    .filter((s) => s.pinnedMissing.length > 0)
    .map((s) => ({ name: s.group?.name ?? 'Ungrouped', ids: s.pinnedMissing }));
  const total = stale.reduce((n, s) => n + s.ids.length, 0);

  return (
    <Modal
      title="Unmatched places on the board"
      subtitle="Spots kept for flows that aren’t here right now. Removing one only drops the placement — the flow itself and your regex stay as they are."
      width="min(680px, 94vw)"
      onClose={onClose}
      footer={
        <>
          {total > 0 && (
            <Button
              variant="danger"
              leadingVisual={TrashIcon}
              onClick={() => forgetPlacements(stale.flatMap((s) => s.ids))}
            >
              Remove all ({total})
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {total === 0 ? (
        <div className={styles.p4TextCenter}>
          <CheckCircleIcon size={24} className={styles.successFg} />
          <Text as="p" className={styles.mt2}>Nothing left to clean up.</Text>
        </div>
      ) : (
        stale.map((section) => (
          <div key={section.name} className={styles.mb3}>
            <div className={styles.flexCenter}>
              <Heading as="h3" className={styles.body}>{section.name}</Heading>
              <Text className={styles.smallFgMuted}>· {section.ids.length}</Text>
              <div className={styles.grow} />
              <Button
                size="small"
                variant="invisible"
                onClick={() => forgetPlacements(section.ids)}
              >
                Remove all here
              </Button>
            </div>
            <ul
              className={styles.m0P0}
            >
              {section.ids.map((id) => (
                <li
                  key={id}
                  className={styles.row}
                >
                  <Text className={styles.bodyGrow}>
                    {describeId(id)}
                  </Text>
                  <Text className={styles.smallFgMuted2} title={id}>
                    {id.length > 28 ? `…${id.slice(-28)}` : id}
                  </Text>
                  <Button
                    size="small"
                    variant="invisible"
                    leadingVisual={TrashIcon}
                    aria-label={`Remove ${describeId(id)}`}
                    onClick={() => forgetPlacements([id])}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </Modal>
  );
}
