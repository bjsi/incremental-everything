// widgets/batch_priority.tsx
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  PluginRem,
  RNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  powerupCode,
  prioritySlotCode,
  allIncrementalRemKey,
  allCardPriorityInfoKey
} from '../lib/consts';
import { CARD_PRIORITY_CODE, PRIORITY_SLOT, SOURCE_SLOT, CardPriorityInfo } from '../lib/card_priority/types';
import { updateCardPriorityCache } from '../lib/card_priority/cache';
import { setCardPriority } from '../lib/card_priority';
import { IncrementalRem, ActionItemType } from '../lib/incremental_rem';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { percentileToHslColor, calculateRelativePercentile } from '../lib/utils';
import { remToActionItemType } from '../lib/incremental_rem';
import { safeRemTextToString } from '../lib/pdfUtils';
import dayjs from 'dayjs';

// Types for our operations
type OperationType = 'increase' | 'decrease' | 'spread' | 'adjust';
type SortField = 'hierarchy' | 'name' | 'currentPriority' | 'newPriority' | 'type' | 'nextRepDate' | 'repetitions' | 'percentile';
type SortDirection = 'asc' | 'desc';

interface PrioritizedItemData {
  remId: string;
  rem: PluginRem;
  name: string;
  hasIncRem: boolean;
  hasCardPriority: boolean;
  currentIncPriority: number | null;
  currentCardPriority: number | null;
  newIncPriority: number | null;
  newCardPriority: number | null;
  cardPrioritySource: string | null;
  type: ActionItemType | 'rem';
  cardStatus: 'Has Cards' | 'Inheritance only' | null;
  nextRepDate: number;
  repetitions: number;
  depth: number;
  path: string[];
  pathIds: string[];
  isChecked: boolean;
  incPercentile: number | null;
  cardPercentile: number | null;
  originalIndex: number;
}

