import { useState } from 'react';
import { Button, FormControl, TextInput } from '@primer/react';
import { Modal } from './Modal';

/**
 * A small text-input dialog — a replacement for `window.prompt`, which Electron
 * doesn't implement (it silently returns null). Works in the browser too.
 */
export function PromptDialog({
  title,
  label,
  initialValue = '',
  submitLabel = 'OK',
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initialValue?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();

  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      width="min(440px, 94vw)"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!trimmed} onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <FormControl>
        <FormControl.Label>{label}</FormControl.Label>
        <TextInput
          block
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </FormControl>
    </Modal>
  );
}
