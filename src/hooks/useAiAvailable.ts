/**
 * Whether the AI integration is usable right now — the switch *and* the CLI.
 *
 * A lighter answer to the same question `useClaudeTriage` computes. That hook owns running
 * analyses, streaming and cancellation; a control that only needs to know whether to render
 * itself should not mount all of that, and rows do this per row.
 *
 * The probe is shared: it shells out to `claude --version`, `gh --version` and
 * `gh auth status`, which is cheap once and wasteful per component. One promise is kept for
 * the session, so ten rows asking cost one probe.
 */

import { useEffect, useState } from 'react';
import { useConfig } from '../context/ConfigContext';
import {
  claudeBridgeAvailable,
  claudeToolsReady,
  probeClaudeTools,
  NO_CLAUDE_TOOLS,
  type ClaudeToolStatus,
} from '../storage/desktopClaude';

let shared: Promise<ClaudeToolStatus> | null = null;

/** Exported for tests, which need each case to start from an unprobed session. */
export function resetAiProbe(): void {
  shared = null;
}

function probeOnce(): Promise<ClaudeToolStatus> {
  shared ??= probeClaudeTools();
  return shared;
}

export function useAiAvailable(): boolean {
  const { config } = useConfig();
  const [tools, setTools] = useState<ClaudeToolStatus>(NO_CLAUDE_TOOLS);

  useEffect(() => {
    // In a browser there is no bridge, so the answer is already `NO_CLAUDE_TOOLS`.
    if (!claudeBridgeAvailable()) return;
    let active = true;
    void probeOnce().then((status) => {
      if (active) setTools(status);
    });
    return () => {
      active = false;
    };
  }, []);

  return config.ai.enabled && claudeToolsReady(tools);
}
