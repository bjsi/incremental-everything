import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React from 'react';
import { allIncrementalRemKey, currentDocumentIdKey, popupDocumentIdKey } from '../lib/consts';

function IncRemCounter() {
  const plugin = usePlugin();

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        // Trigger reactivity when URL changes (documentId is updated in events.ts)
        await rp.storage.getSession(currentDocumentIdKey);

        // Get widget context to determine current document
        const ctx = await rp.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
        const documentId = ctx?.documentId;

        // Get all incRems from storage (this makes it reactive to incRem changes)
        const allIncRems = (await rp.storage.getSession(allIncrementalRemKey)) || [];

        // If no document, show all incRems
        if (!documentId) {
          const now = Date.now();
          const dueIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);
          return {
            due: dueIncRems.length,
            total: allIncRems.length,
          };
        }

        const now = Date.now();

        // Get all descendants of the current document
        const currentDoc = await rp.rem.findOne(documentId);
        if (!currentDoc) {
          return { due: 0, total: 0 };
        }

        const descendants = await currentDoc.getDescendants();
        const descendantIds = new Set([documentId, ...descendants.map((d) => d._id)]);

        // Filter incRems that belong to this document
        const docIncRems = allIncRems.filter((incRem) => descendantIds.has(incRem.remId));
        const dueIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);

        return {
          due: dueIncRems.length,
          total: docIncRems.length,
        };
      } catch (error) {
        console.error('INC REM COUNTER WIDGET: Error', error);
        return { due: 0, total: 0 };
      }
    },
    []
  );

  // Don't render if loading or no incRems
  if (!counterData) {
    return null;
  }

  if (counterData.total === 0) {
    return null;
  }

  const handleClick = async () => {
    const ctx = await plugin.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
    const documentId = ctx?.documentId;

    // Store the documentId in session storage so the popup can read it
    await plugin.storage.setSession(popupDocumentIdKey, documentId || null);

    await plugin.widget.openPopup('inc_rem_list');
  };

  return (
    <div
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '8px 16px',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        fontSize: '14px',
        color: 'var(--rn-clr-content-secondary)',
        cursor: 'pointer',
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--rn-clr-content-primary)' }}>
        📚 Incremental Rems:
      </span>
      <span style={{ fontWeight: 500 }}>
        {counterData.due} due / {counterData.total} total
      </span>
    </div>
  );
}

renderWidget(IncRemCounter);
