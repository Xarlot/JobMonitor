import { useMemo, useState } from 'react';
import { Box, Button, Flash, Heading, Text, Textarea } from '@primer/react';
import { Modal } from './Modal';
import { useFlowGroups } from '../hooks/useFlowGroups';
import { safeParseBoard } from '../storage/configStore';

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
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

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
      <Heading as="h3" sx={{ fontSize: 1, color: 'fg.muted', mb: 2 }}>
        Export
      </Heading>
      <Textarea
        value={json}
        readOnly
        rows={10}
        sx={{ width: '100%', fontFamily: 'mono', fontSize: 0 }}
      />
      <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
        <Button onClick={onCopy}>{copied ? 'Copied ✓' : 'Copy'}</Button>
        <Button onClick={onDownload}>Download .json</Button>
      </Box>

      <Heading as="h3" sx={{ fontSize: 1, color: 'fg.muted', mt: 4, mb: 1 }}>
        Import
      </Heading>
      <Text as="p" sx={{ fontSize: 0, color: 'fg.muted', mb: 2 }}>
        Replaces <strong>all</strong> current flows and groups with the pasted board.
      </Text>
      {errors.length > 0 && (
        <Flash variant="danger" sx={{ mb: 2 }}>
          <Box as="ul" sx={{ m: 0, pl: 3 }}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </Box>
        </Flash>
      )}
      {done && (
        <Flash variant="success" sx={{ mb: 2 }}>
          {done}
        </Flash>
      )}
      <Textarea
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
        rows={8}
        placeholder='{ "version": 1, "flows": [ … ], "groups": [ … ] }'
        sx={{ width: '100%', fontFamily: 'mono', fontSize: 0 }}
      />
      <Button variant="primary" sx={{ mt: 2 }} onClick={onImport} disabled={!importText.trim()}>
        Import &amp; replace
      </Button>
    </Modal>
  );
}
