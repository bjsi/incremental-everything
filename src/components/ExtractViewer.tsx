// components/ExtractViewer.tsx
// UPDATED: Added filtering for powerup slots (Incremental and CardPriority)

import React, { useState, useEffect, useCallback } from 'react';
import { PluginRem, RNPlugin, RemViewer, BuiltInPowerupCodes, RemId } from '@remnote/plugin-sdk';
import { powerupCode, allCardPriorityInfoKey, incremNotesSidebarWidgetId, incremNotesSidebarRemIdKey } from '../lib/consts';
import { safeRemTextToString } from '../lib/pdfUtils';
import {
  getChildrenExcludingSlots,
  getDescendantsExcludingSlots
} from '../lib/powerupSlotFilter';
import { CardPriorityInfo } from '../lib/card_priority';

interface ExtractViewerProps {
  rem: PluginRem;
  plugin: RNPlugin;
}

// Define the critical context structure
interface CriticalContext {
  hasDocumentPowerup: boolean;
  ancestors: Array<{ text: string; fullText: string; id: RemId }>;
}

// Define the metadata structure (already deferred)
interface Metadata {
  childrenCount: number;
  incrementalChildrenCount: number;
  descendantsCount: number;
  incrementalDescendantsCount: number;
  flashcardCount: number;
}

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 10;

// How many immediate children to render in the read-only in-queue preview before
// collapsing into a "+N more — edit in sidebar" hint. Each RemViewer is a
// (read-only) FakeEmbed overlay, so we cap to avoid spawning too many at once.
const MAX_PREVIEW_CHILDREN = 25;

