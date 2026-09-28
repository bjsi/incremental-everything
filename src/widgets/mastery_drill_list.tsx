import { renderWidget, usePlugin, useSyncedStorageState, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import '../style.css';
import '../App.css';
import { MasteryDrillCardList } from '../components/MasteryDrillCardList';
import { masteryDrillMinDelayMinutesId } from '../lib/consts';
import { FinalDrillItem, drillItemCardId, isDrillItemInKb } from '../lib/mastery_drill_audit';
import { finalDrillIdsKey } from '../lib/mastery_drill_status';
import { useIESetting } from '../lib/settings';

/**
 * The Mastery Drill card list on its own, for the regular-queue drill (opened from
 * its bar in the queue). The popup drill shows the same list inside its window.
 */
function MasteryDrillList() {
  const plugin = usePlugin();
  const [allItems, setAllItems] = useSyncedStorageState<FinalDrillItem[]>(finalDrillIdsKey, []);
  const minDelayMinutes = useIESetting(masteryDrillMinDelayMinutesId);

  const kb = useTrackerPlugin(async (rp) => ({
    id: (await rp.kb.getCurrentKnowledgeBaseData())?._id as string | undefined,
    isPrimary: await rp.kb.isPrimaryKnowledgeBase(),
  }));
  const items = React.useMemo(
    () => (kb?.id ? allItems.filter((item) => isDrillItemInKb(item, kb.id!, kb.isPrimary)) : []),
    [allItems, kb?.id, kb?.isPrimary]
  );

  const removeCards = async (cardIds: string[]) => {
    const ids = new Set(cardIds);
    await setAllItems(allItems.filter((item) => !ids.has(drillItemCardId(item))));
    // The regular-queue drill stops serving them (it listens to the list); the card on screen
    // stays until it is rated, as there is no way to tell it apart from here.
    await plugin.app.toast(`Removed ${cardIds.length} card${cardIds.length !== 1 ? 's' : ''} from the Mastery Drill.`);
  };

  const goToRem = async (remId: string) => {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;
    await plugin.widget.closePopup();
    await plugin.window.openRem(rem);
  };

  if (!kb) return null;
  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--rn-clr-background-primary)' }}>
      <MasteryDrillCardList
        items={items}
        minDelayMinutes={minDelayMinutes ?? 0}
        onRemove={removeCards}
        onGoToRem={goToRem}
        onClose={() => plugin.widget.closePopup()}
      />
    </div>
  );
}

renderWidget(MasteryDrillList);