function BatchPriority() {
  console.log('🚀 BatchPriority: Component rendering');
  const plugin = usePlugin();

  const cachedFocusedRemIdRef = useRef<string | undefined>(undefined);

  // Get the focused rem from session storage
  const focusedRemId = useTrackerPlugin(
    async (rp) => {
      if (isApplyingRef.current) {
        return cachedFocusedRemIdRef.current;
      }
      const id = await rp.storage.getSession<string>('batchPriorityFocusedRem');
      console.log('📌 BatchPriority: Focused rem ID from session:', id);
      return id;
    },
    []
  );

  useEffect(() => {
    if (!isApplyingRef.current && focusedRemId) {
      cachedFocusedRemIdRef.current = focusedRemId;
    }
  }, [focusedRemId]);

  // State management
  const [incrementalRems, setIncrementalRems] = useState<PrioritizedItemData[]>([]);
  const [filteredRems, setFilteredRems] = useState<PrioritizedItemData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [operation, setOperation] = useState<OperationType>('increase');
  const [changePercent, setChangePercent] = useState(50);
  const [decreasePercent, setDecreasePercent] = useState(150); // Separate state for decrease
  const [spreadStart, setSpreadStart] = useState(1);
  const [spreadEnd, setSpreadEnd] = useState(100);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [hasCalculated, setHasCalculated] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [priorityTypeFilter, setPriorityTypeFilter] = useState<'all' | 'incRem' | 'cardPriority'>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [priorityRangeMin, setPriorityRangeMin] = useState(0);
  const [priorityRangeMax, setPriorityRangeMax] = useState(100);
  const [sortField, setSortField] = useState<SortField>('hierarchy');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [isApplying, setIsApplying] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);
  const [totalToApply, setTotalToApply] = useState(0);
  const [previousStates, setPreviousStates] = useState<PrioritizedItemData[][]>([]);
  const isApplyingRef = useRef(false);

  // Cached refs for freezing reactive hooks during batch apply
  const cachedIncRemsRef = useRef<IncrementalRem[] | null>(null);
  const cachedCardInfosRef = useRef<CardPriorityInfo[] | null>(null);

  // Get all incremental rems from storage (frozen during apply)
  const allIncrementalRems = useTrackerPlugin(
    async (rp) => {
      if (isApplyingRef.current) {
        return cachedIncRemsRef.current ?? undefined;
      }
      console.log('📊 BatchPriority: Fetching all incremental rems from storage');
      return rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey);
    },
    []
  );

  // Get all card priorities from storage (frozen during apply)
  const allCardInfos = useTrackerPlugin(
    async (rp) => {
      if (isApplyingRef.current) {
        return cachedCardInfosRef.current ?? undefined;
      }
      console.log('📊 BatchPriority: Fetching all card priorities from storage');
      return rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);
    },
    []
  );

  // Keep cached refs in sync when not applying
  useEffect(() => {
    if (!isApplyingRef.current && Array.isArray(allIncrementalRems)) {
      cachedIncRemsRef.current = allIncrementalRems;
    }
  }, [allIncrementalRems]);

  useEffect(() => {
    if (!isApplyingRef.current && Array.isArray(allCardInfos)) {
      cachedCardInfosRef.current = allCardInfos;
    }
  }, [allCardInfos]);

  // Load incremental rems in the focused rem's hierarchy
  useEffect(() => {
    const loadIncrementalRems = async () => {
      // Skip reload if we are mid-apply — the cache update triggers this effect
      // but we want to keep showing the progress bar, not reset to loading.
      if (isApplyingRef.current) {
        console.log('⚠️ BatchPriority: Skipping reload — apply in progress');
        return;
      }
      console.log('🔄 BatchPriority: Starting to load incremental rems');
      console.log('   - focusedRemId:', focusedRemId);

      if (!focusedRemId) {
        console.log('❌ BatchPriority: No focused rem ID, stopping load');
        setIsLoading(false);
        setErrorMessage('No focused rem ID found in session');
        return;
      }

      try {
        setIsLoading(true);
        setErrorMessage('');

        console.log('🔍 BatchPriority: Finding rem with ID:', focusedRemId);
        const focusedRem = await plugin.rem.findOne(focusedRemId);

        if (!focusedRem) {
          console.log('❌ BatchPriority: Could not find rem with ID:', focusedRemId);
          setIsLoading(false);
          setErrorMessage(`Could not find rem with ID: ${focusedRemId}`);
          return;
        }

        console.log('✅ BatchPriority: Found focused rem:', focusedRem._id);
        const focusedRemText = focusedRem.text ? await safeRemTextToString(plugin, focusedRem.text) : 'Untitled';
        console.log('   - Rem text:', focusedRemText);

        // Get all descendants of the focused rem first
        console.log('🌳 BatchPriority: Getting all descendants...');
        const allDescendants = await focusedRem.getDescendants();
        console.log('   - Found', allDescendants.length, 'descendants');

        // Include the focused rem itself
        const allRemsToCheck = [focusedRem, ...allDescendants];
        console.log('   - Total rems to check:', allRemsToCheck.length);

        const prioritizedData: PrioritizedItemData[] = [];

        // Create a map for fast index lookup
        const remIndexMap = new Map<string, number>();
        allRemsToCheck.forEach((r, i) => remIndexMap.set(r._id, i));

        // Check each rem for prioritized items - process ALL rems in the hierarchy
        console.log('🔎 BatchPriority: Checking each rem for prioritized items...');

        for (const rem of allRemsToCheck) {
          try {
            const hasIncremental = await rem.hasPowerup(powerupCode);
            const hasCardPriorityPowerup = await rem.hasPowerup(CARD_PRIORITY_CODE);

            let hasValidCardPriority = false;
            let cardPrioritySource: string | null = null;
            let currentCardPriority: number | null = null;

            if (hasCardPriorityPowerup) {
              const sourceStr = await rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT);
              if (sourceStr === 'manual' || sourceStr === 'incremental') {
                hasValidCardPriority = true;
                cardPrioritySource = sourceStr;
                const priorityStr = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
                currentCardPriority = parseInt(priorityStr);
                if (isNaN(currentCardPriority)) currentCardPriority = 50;
              }
            }

            if (hasIncremental || hasValidCardPriority) {
              console.log(`   ✓ Found prioritized rem:`, rem._id);

              let currentIncPriority = null;
              let nextRepDate = 0;
              let repetitions = 0;
              let remType: ActionItemType | 'rem' = 'rem';

              if (hasIncremental) {
                const incInfo = await getIncrementalRemFromRem(plugin, rem);
                if (incInfo) {
                  currentIncPriority = incInfo.priority;
                  nextRepDate = incInfo.nextRepDate;
                  repetitions = incInfo.history?.length || 0;

                  const actionItem = await remToActionItemType(plugin, rem);
                  remType = (actionItem?.type || 'rem') as ActionItemType | 'rem';
                } else if (!hasValidCardPriority) {
                  console.log(`     ⚠️ Could not get incremental info for rem:`, rem._id);
                  continue;
                }
              }

              const remText = rem.text ? await safeRemTextToString(plugin, rem.text) : 'Untitled';

              // Calculate depth and path for hierarchy display
              const { path, pathIds } = await getRemPathWithIds(plugin, rem, focusedRemId);
              const depth = rem._id === focusedRemId ? 0 : path.length - 1;

              let cardStatus: 'Has Cards' | 'Inheritance only' | null = null;
              if (hasValidCardPriority && Array.isArray(allCardInfos)) {
                const cardInfo = allCardInfos.find((ci: CardPriorityInfo) => ci.remId === rem._id);
                if (cardInfo) {
                  cardStatus = cardInfo.cardCount > 0 ? 'Has Cards' : 'Inheritance only';
                }
              }

              prioritizedData.push({
                remId: rem._id,
                rem: rem,
                name: remText,
                hasIncRem: hasIncremental,
                hasCardPriority: hasValidCardPriority,
                currentIncPriority,
                currentCardPriority,
                newIncPriority: null,
                newCardPriority: null,
                cardPrioritySource,
                type: remType,
                cardStatus,
                nextRepDate,
                repetitions,
                depth,
                path,
                pathIds,
                isChecked: true,
                incPercentile: Array.isArray(allIncrementalRems) ?
                  calculateRelativePercentile(allIncrementalRems, rem._id) : null,
                cardPercentile: Array.isArray(allCardInfos) ?
                  calculateRelativePercentile(allCardInfos, rem._id) : null,
                originalIndex: remIndexMap.get(rem._id) ?? 0
              });
            }
          } catch (remError) {
            console.error(`   ❌ Error checking rem:`, remError);
          }
        }

        console.log('📈 BatchPriority: Found', prioritizedData.length, 'prioritized rems total');

        // Sort by hierarchy (document order)
        prioritizedData.sort((a, b) => {
          return a.originalIndex - b.originalIndex;
        });

        console.log('✅ BatchPriority: Setting prioritized rems data');
        setIncrementalRems(prioritizedData);
        setFilteredRems(prioritizedData);

        // Initially expand all nodes
        const allIds = new Set(prioritizedData.map(item => item.remId));
        setExpandedNodes(allIds);
        console.log('   - Expanded all nodes');

      } catch (error) {
        console.error('❌ BatchPriority: Error loading incremental rems:', error);
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        setErrorMessage(`Error: ${message}`);
        await plugin.app.toast('Error loading incremental rems');
      } finally {
        setIsLoading(false);
        console.log('🏁 BatchPriority: Finished loading');
      }
    };

    loadIncrementalRems();
  }, [focusedRemId, plugin, allIncrementalRems, allCardInfos]);

  // Apply filters and sorting
  useEffect(() => {
    let filtered = [...incrementalRems];

    // Apply search filter
    if (searchTerm) {
      filtered = filtered.filter(rem =>
        rem.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Apply type filter
    if (typeFilter.length > 0) {
      filtered = filtered.filter(rem => {
        let matchesType = false;
        if (rem.hasCardPriority && rem.cardStatus === 'Has Cards' && typeFilter.includes('has-cards')) matchesType = true;
        else if (rem.hasCardPriority && rem.cardStatus === 'Inheritance only' && typeFilter.includes('inheritance-only')) matchesType = true;
        else if (rem.hasIncRem && typeFilter.includes(rem.type)) matchesType = true;
        return matchesType;
      });
    }

    // Apply priority type filter
    if (priorityTypeFilter === 'incRem') {
      filtered = filtered.filter(rem => rem.hasIncRem);
    } else if (priorityTypeFilter === 'cardPriority') {
      filtered = filtered.filter(rem => rem.hasCardPriority);
    }

    // Apply source filter
    if (sourceFilter !== 'all') {
      filtered = filtered.filter(rem => rem.hasCardPriority && rem.cardPrioritySource === sourceFilter);
    }

    // Apply priority range filter
    filtered = filtered.filter(rem => {
      const incInRange = rem.hasIncRem && rem.currentIncPriority !== null && rem.currentIncPriority >= priorityRangeMin && rem.currentIncPriority <= priorityRangeMax;
      const cardInRange = rem.hasCardPriority && rem.currentCardPriority !== null && rem.currentCardPriority >= priorityRangeMin && rem.currentCardPriority <= priorityRangeMax;

      if (priorityTypeFilter === 'incRem') return incInRange;
      if (priorityTypeFilter === 'cardPriority') return cardInRange;
      return incInRange || cardInRange;
    });

    // Apply sorting
    if (sortField === 'hierarchy') {
      // Hierarchical sorting - maintain tree structure via document order
      filtered.sort((a, b) => {
        const diff = a.originalIndex - b.originalIndex;
        // If sorting descending, reverse the order
        return sortDirection === 'asc' ? diff : -diff;
      });
    } else {
      // Other sorting fields
      filtered.sort((a, b) => {
        let compareValue = 0;

        switch (sortField) {
          case 'name':
            compareValue = a.name.localeCompare(b.name);
            break;
          case 'currentPriority': {
            const aVal = a.currentIncPriority ?? a.currentCardPriority ?? 0;
            const bVal = b.currentIncPriority ?? b.currentCardPriority ?? 0;
            compareValue = aVal - bVal;
            break;
          }
          case 'newPriority': {
            const aNew = a.newIncPriority ?? a.newCardPriority ?? a.currentIncPriority ?? a.currentCardPriority ?? 0;
            const bNew = b.newIncPriority ?? b.newCardPriority ?? b.currentIncPriority ?? b.currentCardPriority ?? 0;
            compareValue = aNew - bNew;
            break;
          }
          case 'type':
            compareValue = a.type.localeCompare(b.type);
            break;
          case 'nextRepDate':
            compareValue = a.nextRepDate - b.nextRepDate;
            break;
          case 'repetitions':
            compareValue = a.repetitions - b.repetitions;
            break;
          case 'percentile':
            compareValue = (a.incPercentile ?? a.cardPercentile ?? 100) - (b.incPercentile ?? b.cardPercentile ?? 100);
            break;
        }

        return sortDirection === 'asc' ? compareValue : -compareValue;
      });
    }

    setFilteredRems(filtered);
  }, [incrementalRems, searchTerm, typeFilter, priorityTypeFilter, sourceFilter, priorityRangeMin, priorityRangeMax, sortField, sortDirection]);

  // Calculate new priorities based on operation
  const calculateNewPriorities = () => {
    console.log('🧮 BatchPriority: Calculating new priorities');
    console.log('   - Operation:', operation);
    console.log('   - Parameters:', { changePercent, decreasePercent, spreadStart, spreadEnd });

    // Save current state for undo
    setPreviousStates(prev => [...prev, incrementalRems]);

    // When filters are active, only consider filtered items
    const scope = hasActiveFilters ? filteredRems : incrementalRems;
    const scopeIds = hasActiveFilters ? new Set(filteredRems.map(r => r.remId)) : null;
    const checkedRems = scope.filter(r => r.isChecked);
    console.log('   - Checked rems:', checkedRems.length, 'hasActiveFilters:', hasActiveFilters);

    if (checkedRems.length === 0) {
      console.log('   ⚠️ No items selected');
      plugin.app.toast('No items selected for priority change');
      return;
    }

    let updatedRems = [...incrementalRems];
    // Helper to check if a rem is in scope
    const isInScope = (rem: PrioritizedItemData) => !scopeIds || scopeIds.has(rem.remId);

    switch (operation) {
      case 'increase': {
        const multiplier = changePercent / 100;
        console.log('   - Increase multiplier:', multiplier);
        updatedRems = updatedRems.map(rem => ({
          ...rem,
          newIncPriority: (isInScope(rem) && rem.isChecked && rem.hasIncRem && rem.currentIncPriority !== null) ?
            Math.max(0, Math.round(rem.currentIncPriority * multiplier)) : (isInScope(rem) ? null : rem.newIncPriority),
          newCardPriority: (isInScope(rem) && rem.isChecked && rem.hasCardPriority && rem.currentCardPriority !== null) ?
            Math.max(0, Math.round(rem.currentCardPriority * multiplier)) : (isInScope(rem) ? null : rem.newCardPriority)
        }));
        break;
      }

      case 'decrease': {
        const multiplier = decreasePercent / 100;
        console.log('   - Decrease multiplier:', multiplier);
        updatedRems = updatedRems.map(rem => ({
          ...rem,
          newIncPriority: (isInScope(rem) && rem.isChecked && rem.hasIncRem && rem.currentIncPriority !== null) ?
            Math.min(100, Math.round(rem.currentIncPriority * multiplier)) : (isInScope(rem) ? null : rem.newIncPriority),
          newCardPriority: (isInScope(rem) && rem.isChecked && rem.hasCardPriority && rem.currentCardPriority !== null) ?
            Math.min(100, Math.round(rem.currentCardPriority * multiplier)) : (isInScope(rem) ? null : rem.newCardPriority)
        }));
        break;
      }

      case 'spread': {
        const spreadRange = spreadEnd - spreadStart;
        const numChecked = checkedRems.length;
        console.log('   - Spread range:', spreadRange, 'Num checked:', numChecked);

        if (numChecked <= 1) {
          console.log('   ⚠️ Need at least 2 items for spread');
          plugin.app.toast('Need at least 2 items for spread operation');
          return;
        }

        const step = spreadRange / (numChecked - 1);
        console.log('   - Step size:', step);
        let currentIndex = 0;

        updatedRems = updatedRems.map(rem => {
          if (isInScope(rem) && rem.isChecked) {
            const newPriority = Math.round(spreadStart + (currentIndex * step));
            currentIndex++;
            return {
              ...rem,
              newIncPriority: rem.hasIncRem ? newPriority : null,
              newCardPriority: rem.hasCardPriority ? newPriority : null
            };
          }
          if (isInScope(rem)) return { ...rem, newIncPriority: null, newCardPriority: null };
          return rem;
        });
        break;
      }

      case 'adjust': {
        // Adjust maintains relative priorities within new range
        const allPriorities: number[] = [];
        checkedRems.forEach(r => {
          if (r.hasIncRem && r.currentIncPriority !== null) allPriorities.push(r.currentIncPriority);
          if (r.hasCardPriority && r.currentCardPriority !== null) allPriorities.push(r.currentCardPriority);
        });

        const minCurrent = Math.min(...allPriorities);
        const maxCurrent = Math.max(...allPriorities);
        const currentRange = maxCurrent - minCurrent || 1;

        const newRange = spreadEnd - spreadStart;
        console.log('   - Adjust: current range', currentRange, 'new range:', newRange);

        updatedRems = updatedRems.map(rem => {
          if (isInScope(rem) && rem.isChecked) {
            const newIncPriority = (rem.hasIncRem && rem.currentIncPriority !== null)
              ? Math.round(spreadStart + ((rem.currentIncPriority - minCurrent) / currentRange) * newRange)
              : null;
            const newCardPriority = (rem.hasCardPriority && rem.currentCardPriority !== null)
              ? Math.round(spreadStart + ((rem.currentCardPriority - minCurrent) / currentRange) * newRange)
              : null;
            return { ...rem, newIncPriority, newCardPriority };
          }
          if (isInScope(rem)) return { ...rem, newIncPriority: null, newCardPriority: null };
          return rem;
        });
        break;
      }
    }

    console.log('✅ BatchPriority: Calculated new priorities');
    setIncrementalRems(updatedRems);
    setIsPreviewMode(true);
    setHasCalculated(true);
  };

  // Apply the new priorities with progress indicator — filter-aware
  const applyChanges = async () => {
    console.log('💾 BatchPriority: Applying changes, hasActiveFilters:', hasActiveFilters);
    const scope = hasActiveFilters ? filteredRems : incrementalRems;
    const toUpdate = scope.filter(r => r.isChecked && (r.newIncPriority !== null || r.newCardPriority !== null));
    console.log('   - Rems to update:', toUpdate.length);

    if (toUpdate.length === 0) {
      console.log('   ⚠️ No changes to apply');
      await plugin.app.toast('No changes to apply');
      return;
    }

    setIsApplying(true);
    isApplyingRef.current = true;
    setTotalToApply(toUpdate.length);
    setAppliedCount(0);

    // Flag this session so events.ts's GlobalRemChanged ignores the chaotic property changes
    await plugin.storage.setSession('plugin_operation_active', true);

    try {
      // Phase 1: Update each rem's priority
      const t1 = performance.now();
      for (let i = 0; i < toUpdate.length; i++) {
        const remData = toUpdate[i];

        if (remData.hasIncRem && remData.newIncPriority !== null) {
          console.log(`   - Updating IncRem ${i + 1}/${toUpdate.length}: ${remData.name} to priority ${remData.newIncPriority}`);
          await remData.rem.setPowerupProperty(
            powerupCode,
            prioritySlotCode,
            [remData.newIncPriority.toString()]
          );
        }

        if (remData.hasCardPriority && remData.newCardPriority !== null) {
          console.log(`   - Updating CardPriority ${i + 1}/${toUpdate.length}: ${remData.name} to priority ${remData.newCardPriority}`);
          const source = (remData.cardPrioritySource === 'incremental' || remData.cardPrioritySource === 'manual')
            ? remData.cardPrioritySource
            : 'manual';
          await setCardPriority(plugin, remData.rem, remData.newCardPriority, source as any);
        }

        // Only update the progress bar every 10% (or on the last item) to avoid re-renders
        const progressStep = Math.max(1, Math.floor(toUpdate.length / 10));
        if ((i + 1) % progressStep === 0 || i === toUpdate.length - 1) {
          setAppliedCount(i + 1);
        }
      }
      console.log(`⏱️ Phase 1 (DB writes): ${Math.round(performance.now() - t1)}ms`);

      // Phase 2: Update the IncRem session cache in bulk (single write)
      const t2 = performance.now();
      console.log('📊 BatchPriority: Updating session storage for IncRems');
      const incRemsToUpdate = toUpdate.filter(r => r.hasIncRem && r.newIncPriority !== null);
      if (incRemsToUpdate.length > 0) {
        const currentIncCache = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
        for (const remData of incRemsToUpdate) {
          const index = currentIncCache.findIndex(r => r.remId === remData.remId);
          if (index !== -1) {
            // Update priority in-place without re-querying the rem
            currentIncCache[index] = { ...currentIncCache[index], priority: remData.newIncPriority! };
          }
        }
        await plugin.storage.setSession(allIncrementalRemKey, currentIncCache);
      }
      console.log(`⏱️ Phase 2 (IncRem cache sync): ${Math.round(performance.now() - t2)}ms`);

      // Phase 3: Delegate inheritance cascade to the persistent index widget
      // Popup widgets are killed on close, so we can't run long tasks here.
      // Instead, write the rem ID to session storage — the tracker in tracker.ts
      // will pick it up and run recalculateTreeInheritance in the background.
      // The plugin_operation_active flag stays UP until the tracker finishes.
      const capturedFocusedRemId = focusedRemId;
      if (capturedFocusedRemId) {
        console.log('📊 BatchPriority: Delegating inheritance cascade to background tracker...');
        await plugin.storage.setSession('pendingInheritanceCascade', capturedFocusedRemId);
      } else {
        await plugin.storage.setSession('plugin_operation_active', false);
      }

      // Flush the direct priority writes immediately (Phase 1+2 data)
      const { flushCacheUpdatesNow } = await import('../lib/card_priority/cache');
      await flushCacheUpdatesNow(plugin);

      console.log('✅ BatchPriority: Applied all changes (cascade delegated to background)');
      await plugin.app.toast(`Updated ${toUpdate.length} priorities. Inheritance cascade running in background...`);
      plugin.widget.closePopup();

    } catch (error) {
      console.error('❌ BatchPriority: Error applying changes:', error);
      await plugin.app.toast('Error applying changes');
      await plugin.storage.setSession('plugin_operation_active', false);
    } finally {
      setIsApplying(false);
      isApplyingRef.current = false;
    }
  };

  // Undo last operation
  const undoLastOperation = () => {
    if (previousStates.length > 0) {
      const prevState = previousStates[previousStates.length - 1];
      setIncrementalRems(prevState);
      setPreviousStates(prev => prev.slice(0, -1));
      setIsPreviewMode(false);
      setHasCalculated(false);
    }
  };

  // Export to CSV
  const exportToCSV = () => {
    const headers = ['Name', 'Inc Priority', 'Card Priority', 'New Inc Priority', 'New Card Priority', 'Card Source', 'Percentile', 'Type', 'Next Rep Date', 'Repetitions'];
    const rows = filteredRems.map(rem => [
      rem.name,
      rem.currentIncPriority ?? '',
      rem.currentCardPriority ?? '',
      rem.newIncPriority ?? '',
      rem.newCardPriority ?? '',
      rem.cardPrioritySource ?? '',
      (rem.incPercentile ?? rem.cardPercentile) || '',
      getDisplayType(rem.type),
      dayjs(rem.nextRepDate).format('YYYY-MM-DD'),
      rem.repetitions
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `batch-priorities-${dayjs().format('YYYY-MM-DD')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Toggle checkbox
  const toggleCheck = (remId: string) => {
    console.log('☑️ BatchPriority: Toggling checkbox for rem:', remId);
    setIncrementalRems(prev => prev.map(rem => {
      if (rem.remId === remId) {
        const newChecked = !rem.isChecked;
        // If unchecking and we're in preview mode, clear the new priority
        if (!newChecked && isPreviewMode) {
          return { ...rem, isChecked: newChecked, newIncPriority: null, newCardPriority: null };
        }
        return { ...rem, isChecked: newChecked };
      }
      return rem;
    }));
  };

  // Determine whether filters are active
  const hasActiveFilters = useMemo(() => {
    return searchTerm !== '' || typeFilter.length > 0 || priorityTypeFilter !== 'all' || sourceFilter !== 'all' || priorityRangeMin > 0 || priorityRangeMax < 100;
  }, [searchTerm, typeFilter, priorityTypeFilter, sourceFilter, priorityRangeMin, priorityRangeMax]);

  // Toggle all checkboxes — filter-aware
  const toggleAll = (checked: boolean) => {
    console.log('☑️ BatchPriority: Toggle all checkboxes to:', checked, 'hasActiveFilters:', hasActiveFilters);
    if (hasActiveFilters) {
      const filteredIds = new Set(filteredRems.map(r => r.remId));
      setIncrementalRems(prev => prev.map(rem => {
        if (!filteredIds.has(rem.remId)) return rem;
        return {
          ...rem,
          isChecked: checked,
          newIncPriority: checked ? rem.newIncPriority : null,
          newCardPriority: checked ? rem.newCardPriority : null
        };
      }));
    } else {
      setIncrementalRems(prev => prev.map(rem => ({
        ...rem,
        isChecked: checked,
        newIncPriority: checked ? rem.newIncPriority : null,
        newCardPriority: checked ? rem.newCardPriority : null
      })));
    }
  };

  // Toggle node expansion
  const toggleExpanded = (remId: string) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(remId)) {
        newSet.delete(remId);
      } else {
        newSet.add(remId);
      }
      return newSet;
    });
  };

  // Check if a node should be visible based on parent expansion
  const isNodeVisible = (remData: PrioritizedItemData) => {
    // Always show root level items
    if (remData.depth === 0) return true;

    // For hierarchical sorting, check if all parent nodes are expanded
    if (sortField === 'hierarchy') {
      // Check each ancestor in the path
      for (let i = 0; i < remData.pathIds.length - 1; i++) {
        const parentId = remData.pathIds[i];

        // An ancestor's expansion state only matters if it's also an incremental rem
        // that is being displayed in the table. We ignore intermediate non-incremental rems.
        const isParentInTable = incrementalRems.some(rem => rem.remId === parentId);

        if (isParentInTable && !expandedNodes.has(parentId)) {
          return false;
        }
      }
      return true;
    }

    // For non-hierarchical sorting, show all items
    return true;
  };

  // Check if a node has children - need to check incremental rems only
  const hasChildren = (remId: string) => {
    return incrementalRems.some(r => {
      // Check if this rem's path includes the given remId (but isn't the rem itself)
      // This properly identifies parent-child relationships
      const parentIndex = r.pathIds.indexOf(remId);
      return parentIndex >= 0 && parentIndex < r.pathIds.length - 1;
    });
  };

  // Handle sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Recalculate when item is re-checked in preview mode
  useEffect(() => {
    if (isPreviewMode && hasCalculated) {
      // Find any checked items without new priorities
      const needsRecalc = incrementalRems.some(r => r.isChecked && (
        (r.hasIncRem && r.newIncPriority === null) ||
        (r.hasCardPriority && r.newCardPriority === null)
      ));
      if (needsRecalc) {
        console.log('🔄 BatchPriority: Recalculating for newly checked items');
        calculateNewPriorities();
      }
    }
  }, [incrementalRems.map(r => r.isChecked).join(',')]);

  const uniqueIncTypes = useMemo(() => {
    const types = new Set(incrementalRems.filter(r => r.hasIncRem && r.type !== null).map(r => r.type));
    return Array.from(types);
  }, [incrementalRems]);

  const uniqueCardStatuses = useMemo(() => {
    const statuses = new Set(incrementalRems.filter(r => r.hasCardPriority && r.cardStatus !== null).map(r => r.cardStatus));
    return Array.from(statuses) as string[];
  }, [incrementalRems]);

  // Display type mapping for better readability
  const getDisplayType = (type: string): string => {
    const typeMap: Record<string, string> = {
      'pdf': 'PDF',
      'html': 'HTML',
      'youtube': 'YouTube',
      'youtube-highlight': 'Youtube Extract',
      'video': 'Video',
      'rem': 'Extract',
      'pdf-highlight': 'PDF Highlight',
      'html-highlight': 'HTML Highlight',
      'pdf-note': 'PDF Note',
      'unknown': 'Unknown'
    };
    return typeMap[type] || type;
  };

  // Styles using hard-coded colors like page-range.tsx
  const styles = {
    container: {
      height: '1150px',
      overflowY: 'auto' as const,
      backgroundColor: 'white',
      color: '#111827'
    },
    darkContainer: {
      backgroundColor: '#1f2937',
      color: '#f9fafb'
    },
    button: {
      padding: '8px 16px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      fontWeight: 500,
      transition: 'all 0.15s ease'
    },
    primaryButton: {
      backgroundColor: '#3b82f6',
      color: 'white'
    },
    secondaryButton: {
      backgroundColor: '#6b7280',
      color: 'white'
    },
    successButton: {
      backgroundColor: '#10b981',
      color: 'white'
    },
    dangerButton: {
      backgroundColor: '#ef4444',
      color: 'white'
    },
    input: {
      padding: '4px 8px',
      borderRadius: '4px',
      border: '1px solid #d1d5db',
      backgroundColor: 'white',
      color: '#111827'
    },
    darkInput: {
      backgroundColor: '#374151',
      border: '1px solid #4b5563',
      color: '#f9fafb'
    },
    tableHeader: {
      backgroundColor: '#f3f4f6',
      color: '#111827',
      padding: '8px',
      fontWeight: 600,
      fontSize: '14px'
    },
    darkTableHeader: {
      backgroundColor: '#374151',
      color: '#f9fafb'
    },
    tableRow: {
      borderTop: '1px solid #e5e7eb',
      padding: '8px',
      fontSize: '14px'
    },
    darkTableRow: {
      borderTop: '1px solid #4b5563'
    }
  };

  console.log('🎨 BatchPriority: Rendering UI');

  if (isLoading) {
    return <div style={{ padding: '16px' }}>Loading incremental rems...</div>;
  }

  if (errorMessage) {
    return (
      <div style={{ padding: '16px' }}>
        <div style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px', color: '#dc2626' }}>Error</div>
        <div style={{ fontSize: '14px', color: '#6b7280', marginBottom: '16px' }}>{errorMessage}</div>
        <button
          onClick={() => plugin.widget.closePopup()}
          style={{ ...styles.button, ...styles.secondaryButton }}
        >
          Close
        </button>
      </div>
    );
  }

  if (incrementalRems.length === 0 && allCardInfos !== undefined) {
    return (
      <div style={{ padding: '16px' }}>
        <div style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px' }}>No Prioritized Items Found</div>
        <div style={{ fontSize: '14px', color: '#6b7280' }}>
          The selected rem and its descendants contain no prioritized items (Incremental Rems or Flashcards with a Card Priority tag).
        </div>
        <button
          onClick={() => plugin.widget.closePopup()}
          style={{ ...styles.button, ...styles.secondaryButton, marginTop: '16px' }}
        >
          Close
        </button>
      </div>
    );
  }

  // Card info cache is still hydrating — keep showing the loading spinner
  if (incrementalRems.length === 0 && allCardInfos === undefined) {
    return <div style={{ padding: '16px' }}>Loading incremental rems...</div>;
  }

  return (
    <div style={styles.container}>
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ fontSize: '24px', fontWeight: 'bold' }}>Batch Priority Change</div>

        {/* Search and Filters Bar */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search by name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ ...styles.input, flex: '1', minWidth: '200px' }}
          />

          <select
            multiple
            size={3}
            value={typeFilter.length === 0 ? ['all'] : typeFilter}
            onChange={(e) => {
              const options = Array.from(e.target.selectedOptions, option => option.value);
              // If 'all' was just selected, or if we deselected everything
              if (options.includes('all') || options.length === 0) {
                setTypeFilter([]);
              } else {
                setTypeFilter(options);
              }
            }}
            style={{ ...styles.input, height: 'auto', minHeight: '100px', padding: '4px' }}
          >
            <option value="all">All Types (Cmd+Click to select multiple)</option>
            {uniqueIncTypes.length > 0 && (
              <optgroup label="Incremental Rems">
                {uniqueIncTypes.map(type => (
                  <option key={type} value={type}>{getDisplayType(type)}</option>
                ))}
              </optgroup>
            )}
            {uniqueCardStatuses.length > 0 && (
              <optgroup label="Card Priorities">
                {uniqueCardStatuses.includes('Has Cards') && <option value="has-cards">Has Cards</option>}
                {uniqueCardStatuses.includes('Inheritance only') && <option value="inheritance-only">Inheritance only</option>}
              </optgroup>
            )}
          </select>

          <select
            value={priorityTypeFilter}
            onChange={(e) => setPriorityTypeFilter(e.target.value as 'all' | 'incRem' | 'cardPriority')}
            style={styles.input}
          >
            <option value="all">IncRems and Cards</option>
            <option value="incRem">Inc Priority</option>
            <option value="cardPriority">Card Priority</option>
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            style={styles.input}
          >
            <option value="all">All Sources</option>
            <option value="manual">Manual CV</option>
            <option value="incremental">Incremental CV</option>
          </select>

          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <label style={{ fontSize: '12px' }}>Priority:</label>
            <input
              type="number"
              min="0"
              max="100"
              value={priorityRangeMin}
              onChange={(e) => setPriorityRangeMin(Number(e.target.value))}
              style={{ ...styles.input, width: '60px' }}
            />
            <span>-</span>
            <input
              type="number"
              min="0"
              max="100"
              value={priorityRangeMax}
              onChange={(e) => setPriorityRangeMax(Number(e.target.value))}
              style={{ ...styles.input, width: '60px' }}
            />
          </div>

          <button
            onClick={exportToCSV}
            style={{ ...styles.button, backgroundColor: '#8b5cf6', color: 'white' }}
          >
            Export CSV
          </button>
        </div>

        {/* Operation Selection */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', backgroundColor: '#f9fafb' }}>
          <div style={{ fontWeight: 600, marginBottom: '8px' }}>Priority Operation</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }
          }>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="increase"
                  checked={operation === 'increase'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Increase Priority</span>
              </label>
              {operation === 'increase' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Change %: </label>
                  <input
                    type="number"
                    min="1"
                    max="99"
                    value={changePercent}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(99, Number(e.target.value) || 1));
                      setChangePercent(val);
                    }}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '80px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Multiply by {changePercent / 100} (lower value = higher priority)
                    <br />
                    <span style={{ color: '#3b82f6' }}>Valid range: 1-99%</span>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="decrease"
                  checked={operation === 'decrease'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Decrease Priority</span>
              </label>
              {operation === 'decrease' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Change %: </label>
                  <input
                    type="number"
                    min="101"
                    max="1000"
                    value={decreasePercent}
                    onChange={(e) => {
                      // Allow typing without immediate validation
                      const inputVal = e.target.value;
                      if (inputVal === '') {
                        setDecreasePercent(101);
                      } else {
                        setDecreasePercent(Number(inputVal));
                      }
                    }}
                    onBlur={(e) => {
                      // Apply validation only on blur
                      const val = Math.max(101, Math.min(1000, Number(e.target.value) || 101));
                      setDecreasePercent(val);
                    }}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '80px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Multiply by {decreasePercent / 100} (higher value = lower priority)
                    <br />
                    <span style={{ color: '#3b82f6' }}>Valid range: 101-1000%</span>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="spread"
                  checked={operation === 'spread'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Spread Evenly</span>
              </label>
              {operation === 'spread' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Range: </label>
                  <input
                    type="number"
                    min="0"
                    max="99"
                    value={spreadStart}
                    onChange={(e) => setSpreadStart(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <span> to </span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={spreadEnd}
                    onChange={(e) => setSpreadEnd(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Distribute evenly across range
                  </div>
                </div>
              )}
            </div>

            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="adjust"
                  checked={operation === 'adjust'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Adjust Proportionally</span>
              </label>
              {operation === 'adjust' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Range: </label>
                  <input
                    type="number"
                    min="0"
                    max="99"
                    value={spreadStart}
                    onChange={(e) => setSpreadStart(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <span> to </span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={spreadEnd}
                    onChange={(e) => setSpreadEnd(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Maintain relative priorities
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Control Buttons */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            onClick={() => toggleAll(true)}
            style={{ ...styles.button, ...styles.primaryButton }}
          >
            {hasActiveFilters ? 'Check All Filtered' : 'Check All'}
          </button>
          <button
            onClick={() => toggleAll(false)}
            style={{ ...styles.button, ...styles.secondaryButton }}
          >
            {hasActiveFilters ? 'Uncheck All Filtered' : 'Uncheck All'}
          </button>

          {previousStates.length > 0 && (
            <button
              onClick={undoLastOperation}
              style={{ ...styles.button, backgroundColor: '#f59e0b', color: 'white' }}
            >
              Undo ({previousStates.length})
            </button>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            {!isPreviewMode && (
              <button
                onClick={calculateNewPriorities}
                style={{ ...styles.button, ...styles.primaryButton }}
              >
                {hasActiveFilters ? 'Preview Filtered' : 'Preview Changes'}
              </button>
            )}
            {isPreviewMode && (
              <>
                <button
                  onClick={() => {
                    console.log('🔄 BatchPriority: Resetting preview mode');
                    setIsPreviewMode(false);
                    setHasCalculated(false);
                    setIncrementalRems(prev => prev.map(r => ({ ...r, newIncPriority: null, newCardPriority: null })));
                  }}
                  style={{ ...styles.button, ...styles.secondaryButton }}
                >
                  Reset
                </button>
                <button
                  onClick={applyChanges}
                  style={{ ...styles.button, ...styles.successButton }}
                  disabled={isApplying}
                >
                  {isApplying ? `Applying... (${appliedCount}/${totalToApply})` : (hasActiveFilters ? 'Apply to Filtered' : 'Accept and Apply')}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        {isApplying && (
          <div style={{ width: '100%', backgroundColor: '#e5e7eb', borderRadius: '4px', height: '20px' }}>
            <div
              style={{
                width: `${(appliedCount / totalToApply) * 100}%`,
                backgroundColor: '#3b82f6',
                height: '100%',
                borderRadius: '4px',
                transition: 'width 0.3s ease'
              }}
            />
          </div>
        )}

        {/* Table */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden', flex: 1 }}>
          {/* Table Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 80px 80px 80px 120px 120px 60px', ...styles.tableHeader }}>
            <div style={{ padding: '8px' }}>✓</div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('hierarchy')}>
              Name {sortField === 'hierarchy' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('currentPriority')}>
              Current {sortField === 'currentPriority' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('newPriority')}>
              New {sortField === 'newPriority' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('percentile')}>
              % {sortField === 'percentile' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('type')}>
              Type {sortField === 'type' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('nextRepDate')}>
              Next Rep {sortField === 'nextRepDate' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('repetitions')}>
              Reps {sortField === 'repetitions' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
          </div>

          {/* Table Body */}
          <div style={{ maxHeight: '550px', overflowY: 'auto' }}>
            {filteredRems.map((remData) => {
              if (!isNodeVisible(remData)) return null;

              const hasChildNodes = hasChildren(remData.remId);
              const isExpanded = expandedNodes.has(remData.remId);
              const incColor = remData.incPercentile ? percentileToHslColor(remData.incPercentile) : 'transparent';
              const cardColor = remData.cardPercentile ? percentileToHslColor(remData.cardPercentile) : 'transparent';

              return (
                <div
                  key={remData.remId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '40px 1fr 80px 80px 80px 120px 120px 60px',
                    ...styles.tableRow,
                    paddingLeft: sortField === 'hierarchy' ? `${remData.depth * 20 + 8}px` : '8px'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div style={{ padding: '8px' }}>
                    <input
                      type="checkbox"
                      checked={remData.isChecked}
                      onChange={() => toggleCheck(remData.remId)}
                    />
                  </div>
                  <div style={{ padding: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {sortField === 'hierarchy' && hasChildNodes && (
                      <button
                        onClick={() => toggleExpanded(remData.remId)}
                        style={{ fontSize: '12px', padding: '0 4px', background: 'none', border: 'none', cursor: 'pointer' }}
                      >
                        {isExpanded ? '▼' : '▶'}
                      </button>
                    )}
                    <span style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '300px',
                      display: 'inline-block'
                    }} title={remData.name}>
                      {remData.name.length > 50 ? remData.name.substring(0, 50) + '...' : remData.name}
                    </span>
                  </div>
                  <div style={{ padding: '8px', fontWeight: 600, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {remData.hasIncRem && remData.currentIncPriority !== null && (
                      <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#e0f2fe', color: '#0369a1', whiteSpace: 'nowrap' }}>
                        Inc: {remData.currentIncPriority}
                      </span>
                    )}
                    {remData.hasCardPriority && remData.currentCardPriority !== null && (
                      <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#fef3c7', color: '#92400e', whiteSpace: 'nowrap' }}>
                        Card: {remData.currentCardPriority}
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {remData.newIncPriority !== null && (
                      <span
                        style={{
                          fontWeight: 600, fontSize: '12px',
                          color: (remData.newIncPriority ?? 0) < (remData.currentIncPriority ?? 100) ? '#ef4444' : '#10b981'
                        }}
                      >
                        {remData.newIncPriority}
                      </span>
                    )}
                    {remData.newCardPriority !== null && (
                      <span
                        style={{
                          fontWeight: 600, fontSize: '12px',
                          color: (remData.newCardPriority ?? 0) < (remData.currentCardPriority ?? 100) ? '#ef4444' : '#10b981'
                        }}
                      >
                        {remData.newCardPriority}
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                    {remData.incPercentile !== null && (
                      <span
                        style={{
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          color: 'white',
                          backgroundColor: incColor,
                          display: 'inline-block',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {remData.incPercentile !== null && remData.cardPercentile !== null ? `Inc: ${Math.round(remData.incPercentile)}` : remData.incPercentile}%
                      </span>
                    )}
                    {remData.cardPercentile !== null && (
                      <span
                        style={{
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          color: 'white',
                          backgroundColor: cardColor,
                          display: 'inline-block',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {remData.incPercentile !== null && remData.cardPercentile !== null ? `Card: ${Math.round(remData.cardPercentile)}` : remData.cardPercentile}%
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '8px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {remData.hasIncRem && (
                      <div style={{ whiteSpace: 'nowrap' }}>
                        {remData.hasIncRem && remData.hasCardPriority && <span style={{ color: '#6b7280', fontSize: '10px' }}>Inc: </span>}
                        {getDisplayType(remData.type)}
                      </div>
                    )}
                    {remData.hasCardPriority && remData.cardStatus && (
                      <div style={{ whiteSpace: 'nowrap' }}>
                        {remData.hasIncRem && remData.hasCardPriority && <span style={{ color: '#6b7280', fontSize: '10px' }}>Card: </span>}
                        {remData.cardStatus}
                      </div>
                    )}
                    {!remData.hasIncRem && !remData.hasCardPriority && (
                      <div style={{ whiteSpace: 'nowrap' }}>
                        {getDisplayType(remData.type)}
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '8px', fontSize: '12px' }}>
                    {remData.hasIncRem && remData.nextRepDate ? dayjs(remData.nextRepDate).format('MMM D, YY') : '-'}
                  </div>
                  <div style={{ padding: '8px', fontSize: '12px' }}>
                    {remData.hasIncRem ? remData.repetitions : '-'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Summary */}
        <div style={{ fontSize: '14px', color: '#6b7280', display: 'flex', justifyContent: 'space-between' }}>
          <span>
            Total: {incrementalRems.length} incremental rem(s) |
            Filtered: {filteredRems.length} |
            Selected: {incrementalRems.filter(r => r.isChecked).length}
          </span>
          <span>
            {searchTerm && `Searching for: "${searchTerm}"`}
            {typeFilter.length > 0 && ` | Type: Multiple Selected`}
            {(priorityRangeMin > 0 || priorityRangeMax < 100) && ` | Priority: ${priorityRangeMin}-${priorityRangeMax}`}
          </span>
        </div>
      </div>
    </div>
  );
}

// Helper function with IDs for proper hierarchy tracking - including focused rem as root
async function getRemPathWithIds(plugin: RNPlugin, rem: PluginRem, stopAtId: string): Promise<{ path: string[], pathIds: string[] }> {
  console.log('🛤️ Getting path for rem:', rem._id, 'stopping at:', stopAtId);
  const path: string[] = [];
  const pathIds: string[] = [];
  let current: PluginRem | undefined = rem;

  // If this IS the focused rem, just return its own info
  if (current._id === stopAtId) {
    const text = current.text ? await safeRemTextToString(plugin, current.text) : 'Untitled';
    return { path: [text], pathIds: [current._id] };
  }

  // Build path from current up to (but not including) the focused rem
  while (current) {
    const text = current.text ? await safeRemTextToString(plugin, current.text) : 'Untitled';
    path.unshift(text);
    pathIds.unshift(current._id);

    // Stop if we've reached the focused rem
    if (current._id === stopAtId) {
      break;
    }

    // If no parent or parent would go beyond focused rem, stop
    if (!current.parent) {
      break;
    }

    // Check if the parent is an ancestor of the focused rem
    // This ensures we include intermediate non-incremental rems in the path
    current = await plugin.rem.findOne(current.parent);
  }

  console.log('   - Path:', path);
  console.log('   - Path IDs:', pathIds);
  return { path, pathIds };
}

console.log('✅ BatchPriority: Widget module loaded');

renderWidget(BatchPriority);
