import {
  declareIndexPlugin,
  ReactRNPlugin,
  Rem,
  SpecialPluginCallback,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import {
  nextRepDateSlotCode,
  powerupCode,
  prioritySlotCode,
  repHistorySlotCode,
} from '../lib/consts';
import * as _ from 'remeda';

interface IncrementalRep {
  date: number;
}

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

  let allIncrementalRem: { rem: Rem; nextRepDate: number; priority: number; history: any[] }[];

  const tryParseJson = (x: any) => {
    try {
      return JSON.parse(x);
    } catch (e) {
      return undefined;
    }
  };

  plugin.track(async (rp) => {
    const powerup = await rp.powerup.getPowerupByCode(powerupCode);
    const taggedRem = (await powerup?.taggedRem()) || [];
    allIncrementalRem = (
      await Promise.all(
        taggedRem.map(async (r) => {
          return {
            rem: r,
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

  let sortingRandomness: number = 0;
  let ratioBetweenCardsAndIncrementalRem: number = 0.25; // 1 incremental rem for every 4

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (infoAboutCurrentQueue) => {
      const num_random_swaps = sortingRandomness * allIncrementalRem.length;
      const interval = Math.round(1 / ratioBetweenCardsAndIncrementalRem);
      if (interval % infoAboutCurrentQueue.cardsPracticed === 0) {
        const sorted = _.sortBy(allIncrementalRem, (x) => x.priority).filter((x) =>
          infoAboutCurrentQueue.mode === 'practice-all' ? true : Date.now() >= x.nextRepDate
        );
        if (sorted.length === 0) {
          return null;
        } else {
          const first = sorted[0];
          return {
            remId: first.rem._id,
            pluginId: 'incremental-everything',
            alwaysRenderAnswer: true,
          };
        }
      } else {
        return null;
      }
    }
  );

  plugin.app.registerCallback<SpecialPluginCallback.SRSScheduleCard>(
    SpecialPluginCallback.SRSScheduleCard,
    async (args) => {
      const rem = await plugin.rem.findOne(args.remId);
      const history = tryParseJson(await rem?.getPowerupProperty(powerupCode, repHistorySlotCode));
      const prevRep = _.last(history) as IncrementalRep;
      const interval = prevRep ? (Date.now() - prevRep.date) / (1000 * 60 * 60 * 24) : 1;
      const newInterval = Math.round(interval * 2);
      const newNextRepDate = Date.now() + newInterval * 1000 * 60 * 60 * 24;
      const newHistory = [...(history || []), { date: Date.now() }];
      await rem?.setPowerupProperty(powerupCode, nextRepDateSlotCode, [newNextRepDate.toString()]);
      await rem?.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(newHistory)]);
      return { nextDate: newNextRepDate, dontSave: true };
    }
  );

  plugin.app.registerWidget('queue', WidgetLocation.Flashcard, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
