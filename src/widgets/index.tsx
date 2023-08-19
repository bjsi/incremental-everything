import {
  AppEvents,
  declareIndexPlugin,
  PluginCommandMenuLocation,
  PropertyLocation,
  PropertyType,
  ReactRNPlugin,
  Rem,
  RemId,
  SelectionType,
  SpecialPluginCallback,
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
} from '../lib/consts';
import * as _ from 'remeda';
import { getSortingRandomness, getRatioBetweenCardsAndIncrementalRem } from '../lib/sorting';
import { IncrementalRem } from '../lib/types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { getDailyDocReferenceForDate } from '../lib/date';
dayjs.extend(relativeTime);

async function onActivate(plugin: ReactRNPlugin) {
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

  await plugin.app.registerWidget('queue', WidgetLocation.Flashcard, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  await plugin.app.registerWidget('answer_buttons', WidgetLocation.FlashcardAnswerButtons, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
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

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      console.log('queueInfo', queueInfo);
      const allIncrementalRem: IncrementalRem[] =
        (await plugin.storage.getSession(allIncrementalRemKey)) || [];
      if (queueInfo.subQueueId && allRemInFolderQueue === undefined) {
        const subQueueRem = await plugin.rem.findOne(queueInfo.subQueueId);
        allRemInFolderQueue = ((await subQueueRem?.allRemInFolderQueue()) || [])
          .map((x) => x._id)
          // not included in allRemInFolderQueue for some reason...
          .concat(((await subQueueRem?.getSources()) || []).map((x) => x._id))
          .concat(queueInfo.subQueueId);
      }
      const intervalBetweenIncRem = Math.round(
        1 / (await getRatioBetweenCardsAndIncrementalRem(plugin))
      );

      const totalElementsSeen = queueInfo.cardsPracticed + seenRem.keys.length;
      if (
        (totalElementsSeen > 0 && totalElementsSeen % intervalBetweenIncRem === 0) ||
        queueInfo.numCardsRemaining === 0
      ) {
        const sorted = _.sortBy(allIncrementalRem, (incRem) => {
          if (queueInfo.mode === 'in-order') {
            return allRemInFolderQueue!.indexOf(incRem.remId);
          } else {
            return incRem.priority;
          }
        });
        console.log('sorted', sorted);
        const filtered = sorted.filter((x) =>
          queueInfo.mode === 'practice-all' || queueInfo.mode === 'in-order'
            ? (!queueInfo.subQueueId || allRemInFolderQueue?.includes(x.remId)) &&
              (!seenRem.has(x.remId) || Date.now() >= x.nextRepDate)
            : (!queueInfo.subQueueId || allRemInFolderQueue?.includes(x.remId)) &&
              Date.now() >= x.nextRepDate
        );

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
          return null;
        } else {
          const first = filtered[0];
          seenRem.add(first.remId);
          console.log('nextRep', first, 'due', dayjs(first.nextRepDate).fromNow());
          return {
            remId: first.remId,
            pluginId: 'incremental-everything',
          };
        }
      } else {
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
    if (selection.type === SelectionType.Rem || selection.type === SelectionType.Text) {
      const focused = await plugin.focus.getFocusedRem();
      if (!focused) {
        return;
      }
      await initIncrementalRem(focused);
      return focused;
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
    id: 'extract',
    name: 'Extract',
    keyboardShortcut: 'opt+x',
    action: async () => {
      console.log('createExtract');
      await createExtract();
    },
  });

  await plugin.app.registerCommand({
    id: 'extract-with-priority',
    name: 'Extract with Priority',
    keyboardShortcut: 'opt+shift+x',
    action: async () => {
      console.log('createExtract with priority');
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
    name: 'Incremental Everything',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      await initIncrementalRem(rem);
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

  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    plugin.app.unregisterMenuItem(scrollToHighlightId);
    plugin.app.registerCSS(collapseTopBarId, '');
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
    name: 'Tag as Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      await initIncrementalRem(rem);
      await plugin.app.toast('Tagged as Incremental Rem');
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
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
