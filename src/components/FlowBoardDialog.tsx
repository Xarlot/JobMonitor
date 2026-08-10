import { useMemo, useState } from 'react';
import { Button, Flash, Heading, Text, Textarea } from '@primer/react';
import { useCopy } from '../hooks/useCopy';
import { Modal } from './Modal';
import { useFlowGroups } from '../hooks/useFlowGroups';
import { safeParseBoard } from '../storage/configStore';
import styles from './FlowBoardDialog.module.css';
import { Feature, Telemetry } from '../lib/telemetry';

/**
 * Export / import the flows + grouping "board" as JSON. Self-contained and keyed
 * by flow id, so it moves between machines unambiguously. The GitHub token and
 * repository coordinates are intentionally NOT part of it (per-machine, secret).
 */
export function FlowBoardDialog({ onClose }: { onClose: () => void }) {
  const { exportBoard, applyBoard } = useFlowGroups();
  const json = useMemo(() => JSON.stringify(exportBoard(), null, 2), [exportBoard]);
  const [importText, setImportText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const { copied, copy } = useCopy(1500);

  const onCopy = () => copy(json);

  const onDownload = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'job-monitor-flows.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImport = () => {
    setErrors([]);
    setDone(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch (e) {
      setErrors([`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`]);
      return;
    }
    const res = safeParseBoard(parsed);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    // Counted here rather than on the click: everything above rejects the input, and an import
    // that failed validation is not an import — it is someone finding out their file is wrong.
    Telemetry.featureUsed(Feature.FLOW_BOARD_IMPORTED);
    applyBoard(res.board);
    setDone(`Imported ${res.board.flows.length} flows and ${res.board.groups.length} groups.`);
    setImportText('');
  };

  return (
    <Modal
      title="Flows: export / import"
      subtitle="Flows + groups, keyed by id — moves between machines. The token and repository coordinates are not included."
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Heading as="h3" className={styles.bodyFgMuted}>
        Export
      </Heading>
      <Textarea
        value={json}
        readOnly
        rows={10}
        className={styles.monoSmall}
      />
      <div className={styles.flexGap2}>
        <Button onClick={onCopy}>{copied ? 'Copied ✓' : 'Copy'}</Button>
        <Button onClick={onDownload}>Download .json</Button>
      </div>

      <Heading as="h3" className={styles.bodyFgMuted2}>
        Import
      </Heading>
      <Text as="p" className={styles.smallFgMuted}>
        Replaces <strong>all</strong> current flows and groups with the pasted board.
      </Text>
      {errors.length > 0 && (
        <Flash variant="danger" className={styles.mb2}>
          <ul className={styles.m0Pl3}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Flash>
      )}
      {done && (
        <Flash variant="success" className={styles.mb2}>
          {done}
        </Flash>
      )}
      <Textarea
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
        rows={8}
        placeholder='{ "version": 1, "flows": [ … ], "groups": [ … ] }'
        className={styles.monoSmall}
      />
      <Button variant="primary" className={styles.mt2} onClick={onImport} disabled={!importText.trim()}>
        Import &amp; replace
      </Button>
    </Modal>
  );
}
