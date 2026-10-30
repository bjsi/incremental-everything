import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  renderWidget,
  useSyncedStorageState,
  Queue,
  usePlugin,
  useTrackerPlugin,
  QueueInteractionScore,
} from "@remnote/plugin-sdk";
import '../style.css';
import '../App.css';
import { MasteryDrillCardList } from '../components/MasteryDrillCardList';
import { MasteryDrillHeader } from '../components/MasteryDrillHeader';
import { MasteryDrillCardEditor, MasteryDrillConfirm, MasteryDrillLowPriority } from '../components/MasteryDrillPanels';
import { getCardPriority, setCardPriority } from '../lib/card_priority';
import { useIESetting } from '../lib/settings';
import { oldItemThresholdId } from '../lib/consts';
import { FinalDrillItem, isDrillItemInKb } from '../lib/mastery_drill_audit';
import { clearDrillForKb, clearOldDrillItems, markDrillCardEditLater, removeFromDrill } from '../lib/mastery_drill_actions';
import { formatDrillWait, summarizeDrill } from '../lib/mastery_drill_cooling';
import { useDrillCooling } from '../lib/mastery_drill_status';

/** Longest single wait before re-checking the cooling cards: setTimeout overflows past ~24.8 days. */
const MAX_RECHECK_MS = 60 * 60 * 1000;

