import React from 'react';
import { IE_DOCS_BASE_URL } from '../lib/settings';

/**
 * Opens a docs section. `window.open` is blocked in some embedded contexts, so
 * fall back to a synthesised anchor click — same helper shape as the IE
 * Settings popup.
 */
export const openDocs = (path: string) => {
  const url = `${IE_DOCS_BASE_URL}${path}`;
  const opened = window.open(url, '_blank');
  if (!opened || opened.closed) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => document.body.removeChild(link), 100);
  }
};

interface DocsHelpButtonProps {
  /** Page (and anchor) on the docs site, relative to IE_DOCS_BASE_URL. */
  path: string;
  /** What the link documents, for the tooltip: "Open the documentation: <label>". */
  label: string;
}

/**
 * The small round "?" that opens the manual at the section for the thing it
 * sits beside. Mouse-only on purpose (`tabIndex={-1}`): the popups it lives in
 * run their own Tab cycle, and a help link must not become a stop in it.
 */
export function DocsHelpButton({ path, label }: DocsHelpButtonProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => openDocs(path)}
      title={`Open the documentation: ${label}`}
      aria-label={`Open the documentation: ${label}`}
      style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
        background: 'transparent',
        color: 'var(--rn-clr-content-secondary, #64748b)',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: '16px',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
      }}
    >
      ?
    </button>
  );
}
