import {
  AppEvents,
  declareIndexPlugin,
  PluginCommandMenuLocation,
  ReactRNPlugin,
  Rem,
  RemId,
  SpecialPluginCallback,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import {
  initialIntervalId,
  multiplierId,
  nextRepDateSlotCode,
  powerupCode,
  prioritySlotCode,
  repHistorySlotCode,
} from '../lib/consts';
import * as _ from 'remeda';
import { sleep, tryParseJson } from '../lib/utils';
import { getSortingRandomness, getRatioBetweenCardsAndIncrementalRem } from '../lib/sorting';

async function onActivate(plugin: ReactRNPlugin) {
  await plugin.app.registerPowerup('Incremental', powerupCode, 'Incremental Everything Powerup', {
    slots: [
      {
        code: prioritySlotCode,
        name: 'priority',
      },
      {
        code: nextRepDateSlotCode,
        name: 'next rep date',
      },
      {
        code: repHistorySlotCode,
        name: 'rep history',
      },
    ],
  });

  let allIncrementalRem: {
    remId: string;
    nextRepDate: number;
    priority: number;
    history: any[];
  }[] = [];

  plugin.track(async (rp) => {
    const powerup = await rp.powerup.getPowerupByCode(powerupCode);
    const taggedRem = (await powerup?.taggedRem()) || [];
    // wait for the powerup slots to be populated
    await sleep(1000);
    allIncrementalRem = (
      await Promise.all(
        taggedRem.map(async (r) => {
          return {
            remId: r._id,
            nextRepDate: tryParseJson(
              await r.getPowerupProperty(powerupCode, nextRepDateSlotCode)
            ) as number,
            priority: tryParseJson(
              await r.getPowerupProperty(powerupCode, prioritySlotCode)
            ) as number,
            history: tryParseJson(
              await r.getPowerupProperty(powerupCode, repHistorySlotCode)
            ) as any[],
          };
        })
      )
    ).filter((x) => x.nextRepDate != null && x.priority != null);
  });

  // TODO: some handling to include extracts created in current queue in the queue?
  // or unnecessary due to init interval? could append to this list

  let allRemInFolderQueue: Set<RemId> = new Set<RemId>();
  plugin.event.addListener(AppEvents.QueueEnter, undefined, async ({ subQueueId }) => {
    if (subQueueId) {
      const subQueueRem = await plugin.rem.findOne(subQueueId);
      allRemInFolderQueue = new Set<RemId>((await subQueueRem?.allRemIdsInQueue()) || []);
    }
  });

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (infoAboutCurrentQueue) => {
      const sortingRandomness = await getSortingRandomness(plugin);
      const ratioBetweenCardsAndIncrementalRem = await getRatioBetweenCardsAndIncrementalRem(
        plugin
      );

      const num_random_swaps = sortingRandomness * allIncrementalRem.length;
      const interval = Math.round(1 / ratioBetweenCardsAndIncrementalRem);
      if (
        interval % infoAboutCurrentQueue.cardsPracticed === 0 ||
        infoAboutCurrentQueue.numCardsRemaining === 0
      ) {
        const sorted = _.sortBy(allIncrementalRem, (x) => x.priority).filter((x) =>
          infoAboutCurrentQueue.mode === 'practice-all'
            ? allRemInFolderQueue.has(x.remId)
            : Date.now() >= x.nextRepDate
        );
        // do n random swaps
        for (let i = 0; i < num_random_swaps; i++) {
          const idx1 = Math.floor(Math.random() * sorted.length);
          const idx2 = Math.floor(Math.random() * sorted.length);
          const temp = sorted[idx1];
          sorted[idx1] = sorted[idx2];
          sorted[idx2] = temp;
        }

        if (sorted.length === 0) {
          return null;
        } else {
          const first = sorted[0];
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
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, ['10']);
    await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, [
      (Date.now() + initialIntervalInMs).toString(),
    ]);
  }

  plugin.app.registerWidget('priority', WidgetLocation.Popup, {
    dimensions: {
      width: '100%',
      height: 'auto',
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

  plugin.app.registerWidget('answer_buttons', WidgetLocation.FlashcardAnswerButtons, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
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
    // TODO: change to DocumentMenu?
    location: PluginCommandMenuLocation.ReaderMenu,
    name: 'Tag as Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      await initIncrementalRem(rem);
    },
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
    defaultValue: 2,
  });

  plugin.app.registerWidget('queue', WidgetLocation.Flashcard, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