function FinalDrill() {
  const plugin = usePlugin();
  const [finalDrillIdsRaw] = useSyncedStorageState<FinalDrillItem[]>("finalDrillIds", []);

  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const [filteredIds, setFilteredIds] = useState<string[]>([]);
  // Every item of this KB, cooling or not — what the card list shows.
  const [kbItems, setKbItems] = useState<FinalDrillItem[]>([]);
  const [delayedCount, setDelayedCount] = useState<number>(0);
  const [oldItemsCount, setOldItemsCount] = useState<number>(0);
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const oldItemThreshold = useIESetting(oldItemThresholdId);
  const cooling = useDrillCooling();
  const [firstReadyAt, setFirstReadyAt] = useState<number | undefined>();

  const [showClearOldConfirm, setShowClearOldConfirm] = useState(false);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);

  const [showClearLowPriorityView, setShowClearLowPriorityView] = useState(false);

  const currentCardData = useTrackerPlugin(async (rp) => {
    const cardId = await rp.storage.getSession<string>("finalDrillCurrentCardId");
    if (!cardId) return null;
    const card = await rp.card.findOne(cardId);
    if (!card?.remId) return null;
    const rem = await rp.rem.findOne(card.remId);
    if (!rem) return null;
    const priority = await getCardPriority(rp, rem);
    return { remId: card.remId, priority };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function updateDerivedState() {
      const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
      const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
      const currentKbId = currentKb._id;

      const { kbItems: relevantItems, readyIds: activeIds, coolingCount: delayed, oldCount, firstReadyAt: earliestUnblock } =
        summarizeDrill(finalDrillIdsRaw, (item) => isDrillItemInKb(item, currentKbId, isPrimary), cooling, oldItemThreshold, Date.now());

      if (!cancelled) {
        setFilteredIds(activeIds);
        setKbItems(relevantItems);
        setDelayedCount(delayed);
        setOldItemsCount(oldCount);
        setFirstReadyAt(earliestUnblock);
        setIsLoaded(true);

        // Schedule a recheck when the first delayed card becomes available
        clearTimeout(recheckTimerRef.current);
        if (delayed > 0 && earliestUnblock !== undefined) {
          const msUntilUnblock = earliestUnblock - Date.now() + 500;
          recheckTimerRef.current = setTimeout(() => {
            if (!cancelled) updateDerivedState();
          }, Math.min(Math.max(msUntilUnblock, 1000), MAX_RECHECK_MS));
        }
      }
    }

    if (plugin) updateDerivedState();
    return () => {
      cancelled = true;
      clearTimeout(recheckTimerRef.current);
    };
  }, [finalDrillIdsRaw, plugin, oldItemThreshold, cooling]);

  // --- Resurrection guard ---------------------------------------------------------------
  // RemNote's embedded <Queue> snapshots `cardIds` when its controller is built (QueueMain does
  // `useState(() => new QueueController(..., {...props}, ...))`), so later prop updates never
  // reach it. Worse: when that queue runs dry it clears its internal `usedCards` set and reloads
  // the ORIGINAL snapshot. That is why a card taken out with "Remove from Drill" (or Edit Later,
  // or rated Good) reappears later in the same session no matter how many times you remove it —
  // removeCurrentCardFromQueue does drop it from the live queue, but the reload puts it back.
  //
  // The snapshot cannot be updated in place, so instead:
  //   1. we freeze the list ourselves (queueCardIds) so our copy matches the controller's exactly;
  //   2. anything in that snapshot which has since left the drill list is "stale" and gets skipped
  //      the moment RemNote presents it again;
  //   3. if the whole reloaded snapshot is stale, skipping alone would loop forever, so after a
  //      few consecutive skips we remount the embed (queueEpoch) — remounting is the only way to
  //      hand the controller a fresh card list. That fires QueueEnter again, so queue_session.ts
  //      closes the drill session and opens a new one; that is expected, not a leak.
  //
  // Stale is derived as "snapshot minus live list" rather than "not in the live list" on purpose:
  // a cluster anchor that was never in the drill list is never in the snapshot either, so it can
  // never be skipped by mistake. See the Card Cluster note on removeCurrentFromDrill below.
  const MAX_CONSECUTIVE_SKIPS = 3;
  // Traces one line per card load. Off by default: the two paths that act (skip, rebuild) log
  // unconditionally, so a resurrection still leaves a record without this. Flip it to true to
  // watch the guard's bookkeeping on every card — stale/snapshot/live counts — when validating
  // a change to it.
  const DRILL_GUARD_DEBUG = false;
  const [queueCardIds, setQueueCardIds] = useState<string[] | null>(null);
  const [queueEpoch, setQueueEpoch] = useState(0);
  const consecutiveSkipsRef = useRef(0);
  const lastSkippedIdRef = useRef<string | null>(null);

  // Seed (and after a rebuild, re-seed) the frozen list the embedded Queue is mounted with.
  useEffect(() => {
    if (!isLoaded) return;
    if (filteredIds.length === 0) {
      if (queueCardIds !== null) setQueueCardIds(null);
      return;
    }
    if (queueCardIds === null) setQueueCardIds(filteredIds);
  }, [isLoaded, filteredIds, queueCardIds]);

  const staleQueueIds = useMemo(() => {
    if (!queueCardIds) return new Set<string>();
    const live = new Set(filteredIds);
    return new Set(queueCardIds.filter((id) => !live.has(id)));
  }, [queueCardIds, filteredIds]);

  // Read through a ref, so the guard below evaluates staleness once per card load rather than
  // re-running whenever the list changes. That distinction matters: a card you just rated Good
  // leaves the list while it is still the current card, and re-evaluating then would skip
  // whatever card the queue had already moved on to.
  const staleQueueIdsRef = useRef(staleQueueIds);
  useEffect(() => {
    staleQueueIdsRef.current = staleQueueIds;
  }, [staleQueueIds]);

  // Same reason: the guard must not re-run when the list changes, so it reads the count through
  // a ref rather than closing over it.
  const filteredIdsRef = useRef(filteredIds);
  useEffect(() => {
    filteredIdsRef.current = filteredIds;
  }, [filteredIds]);

  const currentDrillCardId = useTrackerPlugin(
    async (rp) => (await rp.storage.getSession<string>('finalDrillCurrentCardId')) ?? null,
    []
  );

  useEffect(() => {
    if (!currentDrillCardId || !queueCardIds) {
      if (DRILL_GUARD_DEBUG && currentDrillCardId) {
        console.log(`[MasteryDrill] guard: card ${currentDrillCardId} loaded while the queue is being rebuilt — standing by.`);
      }
      return;
    }

    if (DRILL_GUARD_DEBUG) {
      console.log(
        `[MasteryDrill] guard: card ${currentDrillCardId} loaded — stale=${staleQueueIdsRef.current.has(currentDrillCardId)}, snapshot=${queueCardIds.length}, live=${filteredIdsRef.current.length}, staleInSnapshot=${staleQueueIdsRef.current.size}`
      );
    }

    if (!staleQueueIdsRef.current.has(currentDrillCardId)) {
      consecutiveSkipsRef.current = 0;
      lastSkippedIdRef.current = null;
      return;
    }
    if (lastSkippedIdRef.current === currentDrillCardId) return;
    lastSkippedIdRef.current = currentDrillCardId;

    consecutiveSkipsRef.current += 1;
    const skips = consecutiveSkipsRef.current;

    if (skips > MAX_CONSECUTIVE_SKIPS) {
      console.log(
        `[MasteryDrill] ${MAX_CONSECUTIVE_SKIPS} stale cards in a row — the embedded queue reloaded its original card list. Rebuilding it from the current drill list (${filteredIdsRef.current.length} card${filteredIdsRef.current.length !== 1 ? 's' : ''}).`
      );
      consecutiveSkipsRef.current = 0;
      lastSkippedIdRef.current = null;
      setQueueCardIds(null);
      setQueueEpoch((e) => e + 1);
      return;
    }

    (async () => {
      try {
        // Confirm against RemNote's live controller before acting: if the queue has already moved
        // past this card, removeCurrentCardFromQueue would drop an unrelated (unseen) card.
        const live = await plugin.queue.getCurrentCard();
        if (live?._id !== currentDrillCardId) {
          if (DRILL_GUARD_DEBUG) {
            console.log(`[MasteryDrill] guard: queue already moved past ${currentDrillCardId} (now ${live?._id ?? 'none'}) — not skipping.`);
          }
          return;
        }
        console.log(
          `[MasteryDrill] Card ${currentDrillCardId} is no longer in the drill (or is cooling) but was presented again — skipping it (${skips}/${MAX_CONSECUTIVE_SKIPS}).`
        );
        await plugin.queue.removeCurrentCardFromQueue(false);
      } catch (error) {
        console.error('[MasteryDrill] Failed to skip a stale card:', error);
      }
    })();
  }, [currentDrillCardId, queueCardIds, plugin]);

  const clearOldItems = async () => {
    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    await clearOldDrillItems(plugin, currentKb._id, cooling, oldItemThreshold);
    setShowClearOldConfirm(false);
  };

  const clearAllItems = async () => {
    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
    await clearDrillForKb(plugin, currentKb._id, isPrimary);
    setShowClearAllConfirm(false);
  };

  const [editingRemId, setEditingRemId] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  const startEditing = async (which: 'current' | 'previous') => {
    const key = which === 'current' ? "finalDrillCurrentCardId" : "finalDrillPreviousCardId";
    const cardId = await plugin.storage.getSession<string>(key);
    if (!cardId) {
      await plugin.app.toast(`No ${which} card found to edit.`);
      return;
    }
    const card = await plugin.card.findOne(cardId);
    if (card && card.remId) {
      setEditingRemId(card.remId);
      setEditingCardId(cardId);
    } else {
      await plugin.app.toast(`Could not find Rem for card ${cardId}`);
    }
  };

  const editLaterEditing = async (message: string) => {
    if (!editingCardId || !(await markDrillCardEditLater(plugin, editingCardId, message))) return;
    await plugin.app.toast("Card marked for Edit Later and removed from drill.");
    setEditingRemId(null);
    setEditingCardId(null);
  };

  const editLaterCurrent = async (message: string) => {
    const cardId = await plugin.storage.getSession<string>("finalDrillCurrentCardId");
    if (!cardId) { await plugin.app.toast("No current card found."); return; }
    if (!(await markDrillCardEditLater(plugin, cardId, message))) return;
    await plugin.queue.removeCurrentCardFromQueue(false);
    await plugin.app.toast("Card marked for Edit Later and removed from drill.");
  };

  // KNOWN LIMITATION — Card Clusters.
  // Every per-card toolbar action above (Go to Rem, Edit Later, Edit Current, the priority
  // badge) and this one resolve the target through `finalDrillCurrentCardId`, which
  // queue_session.ts writes from QueueLoadCard. Inside a cluster that id is the cluster
  // ANCHOR and never advances to the visible sibling, so on siblings 2..n these actions act
  // on the wrong card: Remove from Drill drops the anchor's id (usually not even in the drill
  // list) while the sibling stays, and the card keeps coming back.
  //
  // Measured 2026-09-05 against RemNote's own queue controller, in a document sub-queue with a
  // 4-sibling table cluster: `window.queueController.currentCard.cardId` (what
  // plugin.queue.getCurrentCard() resolves, and what QueueLoadCard broadcasts) stayed pinned to
  // the anchor for all four siblings, while the cluster component's own
  // `state.currentCompoundCardIdToTest` advanced each time. So getCurrentCard() is NOT a way out.
  // The `clusterVisibleCardId` bridge (card_info_bar.tsx) does not exist here either — that
  // widget is not mounted inside the drill popup. See registerDrillCardRatingListener in
  // register/events.ts for the matching gap on the recording side.
  //
  // Left unfixed deliberately: clusters reaching the drill is already rare (see events.ts), and
  // the cost of a wrong-card action is one stale card in the list, not data loss.
  const removeCurrentFromDrill = async () => {
    const cardId = await plugin.storage.getSession<string>("finalDrillCurrentCardId");
    if (!cardId) {
      await plugin.app.toast("No current card found.");
      return;
    }
    await removeFromDrill(plugin, [cardId]);
    await plugin.queue.removeCurrentCardFromQueue(false);
    await plugin.app.toast("Card removed from Mastery Drill.");
  };

  const goToRem = async (remId: string) => {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;
    await plugin.window.openRem(rem);
    await plugin.storage.setSession("finalDrillResumeTrigger", Date.now());
    await plugin.widget.closePopup();
  };

  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTimeout(() => containerRef.current?.focus(), 100);
  }, []);

  // The card list replaces the queue area while the queue itself stays mounted off-screen, so
  // the window-level rating keys below must stand down while it is open — otherwise ←/→ in the
  // list would move the hidden queue.
  // The other panels unmount the queue, and their own keys (←/→, Enter) must not reach it either.
  const [showCardList, setShowCardList] = useState(false);
  const panelOpen = showCardList || !!editingRemId || showClearOldConfirm || showClearAllConfirm || showClearLowPriorityView;
  const panelOpenRef = useRef(false);
  useEffect(() => {
    panelOpenRef.current = panelOpen;
  }, [panelOpen]);

  const closeCardList = () => {
    setShowCardList(false);
    setTimeout(() => containerRef.current?.focus(), 50);
  };

  const removeCardsFromDrill = async (cardIds: string[]) => {
    const ids = new Set(cardIds);
    await removeFromDrill(plugin, ids);
    // The queue behind the list keeps showing a removed card until it is rated; take it out now.
    const currentId = await plugin.storage.getSession<string>("finalDrillCurrentCardId");
    if (currentId && ids.has(currentId)) {
      const live = await plugin.queue.getCurrentCard();
      if (live?._id === currentId) await plugin.queue.removeCurrentCardFromQueue(false);
    }
    await plugin.app.toast(`Removed ${cardIds.length} card${cardIds.length !== 1 ? 's' : ''} from Mastery Drill.`);
  };

  const cardListView = showCardList && (
    <MasteryDrillCardList
      items={kbItems}
      cooling={cooling}
      onRemove={removeCardsFromDrill}
      onGoToRem={goToRem}
      onClose={closeCardList}
    />
  );

  const listCardsButton = (
    <button
      onClick={() => setShowCardList(true)}
      className="text-xs px-2 py-1 rounded whitespace-nowrap"
      style={{
        color: 'var(--rn-clr-content-primary)',
        border: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-primary)',
      }}
      title="List every card in the drill and check whether RemNote can show it (L)"
    >
      List Cards
    </button>
  );

  useEffect(() => {
    const SCORE_MAP: Record<string, QueueInteractionScore> = {
      '1': QueueInteractionScore.AGAIN,
      '2': QueueInteractionScore.HARD,
      '3': QueueInteractionScore.GOOD,
      ' ': QueueInteractionScore.GOOD,
      '4': QueueInteractionScore.EASY,
    };

    const handler = async (e: KeyboardEvent) => {
      if (panelOpenRef.current) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShowCardList(true);
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        await plugin.queue.goBackToPreviousCard();
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        await plugin.queue.removeCurrentCardFromQueue(true);
        return;
      }

      const score = SCORE_MAP[e.key];
      if (score === undefined) return;
      e.preventDefault();

      const revealed = await plugin.queue.hasRevealedAnswer();
      if (!revealed) {
        await plugin.queue.showAnswer();
      } else {
        await plugin.queue.rateCurrentCard(score);
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [plugin]);

  // Signal active state for queue_session.ts to set scopeName = "Mastery Drill"
  useEffect(() => {
    plugin.storage.setSession("finalDrillActive", true);
    const heartbeatInterval = setInterval(() => {
      plugin.storage.setSession("finalDrillHeartbeat", Date.now());
    }, 2000);

    return () => {
      clearInterval(heartbeatInterval);
      plugin.storage.setSession("finalDrillActive", false);
    };
  }, [plugin]);

  if (editingRemId) {
    return (
      <MasteryDrillCardEditor
        remId={editingRemId}
        onEditLater={editLaterEditing}
        onGoToRem={() => goToRem(editingRemId)}
        onDone={() => {
          setEditingRemId(null);
          setTimeout(() => containerRef.current?.focus(), 50);
        }}
      />
    );
  }

  if (showClearOldConfirm) {
    return (
      <MasteryDrillConfirm
        title="Clear Old Items?"
        message={`This will remove ${oldItemsCount} items that have been ready to drill for more than ${oldItemThreshold} days. ${kbItems.length - oldItemsCount} items will remain.`}
        confirmLabel="Clear Old Items"
        onConfirm={clearOldItems}
        onCancel={() => setShowClearOldConfirm(false)}
      />
    );
  }

  if (showClearAllConfirm) {
    return (
      <MasteryDrillConfirm
        title="Clear Mastery Drill Queue?"
        message={`This will remove all ${kbItems.length} items from the Mastery Drill queue for this Knowledge Base.`}
        confirmLabel="Clear All"
        onConfirm={clearAllItems}
        onCancel={() => setShowClearAllConfirm(false)}
      />
    );
  }

  if (showClearLowPriorityView) {
    return (
      <MasteryDrillLowPriority
        items={kbItems}
        onRemove={async (cardIds) => {
          await removeFromDrill(plugin, cardIds);
          setShowClearLowPriorityView(false);
        }}
        onBack={() => setShowClearLowPriorityView(false)}
      />
    );
  }

  if (filteredIds.length === 0) {
    const isCoolingDown = delayedCount > 0;
    if (showCardList) {
      return <div className="h-full w-full flex flex-col">{cardListView}</div>;
    }
    return (
      <div
        ref={containerRef}
        tabIndex={-1}
        className="h-full w-full flex flex-col items-center justify-center text-center"
        style={{
          backgroundColor: 'var(--rn-clr-background-primary)',
          color: 'var(--rn-clr-content-primary)',
        }}
      >
        {isCoolingDown ? (
          <>
            <h3 className="text-lg font-bold mb-2">All Cards Cooling Down</h3>
            <p className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              {delayedCount} card{delayedCount !== 1 ? 's are' : ' is'} waiting out a delay before appearing here again
              {firstReadyAt !== undefined ? ` — the first in ${formatDrillWait(firstReadyAt - Date.now())}` : ''}.
            </p>
            <p className="text-xs mt-2" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              The drill will refresh automatically when the first card is ready.
            </p>
            <div className="mt-4">{listCardsButton}</div>
          </>
        ) : (
          <>
            <h3 className="text-lg font-bold mb-2">Mastery Drill Queue Empty</h3>
            <p className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              No cards are currently in the Mastery Drill queue for this Knowledge Base.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="h-full w-full flex flex-col relative focus:outline-none"
    >
      <MasteryDrillHeader
        variant="popup"
        readyCount={filteredIds.length}
        coolingCount={delayedCount}
        firstReadyAt={firstReadyAt}
        oldCount={oldItemsCount}
        oldThreshold={oldItemThreshold}
        onOpenCardList={() => setShowCardList(true)}
        onClearAll={() => setShowClearAllConfirm(true)}
        onClearLowPriority={() => setShowClearLowPriorityView(true)}
        onClearOld={() => setShowClearOldConfirm(true)}
        onRemoveCurrent={removeCurrentFromDrill}
        cardActions={{
          priority: currentCardData?.priority
            ? {
                info: currentCardData.priority,
                onSave: async (value) => {
                  const rem = await plugin.rem.findOne(currentCardData.remId);
                  if (rem) await setCardPriority(plugin, rem, value, 'manual', false, { event: 'drill' });
                },
              }
            : null,
          onGoToRem: async () => {
            const cardId = await plugin.storage.getSession<string>("finalDrillCurrentCardId");
            if (!cardId) return;
            const card = await plugin.card.findOne(cardId);
            if (card?.remId) await goToRem(card.remId);
          },
          onEditLater: editLaterCurrent,
          onEditPrevious: () => startEditing('previous'),
          onEditCurrent: () => startEditing('current'),
        }}
        showDescription
      />

      <div
        className="flex-grow relative min-h-0 overflow-hidden"
        // Collapsed while the card list takes its place (the Queue inside is moved off-screen).
        style={showCardList ? { flex: '0 0 0px' } : undefined}
        onMouseDown={() => {
          // After a click inside the Queue embed the iframe may steal focus.
          // Re-focus our container so the window-level keydown listener keeps working.
          setTimeout(() => containerRef.current?.focus(), 50);
        }}
      >
        {isLoaded && queueCardIds ? (
          // key={queueEpoch}: the only way to give the controller a card list it will actually
          // read is to remount the embed. See the resurrection guard above.
          //
          // The wrapper moves off-screen while the card list is open. The embed is not drawn in
          // this iframe: RemNote paints it in a layer ABOVE the iframe at the placeholder's
          // position, so it would cover the list wherever the two overlap.
          // The SDK re-reads that position on any attribute mutation in the plugin tree, so
          // moving the wrapper moves the embed. Unmounting instead would end the drill session.
          <div
            className="h-full w-full"
            style={showCardList ? { position: 'fixed', top: '200vh', left: 0 } : undefined}
          >
            <Queue key={queueEpoch} cardIds={queueCardIds} width="100%" height="auto" />
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Loading…
          </div>
        )}
      </div>
      {cardListView}
    </div>
  );
}

renderWidget(FinalDrill);
