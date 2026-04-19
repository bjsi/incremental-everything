import React, { useEffect, useState } from "react";
import {
  renderWidget,
  useSyncedStorageState,
  Queue,
  usePlugin,
  useTrackerPlugin,
  RemHierarchyEditorTree,
  RemRichTextEditor,
  BuiltInPowerupCodes,
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
  const [oldItemsCount, setOldItemsCount] = useState<number>(0);

  const oldItemThreshold = useTrackerPlugin(async (reactivePlugin) => {
    return await reactivePlugin.settings.getSetting<number>("old_item_threshold");
  }, [plugin]) ?? 7;

  const [showClearOldConfirm, setShowClearOldConfirm] = useState(false);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);

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

      let relevantIds: string[] = [];
      let oldCount = 0;
      const now = Date.now();
      const msPerDay = 1000 * 60 * 60 * 24;

      finalDrillIdsRaw.forEach(item => {
        let isRelevant = false;
        let addedAt: number | undefined;

        if (typeof item === 'string') {
          if (isPrimary) isRelevant = true;
        } else if (item.kbId === currentKbId) {
          isRelevant = true;
          addedAt = item.addedAt;
        }

        if (isRelevant) {
          const id = typeof item === 'string' ? item : item.cardId;
          relevantIds.push(id);
          if (addedAt) {
            const daysOld = (now - addedAt) / msPerDay;
            if (daysOld > oldItemThreshold) oldCount++;
          }
        }
      });

      if (!cancelled) {
        setFilteredIds(relevantIds);
        setOldItemsCount(oldCount);
        setIsLoaded(true);
      }
    }

    if (plugin) updateDerivedState();
    return () => { cancelled = true; };
  }, [finalDrillIdsRaw, plugin, oldItemThreshold]);

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

  if (filteredIds.length === 0) {
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
        <h3 className="text-lg font-bold mb-2">Mastery Drill Queue Empty</h3>
        <p className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          No cards are currently in the Mastery Drill queue for this Knowledge Base.
        </p>
        <button
          onClick={() => setShowClearAllConfirm(true)}
          className="mt-4 px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600"
        >
          Open Settings
        </button>
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
        <div className="flex justify-between items-center p-2">
          <div className="flex gap-3 items-center">
            <span className="font-bold text-lg">Mastery Drill</span>
            <div className="flex gap-2 items-center">
              <button
                onClick={() => setShowClearAllConfirm(true)}
                className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                title="Clear all items from the Mastery Drill queue"
              >
                Clear Queue
              </button>
              <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-800">
                {filteredIds.length} Remaining
              </span>
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
            </div>
          </div>

          <div className="flex gap-2 items-center">
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
              className="px-3 py-1.5 text-sm rounded transition-colors shadow-sm font-medium"
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
              className="px-3 py-1.5 text-sm rounded bg-orange-500 text-white hover:bg-orange-600 font-medium transition-colors shadow-md"
              title="Mark for Edit Later and remove from drill"
            >
              Edit Later
            </button>

            <button
              onClick={() => startEditing('previous')}
              className="px-3 py-1.5 text-sm rounded font-medium transition-colors shadow-sm"
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
              className="px-3 py-1.5 text-sm rounded bg-blue-500 text-white hover:bg-blue-600 font-medium transition-colors shadow-sm"
              title="Edit the currently visible card"
            >
              Edit Current
            </button>
            <button
              onClick={removeCurrentFromDrill}
              className="text-sm px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 font-medium transition-colors"
              title="Remove current card from the Mastery Drill"
            >
              Remove from Drill
            </button>
          </div>

          {oldItemsCount > 0 && (
            <div className="flex items-center gap-2 px-2 py-1 rounded bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
              <span className="text-xs text-yellow-800 dark:text-yellow-200">
                {oldItemsCount} &gt; {oldItemThreshold} days.
              </span>
              <button
                onClick={() => setShowClearOldConfirm(true)}
                className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-300 hover:bg-yellow-200 dark:bg-yellow-800 dark:text-yellow-100 dark:border-yellow-600"
              >
                Clear Old
              </button>
            </div>
          )}
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

        <div className="px-2 pb-2 flex flex-col gap-0.5">
          <span className="text-sm px-2">Deliberately practice again your poorly rated flashcards.</span>
          <span className="text-xs px-2 text-gray-500 dark:text-gray-400">
            Flashcards you have rated <i>Again</i> or <i>Hard</i> will appear in the Mastery Drill and will remain here until you rate them <i>Good</i> or better.
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

      <div className="flex-grow relative">
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