export function ExtractViewer({ rem, plugin }: ExtractViewerProps) {
  if (!rem) return null;

  // --- STATE 1: DEFERRED METADATA (Statistics) ---
  const [metadata, setMetadata] = useState<Metadata | null>(null);

  // --- STATE 2: DEFERRED CRITICAL CONTEXT (Breadcrumbs & Status) ---
  const [criticalContext, setCriticalContext] = useState<CriticalContext | null>(null);

  // --- STATE 3: IMMEDIATE CHILDREN for the read-only preview ---
  const [childRemIds, setChildRemIds] = useState<RemId[]>([]);

  // -----------------------------------------------------------
  // 1. EFFECT FOR DEFERRED CRITICAL CONTEXT (Breadcrumbs & Status)
  //    - This replaces the slow parts of the original remData tracker.
  // -----------------------------------------------------------
  useEffect(() => {
    setCriticalContext(null);

    const loadCriticalData = async () => {
      // 1. Check Document Powerup (fast)
      const hasDocumentPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Document);

      // 2. Get Ancestors (slow part)
      const ancestorList: CriticalContext['ancestors'] = [];
      let currentParent = rem.parent;
      let depth = 0;
      const maxDepth = 10;

      while (currentParent && depth < maxDepth) {
        try {
          // Add a yield point here to prevent blocking if the hierarchy is deep.
          if (depth % 2 === 0) {
            await new Promise(resolve => setTimeout(resolve, 1));
          }

          const parentRem = await plugin.rem.findOne(currentParent);
          if (!parentRem) break;

          const parentText = await safeRemTextToString(plugin, parentRem.text || []);

          ancestorList.unshift({
            text: parentText.slice(0, 30) + (parentText.length > 30 ? '...' : ''),
            fullText: parentText,
            id: currentParent
          });

          currentParent = parentRem.parent;
          depth++;
        } catch (error) {
          break;
        }
      }

      setCriticalContext({
        hasDocumentPowerup,
        ancestors: ancestorList
      });
    };

    // Execute after a short delay to ensure initial render is not blocked
    const timeoutId = setTimeout(() => {
      loadCriticalData().catch(console.error);
    }, 10);

    return () => clearTimeout(timeoutId);

  }, [rem._id, plugin]);

  /**
   * OPTIMIZED METADATA CALCULATION FOR ExtractViewer.tsx
   *
   * Replace the existing useEffect for metadata calculation with this optimized version.
   *
   * Key optimization: Uses allCardPriorityInfoKey cache instead of per-rem getCards() calls.
   * This avoids the SDK inconsistency where rem.getCards() sometimes returns [] for valid flashcards.
   *
   * Performance improvement:
   * - Before: N API calls (one per rem in remsToProcess)
   * - After: 1 session storage read + in-memory filtering
   */

  // Add this import at the top of the file:
  // import { allCardPriorityInfoKey } from '../lib/consts';
  // import { CardPriorityInfo } from '../lib/card_priority';

  // -----------------------------------------------------------
  // 2. EFFECT FOR DEFERRED METADATA CALCULATION (Statistics)
  // OPTIMIZED: Uses allCardPriorityInfoKey cache instead of per-rem getCards()
  // -----------------------------------------------------------
  useEffect(() => {
    setMetadata(null);

    const calculateMetadata = async () => {
      console.log("[ExtractViewer] Starting OPTIMIZED metadata calculation (using cache)...");
      const startTime = Date.now();

      // UPDATED: Filter out powerup slots from descendants
      const descendants = await getDescendantsExcludingSlots(plugin, rem);
      const descendantsCount = descendants.length;

      // UPDATED: Filter out powerup slots from children
      const children = await getChildrenExcludingSlots(plugin, rem);
      const childrenCount = children.length;

      const remsToProcess = [rem, ...descendants];

      // Create a Set of children IDs for quick lookup
      const childrenIds = new Set(children.map(c => c._id));

      // Create a Set of all rem IDs we're processing for fast lookup
      const remsToProcessIds = new Set(remsToProcess.map(r => r._id));

      // OPTIMIZATION: Use the pre-built cache instead of calling rem.getCards() for each rem
      // The cache already contains cardCount for each rem
      const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) || [];

      // Build a map of remId -> card count for rems in our scope
      const cardCountByRemId = new Map<string, number>();
      for (const cardInfo of allCardInfos) {
        if (remsToProcessIds.has(cardInfo.remId)) {
          cardCountByRemId.set(cardInfo.remId, cardInfo.cardCount);
        }
      }
      console.log(`[ExtractViewer] Found ${cardCountByRemId.size} rems with cards in scope (from cache)`);

      let incrementalDescendantsCount = 0;
      let flashcardCount = 0;
      let incrementalChildrenCount = 0;
      let processedCount = 0;

      // Process in batches - but now we only need to check hasPowerup, not getCards
      for (let i = 0; i < remsToProcess.length; i += BATCH_SIZE) {
        const batch = remsToProcess.slice(i, i + BATCH_SIZE);

        const batchResults = await Promise.all(
          batch.map(async (r) => ({
            remId: r._id,
            isIncremental: await r.hasPowerup(powerupCode),
            // Use the pre-built map instead of calling getCards()
            cardCount: cardCountByRemId.get(r._id) || 0,
          }))
        );

        for (const result of batchResults) {
          if (result.isIncremental) {
            incrementalDescendantsCount++;
          }
          // Use the card count from our map
          flashcardCount += result.cardCount;

          // Use the Set for O(1) lookup instead of Array.some
          if (childrenIds.has(result.remId) && result.isIncremental) {
            incrementalChildrenCount++;
          }
        }
        processedCount += batch.length;

        if (i + BATCH_SIZE < remsToProcess.length) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }

      setMetadata({
        childrenCount,
        incrementalChildrenCount,
        descendantsCount,
        incrementalDescendantsCount,
        flashcardCount,
      });

      const elapsedTime = Date.now() - startTime;
      console.log(`[ExtractViewer] OPTIMIZED metadata calculation complete. Processed ${processedCount} rems in ${elapsedTime}ms.`);
    };

    const timeoutId = setTimeout(() => {
      calculateMetadata().catch(console.error);
    }, 50);

    return () => clearTimeout(timeoutId);

  }, [rem._id, plugin]);


  // -----------------------------------------------------------
  // 2b. LOAD IMMEDIATE CHILDREN for the read-only preview
  // -----------------------------------------------------------
  // The in-queue view is intentionally READ-ONLY: an editable DocumentViewer
  // (FakeEmbed) cannot hold focus inside the queue's Flashcard pane — it loses a
  // focus tug-of-war with the queue (diagnosed via oscillating FocusedRemChange),
  // which collapses selections, drops keystrokes, and even rates the card. So we
  // render the rem + its children with read-only RemViewers (which don't take
  // focus) and route all editing to the sidebar pane (which holds focus).
  useEffect(() => {
    let cancelled = false;
    setChildRemIds([]);
    (async () => {
      try {
        const children = await getChildrenExcludingSlots(plugin, rem);
        if (cancelled) return;
        setChildRemIds(children.slice(0, MAX_PREVIEW_CHILDREN).map((c) => c._id));
      } catch (e) {
        console.error('[ExtractViewer] failed to load children for preview', e);
      }
    })();
    return () => { cancelled = true; };
  }, [rem._id, plugin]);

  // -----------------------------------------------------------
  // 2c. AUTO-OPEN the notes sidebar (and tell it WHICH rem to edit)
  // -----------------------------------------------------------
  // Editing happens in increm_notes_sidebar (RightSidebar pane), so surface it
  // automatically — mirrors the 📝 button Reader.tsx uses for PDF/HTML.
  //
  // We publish the rem id to a dedicated session key rather than letting the
  // sidebar infer it from currentIncrementalRemTypeKey: the queue clears that
  // type key in its own effect-cleanup, so it races with this auto-open and the
  // sidebar would intermittently see `undefined` and show its empty state. This
  // key is set by the widget that definitively knows a Rem extract is on screen,
  // and cleared on unmount. The sidebar additionally only honors it when it
  // matches the current IncRem id, so a stale value (if an unmount-clear is
  // skipped during sandbox teardown) is ignored rather than mis-shown.
  useEffect(() => {
    plugin.storage.setSession(incremNotesSidebarRemIdKey, rem._id);
    plugin.window.openWidgetInRightSidebar(incremNotesSidebarWidgetId).catch(() => {});
    return () => {
      plugin.storage.setSession(incremNotesSidebarRemIdKey, undefined);
    };
  }, [rem._id, plugin]);

  // NOTE: Restoring the Practiced Queues dashboard after advancing past an
  // IncRem is handled globally in handleNextRepetitionClick (gated by the
  // "Auto focus Queue Dashboard" setting) rather than here — PDF/HTML items
  // also need it (RemNote auto-focuses its own Summary pane for those), so a
  // rem-only listener wouldn't cover them.


  // -----------------------------------------------------------
  // 3. MAIN RENDER LOGIC
  // -----------------------------------------------------------

  // --- IMMEDIATE RENDER ---
  // We no longer rely on remData. We use null coalescing for the deferred state.

  const isMetadataLoading = !metadata;
  const {
    childrenCount = '...',
    incrementalChildrenCount = '...',
    descendantsCount = '...',
    incrementalDescendantsCount = '...',
    flashcardCount = '...'
  } = metadata || {};

  // Fallback for Critical Context (Breadcrumbs/Status)
  const isContextLoading = !criticalContext;
  const ancestors = criticalContext?.ancestors || [];
  const hasDocumentPowerup = criticalContext?.hasDocumentPowerup ?? false;

  const handleAncestorClick = useCallback(
    async (ancestorId: RemId) => {
      const ancestorRem = await plugin.rem.findOne(ancestorId);
      if (ancestorRem) {
        await plugin.window.openRem(ancestorRem);
      }
    },
    [plugin]
  );

  const openNotesSidebar = useCallback(() => {
    plugin.window.openWidgetInRightSidebar(incremNotesSidebarWidgetId).catch(() => {});
  }, [plugin]);

  const renderedChildren = childRemIds.length;
  const hiddenChildren =
    typeof childrenCount === 'number' ? Math.max(0, childrenCount - renderedChildren) : 0;

  return (
    <div
      className="extract-viewer"
      style={{
        height: '100vh',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // Top padding keeps the card below the queue's absolute "Back to isolated
        // view" button (top:12), so it can never sit under the breadcrumb.
        padding: '48px 16px 16px',
        overflow: 'hidden',
      }}
    >
      {/* Card frame (modelled on IsolatedCardViewer): header (wrapping
          breadcrumb), scrollable read-only content, and a footer with stats +
          the "Edit in sidebar" button. */}
      <div
        style={{
          width: '100%',
          maxWidth: 1000,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--rn-clr-background-secondary, #ffffff)',
          border: '1px solid var(--rn-clr-border-primary, #e2e8f0)',
          borderRadius: 12,
          boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
          overflow: 'hidden',
        }}
      >
        {/* Header — breadcrumb wraps onto multiple lines instead of scrolling. */}
        <div
          style={{
            flexShrink: 0,
            padding: '10px 16px',
            borderBottom: '1px solid var(--rn-clr-border-primary, #e2e8f0)',
            opacity: isContextLoading ? 0 : 1,
          }}
        >
          {!isContextLoading && ancestors.length > 0 && (
            <div style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--rn-clr-content-tertiary, #64748b)', wordBreak: 'break-word' }}>
              {ancestors.map((ancestor, index) => (
                <span key={ancestor.id}>
                  <span
                    onClick={() => handleAncestorClick(ancestor.id)}
                    className="hover:underline"
                    title={ancestor.fullText}
                    style={{ cursor: 'pointer' }}
                  >
                    {ancestor.fullText}
                  </span>
                  {index < ancestors.length - 1 && <span style={{ margin: '0 4px' }}>›</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Content — read-only Rem + children (RemViewer never captures focus,
            so editing is routed to the auto-opened notes sidebar). Uses the
            primary background so only the frame (header/footer) is grey, like
            IsolatedCardViewer. */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px', backgroundColor: 'var(--rn-clr-background-primary, #ffffff)' }}>
          <div style={{ fontSize: 16, lineHeight: 1.7 }}>
            <RemViewer remId={rem._id} width="100%" />
          </div>

          {renderedChildren > 0 && (
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                paddingLeft: 12,
                borderTop: '1px solid var(--rn-clr-border-primary, #e5e7eb)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {childRemIds.map((id) => (
                <RemViewer key={id} remId={id} width="100%" />
              ))}
              {hiddenChildren > 0 && (
                <button
                  onClick={openNotesSidebar}
                  style={{
                    alignSelf: 'flex-start',
                    marginTop: 4,
                    background: 'none',
                    border: 'none',
                    color: 'var(--rn-clr-content-tertiary, #94a3b8)',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  + {hiddenChildren} more — edit in sidebar →
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer — status + statistics, and the Edit-in-sidebar action. */}
        <div
          style={{
            flexShrink: 0,
            borderTop: '1px solid var(--rn-clr-border-primary, #e2e8f0)',
            padding: '8px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            backgroundColor: 'var(--rn-clr-background-secondary, #f8fafc)',
            opacity: isMetadataLoading ? 0.7 : 1,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary, #64748b)', display: 'flex', flexWrap: 'wrap', gap: 12, minWidth: 0 }}>
            <span>{isContextLoading ? 'Loading…' : (hasDocumentPowerup ? 'Document' : 'Extract')} • Incremental Rem</span>
            {isMetadataLoading ? (
              <span>Calculating statistics…</span>
            ) : (
              <>
                <span>{childrenCount} direct {childrenCount === 1 ? 'child' : 'children'} ({incrementalChildrenCount} incremental)</span>
                <span>{descendantsCount} {descendantsCount === 1 ? 'descendant' : 'descendants'} ({incrementalDescendantsCount} incremental)</span>
                <span>{flashcardCount} {flashcardCount === 1 ? 'flashcard' : 'flashcards'}</span>
              </>
            )}
          </div>
          <button
            onClick={openNotesSidebar}
            title="Open this Rem in the notes sidebar to edit (the in-queue view is read-only)"
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--rn-clr-blue, #3b82f6)',
              backgroundColor: 'var(--rn-clr-background-primary, #ffffff)',
              color: 'var(--rn-clr-blue, #3b82f6)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            ✎ Edit in sidebar →
          </button>
        </div>
      </div>
    </div>
  );
}
