import {
  AppEvents,
  declareIndexPlugin,
  PluginCommandMenuLocation,
  PropertyLocation,
  PropertyType,
  QueueItemType,
  ReactRNPlugin,
  Rem,
  RemId,
  RNPlugin,
  SelectionType,
  SpecialPluginCallback,
  StorageEvents,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import {
  allIncrementalRemKey,
  initialIntervalId,
  multiplierId,
  nextRepDateSlotCode,
  powerupCode,
  prioritySlotCode,
  repHistorySlotCode,
  collapseQueueTopBar,
  scrollToHighlightId,
  collapseTopBarId,
  queueCounterId,
  hideIncEverythingId,
  nextRepCommandId,
  shouldHideIncEverythingKey,
  collapseTopBarKey,
} from '../lib/consts';
import * as _ from 'remeda';
import { getSortingRandomness, getRatioBetweenCardsAndIncrementalRem } from '../lib/sorting';
import { IncrementalRem } from '../lib/types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemInfo, handleHextRepetitionClick } from '../lib/incremental_rem';
import { getDailyDocReferenceForDate } from '../lib/date';
import { getCurrentIncrementalRem, setCurrentIncrementalRem } from '../lib/currentRem';
dayjs.extend(relativeTime);

async function onActivate(plugin: ReactRNPlugin) {
  plugin.app.registerCSS(
    'queue-container',
    `
    .rn-queue__content {
      height: 100vh !important;
      display: flex !important;
      flex-direction: column !important;
    }
    .rn-queue__content > div {
      flex: 1 !important;
      min-height: 0 !important;
    }
    `
  );

  plugin.app.registerCallback(StorageEvents.StorageSessionChange, async (changes) => {
    if (shouldHideIncEverythingKey in changes) {
      const shouldHide = await plugin.storage.getSession(shouldHideIncEverythingKey);
      plugin.app.registerCSS(
        hideIncEverythingId,
        shouldHide 
          ? `
              div.rn-queue__content > div:has(> div > iframe[data-plugin-id="incremental-everything"]) {
                display: none;
              }
            `.trim()
          : ''
      );
    }
  });

  await plugin.app.registerPowerup('Incremental', powerupCode, 'Incremental Everything Powerup', {
    slots: [
      {
        code: prioritySlotCode,
        name: 'Priority',
        propertyType: PropertyType.NUMBER,
        propertyLocation: PropertyLocation.BELOW,
      },
      {
        code: nextRepDateSlotCode,
        name: 'Next Rep Date',
        propertyType: PropertyType.DATE,
        propertyLocation: PropertyLocation.BELOW,
      },
      {
        code: repHistorySlotCode,
        name: 'History',
        hidden: true,
      },
    ],
  });

  plugin.settings.registerNumberSetting({
    id: initialIntervalId,
    title: 'Initial Interval',
    description: 'Sets the number of days until the first repetition.',
    defaultValue: 0,
  });

  plugin.settings.registerNumberSetting({
    id: multiplierId,
    title: 'Multiplier',
    description:
      'Sets the multiplier to calculate the next interval. Multiplier * previous interval = next interval.',
    defaultValue: 1.5,
  });

  plugin.settings.registerBooleanSetting({
    id: collapseQueueTopBar,
    title: 'Collapse Queue Top Bar',
    description:
      'Create extra space by collapsing the top bar in the queue. You can hover over the collapsed bar to open it.',
    defaultValue: true,
  });

  plugin.app.registerCallback(StorageEvents.StorageSessionChange, async (changes) => {
    const COLLAPSE_TOP_BAR_CSS = `
      .spacedRepetitionContent {
          height: 100%;
          box-sizing: border-box;
      }

      /* Set initial state to collapsed */
      .queue__title {
        max-height: 0;
        overflow: hidden;
        transition: max-height 0.3s ease;
      }

      /* Expand on hover */
      .queue__title:hover {
        max-height: 999px;
      }
    `.trim();
    
    
    if (collapseTopBarKey in changes) {
      const shouldCollapse = await plugin.storage.getSession(collapseTopBarKey);
      plugin.app.registerCSS(
        collapseTopBarId,
        shouldCollapse ? COLLAPSE_TOP_BAR_CSS : ''
      );
    }
  });
  
  // Note: doesn't handle rem just tagged with incremental rem powerup because they don't have powerup slots yet
  // so added special handling in initIncrementalRem
  plugin.track(async (rp) => {
    const powerup = await rp.powerup.getPowerupByCode(powerupCode);
    const taggedRem = (await powerup?.taggedRem()) || [];
    const updatedAllRem = (
      await Promise.all(taggedRem.map((rem) => getIncrementalRemInfo(plugin, rem)))
    ).filter((x) => !!x);
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
  });

  // TODO: some handling to include extracts created in current queue in the queue?
  // or unnecessary due to init interval? could append to this list

  let allRemInFolderQueue: RemId[] | undefined = undefined;
  let seenRem: Set<RemId> = new Set<RemId>();
  plugin.event.addListener(AppEvents.QueueExit, undefined, async ({ subQueueId }) => {
    allRemInFolderQueue = undefined;
    seenRem = new Set<RemId>();
  });
  plugin.event.addListener(AppEvents.QueueEnter, undefined, async ({ subQueueId }) => {
    allRemInFolderQueue = undefined;
    seenRem = new Set<RemId>();
  });

  const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
    powerupCode,
    nextRepDateSlotCode
  );

  plugin.app.registerCommand({
    id: nextRepCommandId,
    name: 'Next Repetition',
    action: async () => {
      const rem = await getCurrentIncrementalRem(plugin);
      const url = await plugin.window.getURL();
      debugger;
      if (!rem || !url.includes('/flashcards')) {
        return;
      }
      const incRem = await getIncrementalRemInfo(plugin, rem);
      await handleHextRepetitionClick(plugin, incRem);
    },
  });

  const unregisterQueueCSS = async (plugin: RNPlugin) => {
    await plugin.app.registerCSS(collapseTopBarId, '');
  };

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      console.log('queueInfo', queueInfo);
      const allIncrementalRem: IncrementalRem[] =
        (await plugin.storage.getSession(allIncrementalRemKey)) || [];
      if (queueInfo.subQueueId && allRemInFolderQueue === undefined) {
        const subQueueRem = await plugin.rem.findOne(queueInfo.subQueueId);
        // special handling for studying a daily doc because
        // the referenced rem are nextRepDate slots not the incRem
        const referencedRemIds = _.compact(
          ((await subQueueRem?.remsReferencingThis()) || []).map((rem) => {
            if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
              return rem.parent;
            } else {
              return rem._id;
            }
          })
        );
        allRemInFolderQueue = ((await subQueueRem?.allRemInFolderQueue()) || [])
          .map((x) => x._id)
          // not included in allRemInFolderQueue for some reason...
          .concat(((await subQueueRem?.getSources()) || []).map((x) => x._id))
          .concat(referencedRemIds)
          .concat(queueInfo.subQueueId);
      }
      let ratio: number | 'no-rem' | 'no-cards' = await getRatioBetweenCardsAndIncrementalRem(
        plugin
      );

      const intervalBetweenIncRem = typeof ratio === 'string' ? ratio : Math.round(1 / ratio);
      const totalElementsSeen = queueInfo.cardsPracticed + seenRem.size;
      const sorted = _.sortBy(allIncrementalRem, (incRem) => {
        if (queueInfo.mode === 'in-order') {
          return allRemInFolderQueue!.indexOf(incRem.remId);
        } else {
          return incRem.priority;
        }
      });
      const filtered = sorted.filter((x) =>
        queueInfo.mode === 'practice-all' || queueInfo.mode === 'in-order'
          ? (!queueInfo.subQueueId || allRemInFolderQueue?.includes(x.remId)) &&
            (!seenRem.has(x.remId) || Date.now() >= x.nextRepDate)
          : (!queueInfo.subQueueId || allRemInFolderQueue?.includes(x.remId)) &&
            Date.now() >= x.nextRepDate
      );

      plugin.app.registerCSS(
        queueCounterId,
        `
.rn-queue__card-counter {
  visibility: hidden;
}

.light .rn-queue__card-counter:after {
  content: '${queueInfo.numCardsRemaining} + ${filtered.length}';
  visibility: visible;
  background-color: #f0f0f0;
  display: inline-block;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  border-radius: 0.25rem;
}

.dark .rn-queue__card-counter:after {
  content: '${queueInfo.numCardsRemaining} + ${filtered.length}';
  visibility: visible;
  background-color: #34343c;
  font-color: #d4d4d0;
  display: inline-block;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  border-radius: 0.25rem;
}`.trim()
      );

      if (
        (totalElementsSeen > 0 &&
          typeof intervalBetweenIncRem === 'number' &&
          totalElementsSeen % intervalBetweenIncRem === 0) ||
        queueInfo.numCardsRemaining === 0 ||
        intervalBetweenIncRem === 'no-cards'
      ) {
        // do n random swaps
        const sortingRandomness = await getSortingRandomness(plugin);
        const num_random_swaps = sortingRandomness * allIncrementalRem.length;
        for (let i = 0; i < num_random_swaps; i++) {
          const idx1 = Math.floor(Math.random() * filtered.length);
          const idx2 = Math.floor(Math.random() * filtered.length);
          const temp = filtered[idx1];
          filtered[idx1] = filtered[idx2];
          filtered[idx2] = temp;
        }

        if (filtered.length === 0) {
          unregisterQueueCSS(plugin);
          return null;
        } else {
          // make sure we don't show a rem that has been deleted
          let first = filtered[0];
          while (!(await getIncrementalRemInfo(plugin, await plugin.rem.findOne(first.remId)))) {
            filtered.shift();
            if (filtered.length === 0) {
              return null;
            } else {
              first = filtered[0];
            }
          }
          seenRem.add(first.remId);
          console.log('nextRep', first, 'due', dayjs(first.nextRepDate).fromNow());
          return {
            remId: first.remId,
            pluginId: 'incremental-everything',
          };
        }
      } else {
        unregisterQueueCSS(plugin);
        return null;
      }
    }
  );

  async function initIncrementalRem(rem: Rem) {
    const initialInterval = (await plugin.settings.getSetting<number>(initialIntervalId)) || 0;
    const initialIntervalInMs = initialInterval * 24 * 60 * 60 * 1000;

    await rem.addPowerup(powerupCode);

    const nextRepDate = new Date(Date.now() + initialIntervalInMs);
    const dateRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
    if (!dateRef) {
      return;
    }

    await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef);
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, ['10']);

    const newIncRem = await getIncrementalRemInfo(plugin, rem);
    if (!newIncRem) {
      return;
    }

    const allIncrementalRem: IncrementalRem[] =
      (await plugin.storage.getSession(allIncrementalRemKey)) || [];
    const updatedAllRem = allIncrementalRem
      .filter((x) => x.remId !== newIncRem.remId)
      .concat(newIncRem);
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
  }

  plugin.app.registerWidget('priority', WidgetLocation.Popup, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  const createExtract = async () => {
    const selection = await plugin.editor.getSelection();
    if (!selection) {
      return;
    }
    // TODO: extract within extract support
    if (selection.type === SelectionType.Text) {
      const focused = await plugin.focus.getFocusedRem();
      if (!focused) {
        return;
      }
      await initIncrementalRem(focused);
      return focused;
    } else if (selection.type === SelectionType.Rem) {
      const rems = (await plugin.rem.findMany(selection.remIds)) || [];
      await Promise.all(rems.map(initIncrementalRem));
    } else {
      const highlight = await plugin.reader.addHighlight();
      if (!highlight) {
        return;
      }
      await initIncrementalRem(highlight);
      return highlight;
    }
  };

  await plugin.app.registerCommand({
    id: 'extract-with-priority',
    name: 'Extract with Priority',
    keyboardShortcut: 'opt+shift+x',
    action: async () => {
      const rem = await createExtract();
      if (!rem) {
        return;
      }
      await plugin.widget.openPopup('priority', {
        remId: rem._id,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'set-priority',
    name: 'Set Priority',
    keyboardShortcut: 'opt+p',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      if (!(await rem.hasPowerup(powerupCode))) {
        await initIncrementalRem(rem);
      }
      await plugin.widget.openPopup('priority', {
        remId: rem._id,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'incremental-everything',
    keyboardShortcut: 'opt+x',
    name: 'Incremental Everything',
    action: async () => {
      createExtract();
    },
  });

  plugin.app.registerCommand({
    id: 'untag-incremental-everything',
    name: 'Untag Incremental Everything',
    action: async () => {
      const selection = await plugin.editor.getSelection();
      if (!selection) {
        return;
      }
      if (selection.type === SelectionType.Text) {
        const focused = await plugin.focus.getFocusedRem();
        if (!focused) {
          return;
        }
        await focused.removePowerup(powerupCode);
      } else if (selection.type === SelectionType.Rem) {
        const rems = (await plugin.rem.findMany(selection.remIds)) || [];
        await Promise.all(rems.map((r) => r.removePowerup(powerupCode)));
      }
    },
  });

  plugin.app.registerWidget('debug', WidgetLocation.Popup, {
    dimensions: {
      width: '350px',
      height: 'auto',
    },
  });

  plugin.app.registerCommand({
    id: 'debug-incremental-everything',
    name: 'Debug Incremental Everything',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      if (!(await rem.hasPowerup(powerupCode))) {
        return;
      }
      await plugin.widget.openPopup('debug', {
        remId: rem._id,
      });
    },
  });

  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    const url = await plugin.window.getURL();
    if (!url.includes('/flashcards')) {
      plugin.app.unregisterMenuItem(scrollToHighlightId);
      plugin.app.registerCSS(collapseTopBarId, '');
      plugin.app.registerCSS(queueCounterId, '');
      plugin.app.registerCSS(hideIncEverythingId, '');
      setCurrentIncrementalRem(plugin, undefined);
    } else {
    }
  });

  plugin.app.registerWidget('queue', WidgetLocation.Flashcard, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    queueItemTypeFilter: QueueItemType.Plugin,
  });
  plugin.app.registerWidget('answer_buttons', WidgetLocation.FlashcardAnswerButtons, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    queueItemTypeFilter: QueueItemType.Plugin,
  });

  plugin.app.registerWidget('sorting_criteria', WidgetLocation.Popup, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  plugin.app.registerMenuItem({
    id: 'sorting_criteria_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Sorting Criteria',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_rem_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Toggle tag as Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      const isIncremental = await rem.hasPowerup(powerupCode);
      if (isIncremental) {
        await rem.removePowerup(powerupCode);
      } else {
        await initIncrementalRem(rem);
      }
      const msg = isIncremental ? 'Untagged as Incremental Rem' : 'Tagged as Incremental Rem';
      await plugin.app.toast(msg);
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_highlight',
    location: PluginCommandMenuLocation.PDFHighlightPopupLocation,
    name: 'Tag as Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      await initIncrementalRem(rem);
      await plugin.app.toast('Tagged as Incremental Rem');
    },
    iconUrl: 'https://cdn-icons-png.flaticon.com/512/2232/2232688.png',
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
