import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { allIncrementalRemKey, currentDocumentIdKey, popupDocumentIdKey, priorityGraphDocPowerupCode, GRAPH_LAST_UPDATED_KEY_PREFIX } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { buildDocumentScope } from '../lib/scope_helpers';
import { generateAndStoreGraphData } from '../lib/priority_graph_data';
import '../style.css';
import '../App.css';

function IncRemCounter() {
  const plugin = usePlugin();
  const [isGenerating, setIsGenerating] = useState(false);

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        await rp.storage.getSession(currentDocumentIdKey);

        const ctx = await rp.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
        const documentId = ctx?.documentId;

        const allIncRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

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

  // Fetch the last updated timestamp for this document's graph
  const lastUpdated = useRunAsync(async () => {
    if (!counterData?.documentId) return null;
    const ts = await plugin.storage.getSynced(GRAPH_LAST_UPDATED_KEY_PREFIX + counterData.documentId) as string | null;
    return ts;
  }, [counterData?.documentId, isGenerating]);

  if (!counterData || counterData.total === 0) {
    return null;
  }

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
    if (!counterData.documentId || isGenerating) return;

    setIsGenerating(true);
    try {
      const documentId = counterData.documentId;
      const documentRem = await plugin.rem.findOne(documentId);
      if (!documentRem) {
        setIsGenerating(false);
        return;
      }

      // Check if a graph Rem already exists as a child of this document
      const children = await documentRem.getChildrenRem();
      let graphRem = null;
      for (const child of children) {
        const hasPowerup = await child.hasPowerup(priorityGraphDocPowerupCode);
        if (hasPowerup) {
          graphRem = child;
          break;
        }
      }

      // If no graph Rem exists, create one as the first child
      if (!graphRem) {
        graphRem = await plugin.rem.createRem();
        if (!graphRem) {
          setIsGenerating(false);
          return;
        }
        await graphRem.setText(["Priority Distribution Graph"]);
        await graphRem.addPowerup(priorityGraphDocPowerupCode);

        // Insert as first child (position 0)
        await graphRem.setParent(documentRem, 0);
      }

      // Generate and store the graph data
      await generateAndStoreGraphData(plugin, documentId, graphRem._id);

      await plugin.app.toast('📊 Priority Graph updated!');
    } catch (err) {
      console.error('[PriorityGraph] Error generating graph:', err);
      await plugin.app.toast('Error generating graph');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRefreshClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Reuse the same logic as generating — it finds existing graph or creates one
    await handleGraphClick(e);
  };

  // Format the last updated timestamp
  const lastUpdatedText = lastUpdated
    ? new Date(lastUpdated).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    : null;

  return (
    <div style={{ padding: '8px 12px' }}>
      <div
        className="flex items-center justify-between px-3 py-2 rounded-lg"
        style={{
          backgroundColor: 'var(--rn-clr-background-secondary)',
          border: '1px solid var(--rn-clr-border-primary)',
        }}
      >
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
          {/* Last updated timestamp */}
          {lastUpdatedText && (
            <span className="text-xs mr-1" style={{ color: 'var(--rn-clr-content-tertiary)', opacity: 0.7 }}>
              📊 {lastUpdatedText}
            </span>
          )}

          {/* Priority Graph button */}
          <button
            onClick={handleGraphClick}
            className="px-2 py-1 text-xs rounded transition-colors"
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-tertiary)',
              opacity: isGenerating ? 0.5 : 1,
            }}
            onMouseEnter={(e) => { if (!isGenerating) e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-primary)'; }}
            title={lastUpdated ? 'Refresh Priority Graph' : 'Generate Priority Graph'}
            disabled={isGenerating}
          >
            {isGenerating ? '⏳' : (lastUpdated ? '🔄' : '📊')}
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
    </div>
  );
}

renderWidget(IncRemCounter);
