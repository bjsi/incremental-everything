import { renderWidget, usePlugin, useSessionStorageState, useSyncedStorageState, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import '../style.css';
import '../App.css';
import { MasteryDrillHeader } from '../components/MasteryDrillHeader';
import { oldItemThresholdId } from '../lib/consts';
import { dropFromLiveQueue, markDrillCardEditLater, removeFromDrill } from '../lib/mastery_drill_actions';
import { FinalDrillEntry, summarizeDrill } from '../lib/mastery_drill_cooling';
import {
  MasteryDrillPanelRequest,
  NativeDrillState,
  masteryDrillPanelWidgetId,
  nativeDrillStateKey,
} from '../lib/mastery_drill_launch';
import { finalDrillIdsKey, finalDrillResumeTriggerKey, useDrillCooling } from '../lib/mastery_drill_status';
import { useIESetting } from '../lib/settings';

/** How often the counts are re-aged, so a card leaving its cooling shows up as Remaining. */
const REFRESH_MS = 60_000;

/**
 * The regular-queue Mastery Drill's bar, under the queue's top bar. Renders nothing
 * unless that drill is on screen (lib/mastery_drill_native publishes the state).
 *
 * The same header as the popup drill (components/MasteryDrillHeader), minus the
 * priority badge, which the regular queue already shows in the card info bar. The
 * popup swaps its window for a panel; here each panel opens in a popup
 * (widgets/mastery_drill_panel.tsx). Rating and the card itself are the queue's own.
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

  /** Runs `fn` on the drill card on screen, or says there is none. */
  const withCard = (cardId: string | undefined, none: string, fn: (cardId: string) => Promise<void>) => async () => {
    if (!cardId) {
      await plugin.app.toast(none);
      return;
    }
    await fn(cardId);
  };
  const noCurrent = 'No drill card on screen.';

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
        goToRemTitle="Go to the current Rem (leaves the drill)"
        onGoToRem={withCard(state.currentCardId, noCurrent, async (cardId) => {
          const card = await plugin.card.findOne(cardId);
          const rem = card?.remId ? await plugin.rem.findOne(card.remId) : undefined;
          if (!rem) return;
          await plugin.window.openRem(rem);
          await plugin.storage.setSession(finalDrillResumeTriggerKey, Date.now());
        })}
        onEditLater={async (message) =>
          withCard(state.currentCardId, noCurrent, async (cardId) => {
            if (!(await markDrillCardEditLater(plugin, cardId, message))) return;
            const dropped = await dropFromLiveQueue(plugin, cardId);
            await plugin.app.toast(
              dropped
                ? 'Card marked for Edit Later and removed from drill.'
                : 'Marked for Edit Later and removed from the drill. It stays on screen until you rate it.'
            );
          })()
        }
        onEditPrevious={withCard(state.previousCardId, 'No previous drill card yet.', async (cardId) => {
          await openPanel({ view: 'edit', cardId, isCurrent: false });
        })}
        onEditCurrent={withCard(state.currentCardId, noCurrent, async (cardId) => {
          await openPanel({ view: 'edit', cardId, isCurrent: true });
        })}
        onRemoveCurrent={withCard(state.currentCardId, noCurrent, async (cardId) => {
          await removeFromDrill(plugin, [cardId]);
          const dropped = await dropFromLiveQueue(plugin, cardId);
          await plugin.app.toast(
            dropped ? 'Card removed from the Mastery Drill.' : 'Card removed from the Mastery Drill. It stays on screen until you rate it.'
          );
        })}
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
