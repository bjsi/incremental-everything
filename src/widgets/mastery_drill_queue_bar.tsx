import { renderWidget, usePlugin, useSessionStorageState, useSyncedStorageState, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import '../style.css';
import '../App.css';
import { MasteryDrillHeader } from '../components/MasteryDrillHeader';
import { oldItemThresholdId } from '../lib/consts';
import { dropFromLiveQueue, removeFromDrill } from '../lib/mastery_drill_actions';
import { FinalDrillEntry, summarizeDrill } from '../lib/mastery_drill_cooling';
import {
  MasteryDrillPanelRequest,
  NativeDrillState,
  masteryDrillPanelWidgetId,
  nativeDrillStateKey,
} from '../lib/mastery_drill_launch';
import { finalDrillIdsKey, useDrillCooling } from '../lib/mastery_drill_status';
import { useIESetting } from '../lib/settings';

/** How often the counts are re-aged, so a card leaving its cooling shows up as Remaining. */
const REFRESH_MS = 60_000;

/**
 * The regular-queue Mastery Drill's bar, under the queue's top bar. Renders nothing
 * unless that drill is on screen (lib/mastery_drill_native publishes the state).
 *
 * The popup drill's header (components/MasteryDrillHeader) without its card row:
 * Go to Rem, Edit Later, editing and priority are the regular queue's own. The
 * popup swaps its window for a panel; here each panel opens in a popup
 * (widgets/mastery_drill_panel.tsx).
 */
function MasteryDrillQueueBar() {
  const plugin = usePlugin();
  const [state] = useSessionStorageState<NativeDrillState | undefined>(nativeDrillStateKey, undefined);
  const [items] = useSyncedStorageState<FinalDrillEntry[]>(finalDrillIdsKey, []);
  const cooling = useDrillCooling();
  const oldThreshold = useIESetting(oldItemThresholdId);
  const kb = useTrackerPlugin(async (rp) => ({
    id: (await rp.kb.getCurrentKnowledgeBaseData())?._id as string | undefined,
    isPrimary: await rp.kb.isPrimaryKnowledgeBase(),
  }));

  const active = !!state?.active;
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active]);

  const summary = React.useMemo(
    () =>
      kb?.id
        ? summarizeDrill(items, (item) => (typeof item === 'string' ? kb.isPrimary : item.kbId === kb.id), cooling, oldThreshold, now)
        : null,
    [items, kb?.id, kb?.isPrimary, cooling, oldThreshold, now]
  );

  if (!state?.active || !summary) return null;

  const openPanel = (request: MasteryDrillPanelRequest) => plugin.widget.openPopup(masteryDrillPanelWidgetId, request);

  const removeCurrent = async () => {
    const cardId = state.currentCardId;
    if (!cardId) {
      await plugin.app.toast('No drill card on screen.');
      return;
    }
    await removeFromDrill(plugin, [cardId]);
    const dropped = await dropFromLiveQueue(plugin, cardId);
    await plugin.app.toast(
      dropped ? 'Card removed from the Mastery Drill.' : 'Card removed from the Mastery Drill. It stays on screen until you rate it.'
    );
  };

  return (
    <div style={{ paddingBottom: '2px' }}>
      <MasteryDrillHeader
        variant="queue"
        readyCount={summary.readyIds.length}
        coolingCount={summary.coolingCount}
        firstReadyAt={summary.firstReadyAt}
        oldCount={summary.oldCount}
        oldThreshold={oldThreshold}
        onOpenCardList={() => plugin.widget.openPopup('mastery_drill_list')}
        onClearAll={() => openPanel({ view: 'clear-all' })}
        onClearLowPriority={() => openPanel({ view: 'clear-low' })}
        onClearOld={() => openPanel({ view: 'clear-old' })}
        onRemoveCurrent={removeCurrent}
        notice={
          state.buried ? (
            <>
              RemNote hid some drill cards because a related card was just skipped. At "Time to Take a Break", press{' '}
              <b>Keep Practicing</b> (or Esc) to get them. It only affects this drill.
            </>
          ) : undefined
        }
      />
    </div>
  );
}

renderWidget(MasteryDrillQueueBar);
