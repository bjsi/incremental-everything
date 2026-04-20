import React, { useEffect, useRef, useState } from "react";
import {
  renderWidget,
  useSyncedStorageState,
  Queue,
  usePlugin,
  useTrackerPlugin,
  RemHierarchyEditorTree,
  RemRichTextEditor,
  BuiltInPowerupCodes,
  QueueInteractionScore,
} from "@remnote/plugin-sdk";
import '../style.css';
import '../App.css';
import { PriorityBadge } from '../components';
import { getCardPriority, setCardPriority } from '../lib/card_priority';
import { InlinePriorityEditor } from '../components/InlineEditors';

export type FinalDrillItem = string | { cardId: string; kbId?: string; addedAt?: number };

function FinalDrill() {
  const plugin = usePlugin();
  const [finalDrillIdsRaw, setFinalDrillIdsRaw] = useSyncedStorageState<FinalDrillItem[]>("finalDrillIds", []);

  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const [filteredIds, setFilteredIds] = useState<string[]>([]);
  const [delayedCount, setDelayedCount] = useState<number>(0);
  const [oldItemsCount, setOldItemsCount] = useState<number>(0);
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const oldItemThreshold = useTrackerPlugin(async (reactivePlugin) => {
    return await reactivePlugin.settings.getSetting<number>("old_item_threshold");
  }, [plugin]) ?? 7;

  const minDelayMinutes = useTrackerPlugin(async (reactivePlugin) => {
    return await reactivePlugin.settings.getSetting<number>("mastery_drill_min_delay_minutes");
  }, [plugin]) ?? 120;

  const [showClearOldConfirm, setShowClearOldConfirm] = useState(false);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);

  const [showClearLowPriorityView, setShowClearLowPriorityView] = useState(false);
  const [lowPriorityCardData, setLowPriorityCardData] = useState<{ cardId: string; priority: number }[] | null>(null);
  const [lowPriorityThreshold, setLowPriorityThreshold] = useState(70);

  useEffect(() => {
    if (!showClearLowPriorityView) { setLowPriorityCardData(null); return; }
    let cancelled = false;
    (async () => {
      const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
      const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
      const currentKbId = currentKb._id;
      const results: { cardId: string; priority: number }[] = [];
      for (const item of finalDrillIdsRaw) {
        if (cancelled) return;
        const isRelevant = typeof item === 'string' ? isPrimary : item.kbId === currentKbId;
        if (!isRelevant) continue;
        const cardId = typeof item === 'string' ? item : item.cardId;
        const card = await plugin.card.findOne(cardId);
        if (!card?.remId || cancelled) continue;
        const rem = await plugin.rem.findOne(card.remId);
        if (!rem || cancelled) continue;
        const priorityInfo = await getCardPriority(plugin, rem);
        results.push({ cardId, priority: priorityInfo?.priority ?? 100 });
      }
      if (!cancelled) setLowPriorityCardData(results);
    })();
    return () => { cancelled = true; };
  }, [showClearLowPriorityView]);

  const doRemoveLowPriority = async () => {
    if (!lowPriorityCardData) return;
    const toRemoveIds = new Set(
      lowPriorityCardData.filter(({ priority }) => priority > lowPriorityThreshold).map(({ cardId }) => cardId)
    );
    const getCardId = (item: FinalDrillItem) => typeof item === 'string' ? item : item.cardId;
    await setFinalDrillIdsRaw(finalDrillIdsRaw.filter(item => !toRemoveIds.has(getCardId(item))));
    setShowClearLowPriorityView(false);
  };

  const [editingPriority, setEditingPriority] = useState<number | null>(null);

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

      const activeIds: string[] = [];
      let delayed = 0;
      let oldCount = 0;
      let earliestUnblock: number | undefined;
      const now = Date.now();
      const msPerDay = 1000 * 60 * 60 * 24;
      const minDelayMs = minDelayMinutes * 60 * 1000;

      for (const item of finalDrillIdsRaw) {
        const isRelevant = typeof item === 'string' ? isPrimary : item.kbId === currentKbId;
        if (!isRelevant) continue;

        const cardId = typeof item === 'string' ? item : item.cardId;
        const addedAt = typeof item === 'string' ? undefined : item.addedAt;

        if (addedAt) {
          const daysOld = (now - addedAt) / msPerDay;
          if (daysOld > oldItemThreshold) oldCount++;
        }

        if (addedAt && (now - addedAt) < minDelayMs) {
          delayed++;
          const unblockAt = addedAt + minDelayMs;
          if (earliestUnblock === undefined || unblockAt < earliestUnblock) earliestUnblock = unblockAt;
          console.log(`[MasteryDrill] Card ${cardId} cooling — addedAt=${new Date(addedAt).toISOString()}, remaining=${Math.round((unblockAt - now) / 60000)}min`);
        } else {
          activeIds.push(cardId);
        }
      }

      if (!cancelled) {
        setFilteredIds(activeIds);
        setDelayedCount(delayed);
        setOldItemsCount(oldCount);
        setIsLoaded(true);

        // Schedule a recheck when the first delayed card becomes available
        clearTimeout(recheckTimerRef.current);
        if (delayed > 0 && earliestUnblock !== undefined) {
          const msUntilUnblock = earliestUnblock - Date.now() + 500;
          recheckTimerRef.current = setTimeout(() => {
            if (!cancelled) updateDerivedState();
          }, Math.max(msUntilUnblock, 1000));
        }
      }
    }

    if (plugin) updateDerivedState();
    return () => {
      cancelled = true;
      clearTimeout(recheckTimerRef.current);
    };
  }, [finalDrillIdsRaw, plugin, oldItemThreshold, minDelayMinutes]);

  const clearOldItems = async () => {
    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    const currentKbId = currentKb._id;
    const now = Date.now();
    const msPerDay = 1000 * 60 * 60 * 24;

    const newIds = finalDrillIdsRaw.filter(item => {
      if (typeof item !== 'string' && item.kbId === currentKbId && item.addedAt) {
        const daysOld = (now - item.addedAt) / msPerDay;
        if (daysOld > oldItemThreshold) return false;
      }
      return true;
    });

    await setFinalDrillIdsRaw(newIds);
    setShowClearOldConfirm(false);
  };

  const clearAllItems = async () => {
    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
    const currentKbId = currentKb._id;

    const newIds = finalDrillIdsRaw.filter(item => {
      if (typeof item === 'string') return !isPrimary;
      return item.kbId !== currentKbId;
    });

    await setFinalDrillIdsRaw(newIds);
    setShowClearAllConfirm(false);
  };

  const [editingRemId, setEditingRemId] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  // null = hidden; 'current' = main drill; 'editing' = edit-previous view
  const [editLaterContext, setEditLaterContext] = useState<'current' | 'editing' | null>(null);
  const [editLaterMessage, setEditLaterMessage] = useState('');

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

  const confirmEditLater = async () => {
    const message = editLaterMessage.trim() || "Mastery Drill";
    const getCardId = (item: FinalDrillItem) => typeof item === 'string' ? item : item.cardId;

    if (editLaterContext === 'editing') {
      if (!editingCardId) return;
      const card = await plugin.card.findOne(editingCardId);
      if (card && card.remId) {
        const rem = await plugin.rem.findOne(card.remId);
        if (rem) {
          await rem.addPowerup(BuiltInPowerupCodes.EditLater);
          await rem.setPowerupProperty(BuiltInPowerupCodes.EditLater, "Message", [message]);
          const newIds = finalDrillIdsRaw.filter(item => getCardId(item) !== editingCardId);
          await setFinalDrillIdsRaw(newIds);
          await plugin.app.toast("Card marked for Edit Later and removed from drill.");
          setEditingRemId(null);
          setEditingCardId(null);
        }
      }
    } else if (editLaterContext === 'current') {
      const cardId = await plugin.storage.getSession<string>("finalDrillCurrentCardId");
      if (!cardId) { await plugin.app.toast("No current card found."); return; }
      const card = await plugin.card.findOne(cardId);
      if (card && card.remId) {
        const rem = await plugin.rem.findOne(card.remId);
        if (rem) {
          await rem.addPowerup(BuiltInPowerupCodes.EditLater);
          await rem.setPowerupProperty(BuiltInPowerupCodes.EditLater, "Message", [message]);
          const newIds = finalDrillIdsRaw.filter(item => getCardId(item) !== cardId);
          await setFinalDrillIdsRaw(newIds);
          await plugin.queue.removeCurrentCardFromQueue(false);
          await plugin.app.toast("Card marked for Edit Later and removed from drill.");
        }
      }
    }

    setEditLaterContext(null);
    setEditLaterMessage('');
  };

  const cancelEditLater = () => {
    setEditLaterContext(null);
    setEditLaterMessage('');
  };

  const removeCurrentFromDrill = async () => {
    const cardId = await plugin.storage.getSession<string>("finalDrillCurrentCardId");
    if (!cardId) {
      await plugin.app.toast("No current card found.");
      return;
    }
    const getCardId = (item: FinalDrillItem) => typeof item === 'string' ? item : item.cardId;
    const newIds = finalDrillIdsRaw.filter(item => getCardId(item) !== cardId);
    await setFinalDrillIdsRaw(newIds);
    await plugin.queue.removeCurrentCardFromQueue(false);
    await plugin.app.toast("Card removed from Mastery Drill.");
  };

  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTimeout(() => containerRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    const SCORE_MAP: Record<string, QueueInteractionScore> = {
      '1': QueueInteractionScore.AGAIN,
      '2': QueueInteractionScore.HARD,
      '3': QueueInteractionScore.GOOD,
      ' ': QueueInteractionScore.GOOD,
      '4': QueueInteractionScore.EASY,
    };

    const handler = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

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
      <div
        className="h-full w-full flex flex-col"
        style={{
          backgroundColor: 'var(--rn-clr-background-primary)',
          color: 'var(--rn-clr-content-primary)'
        }}
      >
        <div
          className="w-full flex justify-between items-center p-2 border-b flex-shrink-0"
          style={{
            borderColor: 'var(--rn-clr-border-primary)',
            backgroundColor: 'var(--rn-clr-background-secondary)'
          }}
        >
          <div className="flex flex-col">
            <span className="font-semibold text-lg px-2">Editing Card</span>
            <span className="text-xs px-2 font-mono" style={{ color: 'var(--rn-clr-content-tertiary)' }}>ID: {editingRemId}</span>
          </div>
          <div className="flex gap-2" style={{ paddingRight: '60px' }}>
            <button
              onClick={() => { setEditLaterMessage(''); setEditLaterContext('editing'); }}
              className="px-3 py-1.5 rounded bg-orange-500 text-white hover:bg-orange-600 font-medium transition-colors shadow-md"
              title="Mark for Edit Later and remove from drill"
            >
              Edit Later
            </button>
            <button
              onClick={async () => {
                const rem = await plugin.rem.findOne(editingRemId);
                if (rem) {
                  await plugin.window.openRem(rem);
                  await plugin.storage.setSession("finalDrillResumeTrigger", Date.now());
                  await plugin.widget.closePopup();
                }
              }}
              className="px-3 py-1.5 rounded font-medium transition-colors"
              style={{
                color: 'var(--rn-clr-content-primary)',
                border: '1px solid var(--rn-clr-border-primary)',
                backgroundColor: 'var(--rn-clr-background-primary)'
              }}
            >
              Go to Rem
            </button>
            <button
              onClick={() => setEditingRemId(null)}
              className="px-3 py-1.5 rounded bg-blue-500 text-white hover:bg-blue-600 font-medium transition-colors shadow-sm"
            >
              Done / Back to Drill
            </button>
          </div>
        </div>

        {editLaterContext === 'editing' && (
          <div className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>Edit Later note:</span>
            <input
              type="text"
              value={editLaterMessage}
              onChange={(e) => setEditLaterMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirmEditLater(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancelEditLater(); }
              }}
              placeholder="Mastery Drill"
              className="flex-1 text-xs p-1 rounded"
              style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)' }}
              autoFocus
            />
            <button onClick={confirmEditLater} className="px-2 py-1 text-xs rounded bg-orange-500 text-white hover:bg-orange-600">Set</button>
            <button onClick={cancelEditLater} className="px-2 py-1 text-xs rounded" style={{ border: '1px solid var(--rn-clr-border-primary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
          </div>
        )}

        <div className="flex-grow w-full overflow-hidden flex flex-col p-4 overflow-y-auto gap-6">
          <div className="flex-shrink-0">
            <div className="text-sm font-bold mb-2 px-2 uppercase tracking-wide" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              Rem Content
            </div>
            <div className="border rounded-md p-2" style={{ borderColor: 'var(--rn-clr-border-primary)' }}>
              <RemRichTextEditor remId={editingRemId} width="100%" />
            </div>
          </div>

          <div className="flex-grow flex flex-col min-h-[200px]">
            <div className="text-sm font-bold mb-2 px-2 uppercase tracking-wide" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              Hierarchy / Details
            </div>
            <div className="flex-grow border rounded-md p-2" style={{ borderColor: 'var(--rn-clr-border-primary)' }}>
              <RemHierarchyEditorTree remId={editingRemId} width="100%" height="auto" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (showClearOldConfirm) {
    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center p-4 text-center"
        style={{
          backgroundColor: 'var(--rn-clr-background-primary)',
          color: 'var(--rn-clr-content-primary)'
        }}
      >
        <h3 className="text-lg font-bold mb-2">Clear Old Items?</h3>
        <p className="mb-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          This will remove {oldItemsCount} items that have been in the queue for more than {oldItemThreshold} days. {filteredIds.length - oldItemsCount} items will remain.
        </p>
        <div className="flex gap-4">
          <button
            onClick={() => setShowClearOldConfirm(false)}
            className="px-4 py-2 rounded transition-colors"
            style={{
              border: '1px solid var(--rn-clr-border-primary)',
              color: 'var(--rn-clr-content-primary)',
              backgroundColor: 'var(--rn-clr-background-secondary)'
            }}
          >
            Cancel
          </button>
          <button
            onClick={clearOldItems}
            className="px-4 py-2 rounded text-white transition-colors"
            style={{ backgroundColor: '#ea5e5e' }}
          >
            Clear Old Items
          </button>
        </div>
      </div>
    );
  }

  if (showClearAllConfirm) {
    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center p-4 text-center"
        style={{
          backgroundColor: 'var(--rn-clr-background-primary)',
          color: 'var(--rn-clr-content-primary)'
        }}
      >
        <h3 className="text-lg font-bold mb-2">Clear Mastery Drill Queue?</h3>
        <p className="mb-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          This will remove all {filteredIds.length} items from the Mastery Drill queue for this Knowledge Base.
        </p>
        <div className="flex gap-4">
          <button
            onClick={() => setShowClearAllConfirm(false)}
            className="px-4 py-2 rounded transition-colors"
            style={{
              border: '1px solid var(--rn-clr-border-primary)',
              color: 'var(--rn-clr-content-primary)',
              backgroundColor: 'var(--rn-clr-background-secondary)'
            }}
          >
            Cancel
          </button>
          <button
            onClick={clearAllItems}
            className="px-4 py-2 rounded text-white transition-colors"
            style={{ backgroundColor: '#ea5e5e' }}
          >
            Clear All
          </button>
        </div>
      </div>
    );
  }

  if (showClearLowPriorityView) {
    const getBucket = (p: number) => Math.min(Math.floor(Math.max(p - 1, 0) / 5), 19);
    const buckets = Array.from({ length: 20 }, (_, i) => ({
      label: i === 0 ? '0-5' : `${i * 5 + 1}-${(i + 1) * 5}`,
      minPriority: i === 0 ? 0 : i * 5 + 1,
      maxPriority: (i + 1) * 5,
      count: 0,
    }));
    lowPriorityCardData?.forEach(({ priority }) => { buckets[getBucket(priority)].count++; });
    const maxCount = Math.max(...buckets.map(b => b.count), 1);
    const toRemoveCount = lowPriorityCardData?.filter(({ priority }) => priority > lowPriorityThreshold).length ?? 0;

    return (
      <div className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }}>
        <div className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}>
          <span className="font-semibold">Clear Low Priority Cards</span>
          <button
            onClick={() => setShowClearLowPriorityView(false)}
            className="text-sm px-2 py-1 rounded transition-colors"
            style={{ color: 'var(--rn-clr-content-secondary)', border: '1px solid var(--rn-clr-border-primary)' }}
          >
            ← Back
          </button>
        </div>

        {lowPriorityCardData === null ? (
          <div className="flex-grow flex items-center justify-center text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Loading priorities…
          </div>
        ) : (
          <>
            <div className="overflow-y-auto px-4 py-2" style={{ maxHeight: '65vh' }}>
              {buckets.map((bucket, i) => {
                const isAbove = bucket.minPriority > lowPriorityThreshold;
                const isSplit = !isAbove && bucket.maxPriority > lowPriorityThreshold;
                const barColor = isAbove ? '#ef4444' : isSplit ? '#f97316' : 'var(--rn-clr-blue)';
                const barWidth = bucket.count > 0 ? Math.max((bucket.count / maxCount) * 100, 2) : 0;
                return (
                  <div key={i} className="flex items-center gap-2 py-0.5" style={{ opacity: bucket.count === 0 ? 0.3 : 1 }}>
                    <span className="text-xs w-14 text-right flex-shrink-0 font-mono"
                      style={{ color: isAbove ? '#ef4444' : isSplit ? '#f97316' : 'var(--rn-clr-content-secondary)', fontWeight: (isAbove || isSplit) ? 600 : undefined }}>
                      {bucket.label}
                    </span>
                    <div className="flex-grow rounded overflow-hidden" style={{ height: 14, backgroundColor: 'var(--rn-clr-background-secondary)' }}>
                      <div style={{ width: `${barWidth}%`, height: '100%', backgroundColor: barColor, transition: 'width 0.15s' }} />
                    </div>
                    <span className="text-xs w-5 text-right flex-shrink-0"
                      style={{ color: isAbove ? '#ef4444' : 'var(--rn-clr-content-tertiary)' }}>
                      {bucket.count}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex-shrink-0 px-4 py-2 border-t flex flex-col gap-2" style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>Remove cards with priority above:</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={lowPriorityThreshold}
                  onChange={(e) => setLowPriorityThreshold(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                  className="w-14 text-xs p-1 rounded text-center"
                  style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }}
                />
                <span className="text-xs ml-auto" style={{ color: toRemoveCount > 0 ? '#ef4444' : 'var(--rn-clr-content-tertiary)' }}>
                  {toRemoveCount === 0 ? 'No cards to remove' : `${toRemoveCount} card${toRemoveCount !== 1 ? 's' : ''} will be removed`}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={doRemoveLowPriority}
                  disabled={toRemoveCount === 0}
                  className="flex-1 py-1.5 rounded text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: toRemoveCount > 0 ? '#ef4444' : 'var(--rn-clr-background-primary)',
                    color: toRemoveCount > 0 ? 'white' : 'var(--rn-clr-content-tertiary)',
                    border: toRemoveCount === 0 ? '1px solid var(--rn-clr-border-primary)' : undefined,
                    cursor: toRemoveCount === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {toRemoveCount > 0 ? `Remove ${toRemoveCount} card${toRemoveCount !== 1 ? 's' : ''}` : 'No cards to remove'}
                </button>
                <button
                  onClick={() => setShowClearLowPriorityView(false)}
                  className="flex-1 py-1.5 rounded text-sm font-medium transition-colors"
                  style={{ border: '1px solid var(--rn-clr-border-primary)', color: 'var(--rn-clr-content-secondary)', backgroundColor: 'var(--rn-clr-background-primary)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  if (filteredIds.length === 0) {
    const isCoolingDown = delayedCount > 0;
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
              {delayedCount} card{delayedCount !== 1 ? 's are' : ' is'} waiting for the {minDelayMinutes}-minute minimum delay to pass before appearing here again.
            </p>
            <p className="text-xs mt-2" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              The drill will refresh automatically when the first card is ready.
            </p>
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
      <div className="border-b rn-clr-border-primary flex flex-col">
        {/* Row 1: Queue management */}
        <div className="flex items-center gap-2 px-2 pt-2 pb-1">
          <span className="font-bold text-lg whitespace-nowrap flex-shrink-0">Mastery Drill</span>
          <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-800 whitespace-nowrap">
            {filteredIds.length} Remaining
          </span>
          {delayedCount > 0 && (
            <span
              className="text-xs px-2 py-1 rounded whitespace-nowrap"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                color: 'var(--rn-clr-content-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
              title={`${delayedCount} card${delayedCount !== 1 ? 's are' : ' is'} within the ${minDelayMinutes}-min minimum delay and will appear later`}
            >
              {delayedCount} cooling
            </span>
          )}
          <button
            onClick={() => setShowClearAllConfirm(true)}
            className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 whitespace-nowrap"
            title="Clear all items from the Mastery Drill queue"
          >
            Clear Queue
          </button>
          <button
            onClick={() => setShowClearLowPriorityView(true)}
            className="text-xs px-2 py-1 rounded border border-orange-200 text-orange-600 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-900/20 whitespace-nowrap"
            title="Remove low priority cards from the Mastery Drill queue"
          >
            Clear Low Priority
          </button>
          {oldItemsCount > 0 && (
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800"
              title={`${oldItemsCount} card${oldItemsCount !== 1 ? 's have' : ' has'} been waiting in the drill queue for more than ${oldItemThreshold} days. The Mastery Drill is intended for cards you recently rated Hard or Again — after this much time, the spaced repetition algorithm will handle them at their scheduled date instead. You can remove them here if you prefer to trust the scheduler rather than drilling them now.`}
            >
              <span className="text-xs text-yellow-800 dark:text-yellow-200 whitespace-nowrap">
                {oldItemsCount} &gt; {oldItemThreshold} days.
              </span>
              <button
                onClick={() => setShowClearOldConfirm(true)}
                className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-300 hover:bg-yellow-200 dark:bg-yellow-800 dark:text-yellow-100 dark:border-yellow-600 whitespace-nowrap"
              >
                Clear Old
              </button>
            </div>
          )}
        </div>

        {/* Row 2: Current card actions */}
        <div className="flex items-center gap-2 px-2 pb-2">
          {currentCardData?.priority && (
            <div
              className="cursor-pointer"
              onClick={() => setEditingPriority(currentCardData.priority!.priority)}
              title="Click to change priority"
            >
              <PriorityBadge
                priority={currentCardData.priority.priority}
                percentile={currentCardData.priority.kbPercentile ?? undefined}
                compact
                useAbsoluteColoring={currentCardData.priority.kbPercentile == null}
                source={currentCardData.priority.source}
                isCardPriority
              />
            </div>
          )}
          <button
            onClick={async () => {
              const cardId = await plugin.storage.getSession<string>("finalDrillCurrentCardId");
              if (cardId) {
                const card = await plugin.card.findOne(cardId);
                if (card && card.remId) {
                  const rem = await plugin.rem.findOne(card.remId);
                  if (rem) {
                    await plugin.window.openRem(rem);
                    await plugin.storage.setSession("finalDrillResumeTrigger", Date.now());
                    await plugin.widget.closePopup();
                  }
                }
              }
            }}
            className="px-3 py-1.5 text-sm rounded transition-colors shadow-sm font-medium whitespace-nowrap"
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
              border: '1px solid var(--rn-clr-border-primary)'
            }}
            title="Go to the current Rem (closes popup)"
          >
            Go to Rem
          </button>

          <button
            onClick={() => { setEditLaterMessage(''); setEditLaterContext('current'); }}
            className="px-3 py-1.5 text-sm rounded bg-orange-500 text-white hover:bg-orange-600 font-medium transition-colors shadow-md whitespace-nowrap"
            title="Mark for Edit Later and remove from drill"
          >
            Edit Later
          </button>

          <button
            onClick={() => startEditing('previous')}
            className="px-3 py-1.5 text-sm rounded font-medium transition-colors shadow-sm whitespace-nowrap"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              color: 'var(--rn-clr-content-primary)',
              border: '1px solid var(--rn-clr-border-primary)'
            }}
            title="Edit the card you just rated"
          >
            Edit Previous
          </button>
          <button
            onClick={() => startEditing('current')}
            className="px-3 py-1.5 text-sm rounded bg-blue-500 text-white hover:bg-blue-600 font-medium transition-colors shadow-sm whitespace-nowrap"
            title="Edit the currently visible card"
          >
            Edit Current
          </button>
          <button
            onClick={removeCurrentFromDrill}
            className="text-sm px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 font-medium transition-colors whitespace-nowrap"
            title="Remove current card from the Mastery Drill"
          >
            Remove from Drill
          </button>
        </div>

        {editingPriority !== null && currentCardData?.remId && (
          <div className="px-2 pt-1">
            <InlinePriorityEditor
              value={editingPriority}
              onChange={setEditingPriority}
              onSave={async () => {
                const rem = await plugin.rem.findOne(currentCardData.remId);
                if (rem) await setCardPriority(plugin, rem, editingPriority, 'manual');
                setEditingPriority(null);
              }}
              onCancel={() => setEditingPriority(null)}
            />
          </div>
        )}

        <div className="px-4 pb-2 flex items-baseline gap-2 flex-nowrap overflow-hidden">
          <span className="text-sm whitespace-nowrap flex-shrink-0">Deliberately practice again your poorly rated flashcards.</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
            Flashcards you have rated <i>Again</i> or <i>Hard</i> will appear and remain in the Drill until you rate them <i>Good</i> or better.
          </span>
        </div>

        {editLaterContext === 'current' && (
          <div className="flex items-center gap-2 px-3 py-2 border-t flex-shrink-0" style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>Edit Later note:</span>
            <input
              type="text"
              value={editLaterMessage}
              onChange={(e) => setEditLaterMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirmEditLater(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancelEditLater(); }
              }}
              placeholder="Mastery Drill"
              className="flex-1 text-xs p-1 rounded"
              style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)' }}
              autoFocus
            />
            <button onClick={confirmEditLater} className="px-2 py-1 text-xs rounded bg-orange-500 text-white hover:bg-orange-600">Set</button>
            <button onClick={cancelEditLater} className="px-2 py-1 text-xs rounded" style={{ border: '1px solid var(--rn-clr-border-primary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
          </div>
        )}
      </div>

      <div
        className="flex-grow relative"
        onMouseDown={() => {
          // After a click inside the Queue embed the iframe may steal focus.
          // Re-focus our container so the window-level keydown listener keeps working.
          setTimeout(() => containerRef.current?.focus(), 50);
        }}
      >
        {isLoaded ? (
          <Queue cardIds={filteredIds} width="100%" height="100%" />
        ) : (
          <div className="h-full w-full flex items-center justify-center" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(FinalDrill);
