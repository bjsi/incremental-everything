import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useSyncedStorageState,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React from 'react';
import '../style.css';
import '../App.css';
import { MasteryDrillCardEditor, MasteryDrillConfirm, MasteryDrillLowPriority } from '../components/MasteryDrillPanels';
import { oldItemThresholdId } from '../lib/consts';
import {
  clearDrillForKb,
  clearOldDrillItems,
  dropFromLiveQueue,
  markDrillCardEditLater,
  removeFromDrill,
} from '../lib/mastery_drill_actions';
import { FinalDrillEntry, summarizeDrill } from '../lib/mastery_drill_cooling';
import { MasteryDrillPanelRequest } from '../lib/mastery_drill_launch';
import { finalDrillIdsKey, finalDrillResumeTriggerKey, useDrillCooling } from '../lib/mastery_drill_status';
import { useIESetting } from '../lib/settings';

/**
 * The regular-queue drill bar's panels (clear confirmations, Clear Low Priority, the
 * card editor) — the same components the popup drill shows in place of its queue.
 * Which one comes from the popup's context (MasteryDrillPanelRequest).
 */
function MasteryDrillPanel() {
  const plugin = usePlugin();
  const request = useRunAsync(
    async () => ((await plugin.widget.getWidgetContext<WidgetLocation.Popup>())?.contextData ?? null) as MasteryDrillPanelRequest | null,
    []
  );
  const [items] = useSyncedStorageState<FinalDrillEntry[]>(finalDrillIdsKey, []);
  const cooling = useDrillCooling();
  const oldThreshold = useIESetting(oldItemThresholdId);
  const kb = useTrackerPlugin(async (rp) => ({
    id: (await rp.kb.getCurrentKnowledgeBaseData())?._id as string | undefined,
    isPrimary: await rp.kb.isPrimaryKnowledgeBase(),
  }));
  const editRemId = useTrackerPlugin(
    async (rp) => (request?.view === 'edit' ? (await rp.card.findOne(request.cardId))?.remId ?? null : null),
    [request]
  );

  const summary = React.useMemo(
    () =>
      kb?.id
        ? summarizeDrill(items, (item) => (typeof item === 'string' ? kb.isPrimary : item.kbId === kb.id), cooling, oldThreshold, Date.now())
        : null,
    [items, kb?.id, kb?.isPrimary, cooling, oldThreshold]
  );

  // Every write is awaited before closing: a popup's teardown cuts off what is still in flight.
  const close = () => plugin.widget.closePopup();

  if (!request || !kb?.id || !summary) return null;

  if (request.view === 'clear-all') {
    return (
      <MasteryDrillConfirm
        title="Clear Mastery Drill Queue?"
        message={`This will remove all ${summary.kbItems.length} items from the Mastery Drill queue for this Knowledge Base.`}
        confirmLabel="Clear All"
        onConfirm={async () => {
          await clearDrillForKb(plugin, kb.id!, kb.isPrimary);
          await close();
        }}
        onCancel={close}
      />
    );
  }

  if (request.view === 'clear-old') {
    return (
      <MasteryDrillConfirm
        title="Clear Old Items?"
        message={`This will remove ${summary.oldCount} items that have been ready to drill for more than ${oldThreshold} days. ${
          summary.kbItems.length - summary.oldCount
        } items will remain.`}
        confirmLabel="Clear Old Items"
        onConfirm={async () => {
          await clearOldDrillItems(plugin, kb.id!, cooling, oldThreshold);
          await close();
        }}
        onCancel={close}
      />
    );
  }

  if (request.view === 'clear-low') {
    return (
      <MasteryDrillLowPriority
        items={summary.kbItems}
        onRemove={async (cardIds) => {
          await removeFromDrill(plugin, cardIds);
          await close();
        }}
        onBack={close}
      />
    );
  }

  const { cardId, isCurrent } = request;
  if (!editRemId) {
    return editRemId === null ? (
      <div className="p-4 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        This card no longer exists.
      </div>
    ) : null;
  }

  return (
    <MasteryDrillCardEditor
      remId={editRemId}
      doneLabel="Done / Back to Queue"
      onEditLater={async (message) => {
        if (!(await markDrillCardEditLater(plugin, cardId, message))) return;
        const dropped = isCurrent && (await dropFromLiveQueue(plugin, cardId));
        await plugin.app.toast(
          isCurrent && !dropped
            ? 'Marked for Edit Later and removed from the drill. It stays on screen until you rate it.'
            : 'Card marked for Edit Later and removed from drill.'
        );
        await close();
      }}
      onGoToRem={async () => {
        const rem = await plugin.rem.findOne(editRemId);
        if (!rem) return;
        await plugin.window.openRem(rem);
        await plugin.storage.setSession(finalDrillResumeTriggerKey, Date.now());
        await close();
      }}
      onDone={close}
    />
  );
}

renderWidget(MasteryDrillPanel);
