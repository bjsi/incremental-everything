import { RNPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { findSourcesFromDialog } from '../lib/find_sources';
import { MessageDialog } from '../lib/message_dialog';

const ring: React.CSSProperties = {
  outline: '2px solid var(--rn-clr-border-accent, #3B82F6)',
  outlineOffset: '2px',
};

/**
 * Queue Find Sources for a dialog's `findSources` Rems, awaited before the popup closes
 * (a popup's teardown cuts a read-then-write short).
 */
export async function runDialogFindSources(plugin: RNPlugin, dialog: MessageDialog | null, close: () => void) {
  try {
    if (dialog?.findSources) {
      await findSourcesFromDialog(plugin, dialog.findSources.remIds, dialog.findSources.openSourceRemId);
    }
  } catch (e) {
    console.error('[FindSources] could not queue the search', e);
    await plugin.app.toast(`Could not start the search by meaning: ${(e as Error).message}`);
  } finally {
    close();
  }
}

/**
 * "🔎 Search by meaning" in a "Passage not found" dialog (MessageDialog.findSources):
 * shared by the message popup and the popups that report a failure inline.
 */
export function FindSourcesButton({
  onClick,
  onHover,
  selected,
}: {
  onClick: () => void;
  onHover: () => void;
  selected: boolean;
}) {
  return (
    <button
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      data-tip="Find the passages that say the same thing in other words or another language (in the background)"
      className="py-1.5 px-4 text-sm font-medium rounded"
      style={{
        background: 'var(--rn-clr-background-secondary)',
        color: 'var(--rn-clr-content-primary)',
        border: 'none',
        cursor: 'pointer',
        ...(selected ? ring : { outline: 'none' }),
      }}
    >
      🔎 Search by meaning
    </button>
  );
}
