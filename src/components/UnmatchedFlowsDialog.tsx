import { Box, Button, Heading, Octicon, Text } from '@primer/react';
import { CheckCircleIcon, TrashIcon } from '@primer/octicons-react';
import { Modal } from './Modal';
import { useFlowGroups } from '../hooks/useFlowGroups';

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
        <Box sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}>
          <Octicon icon={CheckCircleIcon} size={24} sx={{ color: 'success.fg' }} />
          <Text as="p" sx={{ mt: 2 }}>Nothing left to clean up.</Text>
        </Box>
      ) : (
        stale.map((section) => (
          <Box key={section.name} sx={{ mb: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
              <Heading as="h3" sx={{ fontSize: 1 }}>{section.name}</Heading>
              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>· {section.ids.length}</Text>
              <Box sx={{ flex: 1 }} />
              <Button
                size="small"
                variant="invisible"
                onClick={() => forgetPlacements(section.ids)}
              >
                Remove all here
              </Button>
            </Box>
            <Box
              as="ul"
              sx={{
                listStyle: 'none',
                m: 0,
                p: 0,
                border: '1px solid',
                borderColor: 'border.muted',
                borderRadius: 2,
              }}
            >
              {section.ids.map((id) => (
                <Box
                  as="li"
                  key={id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    px: 2,
                    py: 1,
                    ':not(:last-child)': { borderBottom: '1px solid', borderColor: 'border.muted' },
                  }}
                >
                  <Text sx={{ fontSize: 1, flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                    {describeId(id)}
                  </Text>
                  <Text sx={{ fontSize: 0, color: 'fg.muted', fontFamily: 'mono' }} title={id}>
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
                </Box>
              ))}
            </Box>
          </Box>
        ))
      )}
    </Modal>
  );
}
