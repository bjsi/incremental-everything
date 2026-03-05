import { ReactRNPlugin, renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState, useRef } from 'react';
import { allIncrementalRemKey, popupDocumentIdKey, powerupCode, prioritySlotCode } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { buildDocumentScope } from '../lib/scope_helpers';
import { extractText, determineIncRemType, getTotalTimeSpent, getBreadcrumbText } from '../lib/incRemHelpers';
import { safeRemTextToString } from '../lib/pdfUtils';
import { getNextSpacingDateForRem } from '../lib/scheduler';
import { getSortingRandomness } from '../lib/sorting';
import { IncRemTable, IncRemWithDetails } from '../components';
import type { IncRemListState } from '../components';
import '../style.css';
import '../App.css';

const INC_REM_LIST_STATE_KEY = 'inc-rem-list-state';

export function IncRemList() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);
  const [scopeName, setScopeName] = useState<string | null>(null);

  // Track in-flight priority changes so cache reloads don't overwrite them with stale data.
  const pendingPriorityChanges = useRef<Record<string, number>>({});

  // Track current filter/sort state so we can store it before launching review
  const currentListState = useRef<IncRemListState | null>(null);

  // Load saved state from session (for "Back to IncRem List" flow)
  const [initialState, setInitialState] = useState<IncRemListState | undefined>(undefined);
  const [stateCheckDone, setStateCheckDone] = useState(false);
  const initialStateLoaded = useRef(false);

  // Load initial state from session on first render
  const initialData = useTrackerPlugin(
    async (rp) => {
      if (initialStateLoaded.current) return null;
      initialStateLoaded.current = true;
      const state = await rp.storage.getSession<IncRemListState>(INC_REM_LIST_STATE_KEY);
      if (state) {
        setInitialState(state);
        // Clear it so it doesn't persist for future opens
        await rp.storage.setSession(INC_REM_LIST_STATE_KEY, undefined);
      }

      const randomness = await getSortingRandomness(rp as any);

      setStateCheckDone(true);
      return { randomness };
    },
    []
  );

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        const documentId = await rp.storage.getSession<string>(popupDocumentIdKey);
        const allIncRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
        const now = Date.now();

        if (!documentId) {
          setScopeName(null);
          const dueIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);
          loadIncRemDetails(allIncRems);
          return { due: dueIncRems.length, total: allIncRems.length };
        }

        // Resolve document name for the heading
        const docRem = await rp.rem.findOne(documentId);
        if (docRem) {
          const name = await safeRemTextToString(rp, docRem.text);
          setScopeName(name || 'Document');
        }

        const documentScope = await buildDocumentScope(rp, documentId);
        if (documentScope.size === 0) {
          return { due: 0, total: 0 };
        }

        const docIncRems = allIncRems.filter((incRem) => documentScope.has(incRem.remId));
        const dueIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);
        loadIncRemDetails(docIncRems);

        return { due: dueIncRems.length, total: docIncRems.length };
      } catch (error) {
        console.error('INC REM LIST: Error', error);
        return { due: 0, total: 0 };
      }
    },
    []
  );

  const loadIncRemDetails = async (incRems: IncrementalRem[]) => {
    if (loadingRems) return;
    setLoadingRems(true);

    const sortedByPriority = [...incRems].sort((a, b) => a.priority - b.priority);
    const percentiles: Record<string, number> = {};
    sortedByPriority.forEach((item, index) => {
      percentiles[item.remId] = Math.round(((index + 1) / sortedByPriority.length) * 100);
    });

    const remsWithDetails: IncRemWithDetails[] = [];

    for (const incRem of incRems) {
      try {
        const rem = await plugin.rem.findOne(incRem.remId);
        if (!rem) continue;

        const text = await rem.text;
        let textStr = extractText(text);
        if (textStr.length > 200) textStr = textStr.substring(0, 200) + '...';

        const incRemType = await determineIncRemType(plugin, rem);

        const lastReviewDate = incRem.history && incRem.history.length > 0
          ? Math.max(...incRem.history.map(h => h.date))
          : undefined;

        const breadcrumb = await getBreadcrumbText(plugin, rem);

        remsWithDetails.push({
          ...incRem,
          remText: textStr || '[Empty rem]',
          incRemType,
          percentile: percentiles[incRem.remId],
          totalTimeSpent: getTotalTimeSpent(incRem),
          lastReviewDate,
          breadcrumb,
        });
      } catch (error) {
        console.error('Error loading rem details:', error);
      }
    }

    // Apply any pending priority changes so stale cache data doesn't overwrite them
    const pending = pendingPriorityChanges.current;
    const hasPending = Object.keys(pending).length > 0;
    const finalDetails = hasPending
      ? remsWithDetails.map((item) =>
        pending[item.remId] !== undefined
          ? { ...item, priority: pending[item.remId] }
          : item
      )
      : remsWithDetails;

    // Clear pending entries only when the cache data already has the correct value
    for (const remId of Object.keys(pending)) {
      const cacheItem = incRems.find(r => r.remId === remId);
      if (cacheItem && cacheItem.priority === pending[remId]) {
        delete pendingPriorityChanges.current[remId];
      }
    }

    setIncRemsWithDetails(finalDetails);
    setLoadingRems(false);
  };

  const handleClose = () => plugin.widget.closePopup();

  const handleRemClick = async (remId: string) => {
    const rem = await plugin.rem.findOne(remId);
    const incRem = incRemsWithDetails.find(r => r.remId === remId);

    if (rem) {
      if (incRem?.incRemType === 'pdf-note') {
        // For PDF notes, use openRemAsPage to avoid opening the PDF viewer
        await rem.openRemAsPage();
      } else {
        await plugin.window.openRem(rem);
      }
      await plugin.widget.closePopup();
    }
  };

  const handlePriorityChange = async (remId: string, newPriority: number) => {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;

    pendingPriorityChanges.current[remId] = newPriority;

    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

    // Update the cache
    const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
    if (incRemInfo) {
      await updateIncrementalRemCache(plugin, incRemInfo);
    }

    // Update local state so the UI re-renders immediately
    setIncRemsWithDetails((prev) =>
      prev.map((item) =>
        item.remId === remId ? { ...item, priority: newPriority } : item
      )
    );

    await plugin.app.toast(`Priority updated to ${newPriority}`);
  };

  const handleReviewAndOpen = async (remId: string, subsequentRemIds?: string[]) => {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;

    // Store the current list state so the timer can reopen with the same filters/sorting
    if (currentListState.current) {
      await plugin.storage.setSession(INC_REM_LIST_STATE_KEY, currentListState.current);
    }

    // Store the subsequent queue list for sequential review
    if (subsequentRemIds) {
      await plugin.storage.setSession('editor-review-timer-queue-list', subsequentRemIds);
    } else {
      await plugin.storage.setSession('editor-review-timer-queue-list', undefined);
    }

    // Compute the scheduler's suggested interval (like editor_review does)
    const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
    const inLookbackMode = !!(await plugin.queue.inLookbackMode());
    const scheduleData = await getNextSpacingDateForRem(plugin, remId, inLookbackMode);
    const interval = scheduleData?.newInterval || 1;
    const remName = await safeRemTextToString(plugin, rem.text);

    // Set up timer session keys (DON'T call updateReviewRemData — the timer will
    // handle rescheduling on end-review via Mode 2)
    await plugin.storage.setSession('editor-review-timer-rem-id', remId);
    await plugin.storage.setSession('editor-review-timer-start', Date.now());
    await plugin.storage.setSession('editor-review-timer-interval', interval);
    await plugin.storage.setSession('editor-review-timer-priority', incRemInfo?.priority ?? 10);
    await plugin.storage.setSession('editor-review-timer-rem-name', remName || 'Unnamed Rem');
    await plugin.storage.setSession('editor-review-timer-from-queue', false);
    await plugin.storage.setSession('editor-review-timer-origin', 'inc-rem-list');

    await plugin.app.toast(`⏱️ Timer started for: ${remName}`);

    // Open the rem in the editor
    const incRemType = await determineIncRemType(plugin, rem);
    if (incRemType === 'pdf-note') {
      await rem.openRemAsPage();
    } else {
      await plugin.window.openRem(rem);
    }

    await plugin.widget.closePopup();
  };

  const handleStateChange = (state: IncRemListState) => {
    currentListState.current = state;
  };

  if (!stateCheckDone) {
    return null; // Wait for state check before rendering to ensure initialState is ready
  }

  return (
    <IncRemTable
      title={scopeName
        ? `Inc Rems · ${scopeName.length > 30 ? scopeName.substring(0, 27) + '...' : scopeName}`
        : 'Inc Rems (All KB)'}
      subtitle={scopeName && scopeName.length > 30 ? scopeName : undefined}
      icon="📚"
      incRems={incRemsWithDetails}
      loading={loadingRems}
      dueCount={counterData?.due ?? 0}
      totalCount={counterData?.total ?? 0}
      onRemClick={handleRemClick}
      onClose={handleClose}
      onPriorityChange={handlePriorityChange}
      onReviewAndOpen={handleReviewAndOpen}
      initialState={initialState}
      onStateChange={handleStateChange}
      sortingRandomness={initialData?.randomness ?? 0}
    />
  );
}

renderWidget(IncRemList);
