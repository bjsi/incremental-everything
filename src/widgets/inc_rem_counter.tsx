import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useState } from 'react';
import { allIncrementalRemSlimKey, currentDocumentIdKey, popupDocumentIdKey, powerupCode } from '../lib/consts';
import type { SlimIncRem } from '../lib/incremental_rem/cache';
import { buildDocumentScope } from '../lib/scope_helpers';
import { generateAndStoreGraphData } from '../lib/priority_graph_data';
import { PriorityDistributionGraphComponent } from './priority_distribution_graph';
import { LocalVideoEditorPlayer } from '../components/LocalVideoEditorPlayer';
import { ReadPointCrumbs, ReadPointIcon } from '../components';
import { getReadPointPath, hasRemReadPoint } from '../lib/remReadPoint';
import { openAndFocusRem } from '../lib/remHelpers';
import '../style.css';
import '../App.css';

function IncRemCounter() {
  const plugin = usePlugin();
  const [isGenerating, setIsGenerating] = useState(false);
  const [showGraph, setShowGraph] = useState(false);

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        await rp.storage.getSession(currentDocumentIdKey);

        const ctx = await rp.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
        const documentId = ctx?.documentId;

        // Slim projection: counting needs only remId + nextRepDate, and this
        // re-runs on every IncRem cache write (the full key is ~8MB).
        const allIncRems = (await rp.storage.getSession<SlimIncRem[]>(allIncrementalRemSlimKey)) || [];

        if (!documentId) {
          const now = Date.now();
          const dueIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);
          return {
            due: dueIncRems.length,
            total: allIncRems.length,
            documentId: null,
          };
        }

        const now = Date.now();

        const documentScope = await buildDocumentScope(rp as any, documentId);

        const docIncRems = allIncRems.filter((incRem) => documentScope.has(incRem.remId));
        const dueIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);

        return {
          due: dueIncRems.length,
          total: docIncRems.length,
          documentId,
        };
      } catch (error) {
        console.error('INC REM COUNTER WIDGET: Error', error);
        return { due: 0, total: 0, documentId: null };
      }
    },
    []
  );



  // Read point of the document itself, when the document is an outline IncRem
  // with one set. The Priority Editor shows it beside the Rem in its parent,
  // but RemNote mounts no RightSideOfEditor widget on a zoomed-in title, so
  // this row is the only indication once the IncRem is opened as a page.
  //
  // Its own tracker: the counter above re-runs on every IncRem cache write,
  // while this only needs to follow the document and its read-point storage.
  // The cheap existence probe gates the full path resolve (an ancestor walk
  // plus a rem read per segment), so a document without one costs a findOne,
  // a hasPowerup and one property read.
  const readPoint = useTrackerPlugin(
    async (rp) => {
      try {
        await rp.storage.getSession(currentDocumentIdKey);
        const ctx = await rp.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
        const documentId = ctx?.documentId;
        if (!documentId) return null;
        const doc = await rp.rem.findOne(documentId);
        if (!doc || !(await doc.hasPowerup(powerupCode))) return null;
        if (!(await hasRemReadPoint(doc))) return null;
        const path = await getReadPointPath(rp as any, documentId);
        return path ? { ...path, incRemId: documentId } : null;
      } catch (error) {
        console.error('INC REM COUNTER WIDGET: read point', error);
        return null;
      }
    },
    []
  );

  // The local video player sits below the counter on every document, rendered
  // whether or not the counter shows: this is the one widget mounted under
  // every document's title (see components/LocalVideoEditorPlayer).
  const showCounter = !!counterData && counterData.total > 0;

  const handleClick = async () => {
    const ctx = await plugin.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
    const documentId = ctx?.documentId;

    await plugin.storage.setSession(popupDocumentIdKey, documentId || null);
    await plugin.widget.openPopup('inc_rem_list');
  };

  const handleMainViewClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await plugin.widget.openPopup('inc_rem_main_view');
  };

  const handleGraphClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!counterData?.documentId || isGenerating) return;

    // Toggle visibility
    if (showGraph) {
      setShowGraph(false);
      return;
    }

    // If opening, generate data
    setIsGenerating(true);
    setShowGraph(true);
    try {
      await generateAndStoreGraphData(plugin, counterData.documentId);
    } catch (err) {
      console.error('[PriorityGraph] Error generating graph:', err);
      await plugin.app.toast('Error generating graph');
    } finally {
      setIsGenerating(false);
    }
  };





  const readPointRow = readPoint && (
    <div
      className="flex items-center gap-2 flex-wrap text-xs"
      style={{ color: 'var(--rn-clr-content-secondary)', rowGap: 4 }}
    >
      <span className="flex items-center gap-1.5" style={{ whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', color: '#10b981' }}>
          <ReadPointIcon size={13} />
        </span>
        <span className="font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
          Read Point
        </span>
      </span>
      <ReadPointCrumbs
        plugin={plugin as any}
        readPoint={readPoint}
        segmentChars={40}
        className="flex-1"
        style={{ minWidth: 120 }}
      />
      {!readPoint.withinTarget && (
        <span
          style={{ color: 'var(--rn-clr-content-tertiary)' }}
          title="The bookmarked Rem was moved out of this document — showing its nearest ancestors."
        >
          ⚠️ moved out
        </span>
      )}
      <span className="flex items-center gap-1" style={{ marginLeft: 'auto' }}>
        <span
          style={{ color: 'var(--rn-clr-content-tertiary)', whiteSpace: 'nowrap', marginRight: 4 }}
          title={`Set on ${new Date(readPoint.timestamp).toLocaleString()}`}
        >
          {new Date(readPoint.timestamp).toLocaleDateString()}
        </span>
        <button
          onClick={() => openAndFocusRem(plugin as any, readPoint.remId)}
          className="px-2 py-1 text-xs rounded font-semibold"
          style={{
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-blue, #3b82f6)',
            border: '1px solid var(--rn-clr-blue, #3b82f6)',
            whiteSpace: 'nowrap',
          }}
          title="Open the bookmarked Rem and put the cursor in it"
        >
          Go to Read Point
        </button>
        <button
          onClick={() => plugin.widget.openPopup('pdf_bookmark_popup', { mode: 'rem', incRemId: readPoint.incRemId })}
          className="px-2 py-1 text-xs rounded"
          style={{
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-tertiary)',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-primary)'; }}
          title="Read Point History"
        >
          History ↗
        </button>
      </span>
    </div>
  );

  return (
    <>
      {/* A document with a read point but no counted IncRems (not expected —
          the document is itself an IncRem — but the counter depends on the
          cache being loaded) still gets the row, in a card of its own. */}
      {readPointRow && !showCounter && (
        <div style={{ padding: '8px 12px' }}>
          <div
            className="px-3 py-2 rounded-lg"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
            }}
          >
            {readPointRow}
          </div>
        </div>
      )}
      {showCounter && counterData && (
        <div style={{ padding: '8px 12px' }}>
          <div
            className="px-3 py-2 rounded-lg"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
            }}
          >
            <div className="flex items-center justify-between">
              <div
                onClick={handleClick}
                className="flex items-center gap-2 cursor-pointer flex-1"
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
              >
                <span className="text-base">📚</span>
                <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>
                  Inc Rems
                </span>
                <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                  <span style={{ color: '#f97316' }}>{counterData.due}</span>
                  {' / '}
                  <span style={{ color: '#3b82f6' }}>{counterData.total}</span>
                </span>
              </div>
  
              <div className="flex items-center gap-1">
                {/* Priority Graph toggle button */}
                <button
                  onClick={handleGraphClick}
                  className="px-2 py-1 text-xs rounded transition-colors"
                  style={{
                    backgroundColor: showGraph ? 'var(--rn-clr-background-tertiary)' : 'var(--rn-clr-background-primary)',
                    color: 'var(--rn-clr-content-tertiary)',
                    opacity: isGenerating ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => { if (!isGenerating) e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
                  onMouseLeave={(e) => { if (!showGraph) e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-primary)'; }}
                  title={showGraph ? 'Hide Priority Distribution Graph' : 'Show Priority Distribution Graph'}
                  disabled={isGenerating}
                >
                  {isGenerating ? '⏳' : '📊'}
                </button>
  
  
                {/* View All button */}
                <button
                  onClick={handleMainViewClick}
                  className="px-2 py-1 text-xs rounded transition-colors"
                  style={{
                    backgroundColor: 'var(--rn-clr-background-primary)',
                    color: 'var(--rn-clr-content-tertiary)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-primary)'; }}
                  title="View All (Opt+Shift+I)"
                >
                  View All
                </button>
              </div>
            </div>
            {readPointRow && (
              <div
                className="mt-2 pt-2"
                style={{ borderTop: '1px solid var(--rn-clr-border-primary)' }}
              >
                {readPointRow}
              </div>
            )}
          </div>

          {/* Inline Graph Container */}
          {showGraph && counterData.documentId && (
            <div className="mt-2 w-full border-t border-gray-200 pt-2">
              <PriorityDistributionGraphComponent documentId={counterData.documentId} />
            </div>
          )}
        </div>
      )}
      <LocalVideoEditorPlayer />
    </>
  );
}

renderWidget(withHoverTips(IncRemCounter));
