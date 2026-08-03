/**
 * Copy text to the clipboard with a brief confirmation.
 *
 * Feature-detects the API (it is unavailable on insecure origins and can be
 * blocked by permissions policy) and reports that as `failed` rather than
 * pretending to have copied, so callers can offer a manual fallback.
 */

import { useEffect, useState } from 'react';

export interface CopyState {
  copied: boolean;
  failed: boolean;
  copy: (text: string) => void;
  /**
   * Copy as rich text, with a plain-text alternative.
   *
   * Needed for targets that don't interpret Markdown from the clipboard — Teams
   * applies its Markdown-like shortcuts as you *type* and pastes a `.md` file as
   * literal `**` and `####`. Writing `text/html` alongside `text/plain` gives it the
   * rich text it does accept, and anything that only wants plain text still gets it.
   */
  copyRich: (html: string, text: string) => void;
}

export function useCopy(resetAfterMs = 2000): CopyState {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied && !failed) return;
    const id = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, resetAfterMs);
    return () => clearTimeout(id);
  }, [copied, failed, resetAfterMs]);

  const copy = (text: string) => {
    if (!navigator.clipboard?.writeText) {
      setFailed(true);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setFailed(true),
    );
  };

  const copyRich = (html: string, text: string) => {
    // `write` + ClipboardItem is the only way to offer several flavours. It is newer
    // than writeText and is missing in some contexts, so fall back to plain text
    // rather than failing outright.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard?.write || typeof ClipboardItem === 'undefined') {
      copy(text);
      return;
    }
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      clipboard.write([item]).then(
        () => setCopied(true),
        () => copy(text),
      );
    } catch {
      copy(text);
    }
  };

  return { copied, failed, copy, copyRich };
}
