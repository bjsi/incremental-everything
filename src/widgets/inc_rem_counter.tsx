import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React from 'react';
import { allIncrementalRemKey, currentDocumentIdKey } from '../lib/consts';

function IncRemCounter() {
  const plugin = usePlugin();

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        console.log('INC REM COUNTER WIDGET: Starting calculation');

        // Listen to URL changes via storage (makes it reactive)
        await rp.storage.getSession(currentDocumentIdKey);

        // Get widget context to determine current document
        const ctx = await plugin.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
        const documentId = ctx?.documentId;

        console.log('INC REM COUNTER WIDGET: Document ID', documentId);

        // Get all incRems from storage (this makes it reactive to incRem changes)
        const allIncRems = (await rp.storage.getSession(allIncrementalRemKey)) || [];
        console.log('INC REM COUNTER WIDGET: Got allIncRems', allIncRems.length);

        // If no document, show all incRems
        if (!documentId) {
          console.log('INC REM COUNTER WIDGET: No document found, showing all incRems');
          const now = Date.now();
          const pendingIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);
          const result = {
            pending: pendingIncRems.length,
            total: allIncRems.length,
          };
          console.log('INC REM COUNTER WIDGET: Returning result (no doc)', result);
          return result;
        }

        const now = Date.now();

        // Get all descendants of the current document
        console.log('INC REM COUNTER WIDGET: Finding document', documentId);
        const currentDoc = await rp.rem.findOne(documentId);
        if (!currentDoc) {
          console.log('INC REM COUNTER WIDGET: Document not found', documentId);
          return { pending: 0, total: 0 };
        }

        console.log('INC REM COUNTER WIDGET: Getting descendants...');
        const descendants = await currentDoc.getDescendants();
        console.log('INC REM COUNTER WIDGET: Got descendants', descendants.length);

        const descendantIds = new Set([documentId, ...descendants.map((d) => d._id)]);

        // Filter incRems that belong to this document
        const docIncRems = allIncRems.filter((incRem) => descendantIds.has(incRem.remId));
        const pendingIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);

        const result = {
          pending: pendingIncRems.length,
          total: docIncRems.length,
        };

        console.log('INC REM COUNTER WIDGET: Loaded for document', {
          documentId: documentId,
          result,
          allIncRems: allIncRems.length,
        });

        return result;
      } catch (error) {
        console.error('INC REM COUNTER WIDGET: Error', error);
        return { pending: 0, total: 0 };
      }
    },
    []
  );

  console.log('INC REM COUNTER WIDGET: Rendering', counterData);

  // Don't render if loading or no incRems
  if (!counterData) {
    console.log('INC REM COUNTER WIDGET: Still loading...');
    return null;
  }

  if (counterData.total === 0) {
    console.log('INC REM COUNTER WIDGET: Not rendering (no incRems)');
    return null;
  }

  return (
    <div
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
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--rn-clr-content-primary)' }}>
        📚 Incremental Rems:
      </span>
      <span style={{ fontWeight: 500 }}>
        {counterData.pending} pending / {counterData.total} total
      </span>
    </div>
  );
}

renderWidget(IncRemCounter);
