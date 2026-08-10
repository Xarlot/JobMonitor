/**
 * Picks workflow **file names** for the auto-rerun allow-list.
 *
 * A combobox rather than free text because the match is an exact file name: a typo
 * would silently arm nothing. The repo's workflow list is fetched once (ETag-cached
 * by the client) and filtered locally as you type, following the same
 * effect/loading/error shape as PatternPreview in SettingsPage.
 *
 * A name that isn't in the list can still be added — a workflow that has never run,
 * or one about to be added to the repo, should be configurable in advance.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Flash, IconButton, Spinner, Text, TextInput } from '@primer/react';
import { PlusIcon, SearchIcon, TrashIcon } from '@primer/octicons-react';
import { useWorkflowList } from '../hooks/useWorkflowList';
import { workflowBasename } from '../lib/workflow';
import styles from './WorkflowFilesField.module.css';

const LISTBOX_ID = 'workflow-files-listbox';

export function WorkflowFilesField({
  owner,
  repo,
  value,
  onChange,
}: {
  owner: string;
  repo: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const { workflows, loading, error } = useWorkflowList(owner, repo);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  const selected = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);

  /** Unselected workflows whose name or file matches what's typed. */
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (workflows ?? [])
      .map((w) => ({ file: workflowBasename(w.path), name: w.name }))
      .filter(
        (w) =>
          !selected.has(w.file.toLowerCase()) &&
          (q === '' || w.file.toLowerCase().includes(q) || w.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.file.localeCompare(b.file));
  }, [workflows, query, selected]);

  const typed = query.trim();
  /** Offer the typed text when it isn't already an option or already chosen. */
  const canAddTyped =
    typed !== '' &&
    !selected.has(typed.toLowerCase()) &&
    !suggestions.some((s) => s.file.toLowerCase() === typed.toLowerCase());

  const add = (file: string) => {
    const trimmed = file.trim();
    if (!trimmed || selected.has(trimmed.toLowerCase())) return;
    onChange([...value, trimmed]);
    setQuery('');
    setActiveIndex(0);
  };

  const remove = (file: string) => onChange(value.filter((v) => v !== file));

  const options = canAddTyped ? [{ file: typed, name: '' }, ...suggestions] : suggestions;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = options[activeIndex];
      if (pick) add(pick.file);
      else if (typed) add(typed);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div>
      {value.length > 0 && (
        <div
          className={styles.roundedMb2}
        >
          {value.map((file) => (
            <div
              key={file}
              className={styles.row}
            >
              <Text className={styles.monoSmall}>
                {file}
              </Text>
              <IconButton
                size="small"
                variant="invisible"
                icon={TrashIcon}
                aria-label={`Remove ${file}`}
                onClick={() => remove(file)}
              />
            </div>
          ))}
        </div>
      )}

      <div className={styles.relative}>
        <TextInput
          block
          value={query}
          leadingVisual={SearchIcon}
          placeholder={value.length === 0 ? 'ci.yml — type to search workflows' : 'add another…'}
          aria-label="Workflow file to auto-rerun"
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setOpen(true)}
          // Deferred so a click on an option lands before the list unmounts.
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={onKeyDown}
          trailingAction={
            canAddTyped ? (
              <TextInput.Action
                onClick={() => add(typed)}
                icon={PlusIcon}
                aria-label={`Add ${typed}`}
              />
            ) : undefined
          }
        />

        {open && options.length > 0 && (
          <ul
            id={LISTBOX_ID}
            role="listbox"
            className={styles.m0P0}
          >
            {options.map((option, index) => (
              <li
                key={option.file}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? styles.optionActive : styles.option}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
                onClick={() => add(option.file)}
              >
                <Text className={styles.monoSmall2}>
                  {option.file}
                </Text>
                <Text className={styles.smallFgMuted}>
                  {option.name || 'add as typed'}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.flexCenter}>
        {loading && <Spinner size="small" />}
        {!owner || !repo ? (
          <Text className={styles.smallFgMuted}>
            Set the upstream repo to list its workflows.
          </Text>
        ) : (
          workflows && (
            <Text className={styles.smallFgMuted}>
              {workflows.length} workflows in {owner}/{repo}
            </Text>
          )
        )}
      </div>

      {error && (
        <Flash variant="warning" className={styles.mt2Small}>
          Couldn’t list workflows: {error}. You can still type file names by hand.
        </Flash>
      )}
    </div>
  );
}
