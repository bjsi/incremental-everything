import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React from 'react';
import { allIncrementalRemKey, currentDocumentIdKey, popupDocumentIdKey } from '../lib/consts';
import { collectPdfSourcesFromRems, findPdfExtractIds } from '../lib/scope_helpers';
import '../style.css';
import '../App.css';

// Inject CSS for hover effects
const style = document.createElement('style');
style.textContent = `
  .inc-rem-view-all-button:hover {
    background-color: var(--rn-clr-background-primary) !important;
  }
`;
document.head.appendChild(style);

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

        // Collect PDF sources from document and descendants, then find their extracts
        const { pdfSourceIds } = await collectPdfSourcesFromRems([currentDoc, ...descendants]);
        const pdfExtractIds = await findPdfExtractIds(rp, pdfSourceIds);

        // Add PDF extract IDs to the set
        pdfExtractIds.forEach(id => descendantIds.add(id));

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

  const handleMainViewClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await plugin.widget.openPopup('inc_rem_main_view');
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '8px 16px',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        fontSize: '14px',
        color: 'var(--rn-clr-content-secondary)',
      }}
    >
      <div
        onClick={handleClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
          flex: 1,
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--rn-clr-content-primary)' }}>
          📚 Incremental Rems:
        </span>
        <span style={{ fontWeight: 500 }}>
          {counterData.due} due / {counterData.total} total
        </span>
      </div>
      <button
        onClick={handleMainViewClick}
        className="inc-rem-view-all-button"
        style={{
          padding: '4px 12px',
          fontSize: '13px',
          fontWeight: 500,
          borderRadius: '4px',
          backgroundColor: 'var(--rn-clr-background-tertiary)',
          color: 'var(--rn-clr-content-primary)',
          border: '1px solid var(--rn-clr-border-primary)',
          cursor: 'pointer',
          transition: 'all 0.2s',
        }}
        title="Open main view with filters (Opt+Shift+I)"
      >
        📊 View All
      </button>
    </div>
  );
}

renderWidget(IncRemCounter);
