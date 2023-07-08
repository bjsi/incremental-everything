import {
  AppEvents,
  declareIndexPlugin,
  ReactRNPlugin,
  Rem,
  SpecialPluginCallback,
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
  let cardsSeen: number = 0;

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, () => {
    cardsSeen++;
  });

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(SpecialPluginCallback.GetNextCard, async (infoAboutCurrentQueue) => {
    const num_random_swaps = sortingRandomness * allIncrementalRem.length;
    const interval = Math.round(1 / ratioBetweenCardsAndIncrementalRem);
    if (interval % cardsSeen === 0) {
      const sorted = _.sortBy(allIncrementalRem, (x) => x.priority).filter((x) =>
        infoAboutCurrentQueue.mode === 'practice-all' ? true : Date.now() >= x.nextRepDate
      );
      return sorted[0];
    } else {
      return null;
    }
  });

  plugin.app.registerCallback<SpecialPluginCallback.SRSScheduleCard>(SpecialPluginCallback.SRSScheduleCard, async (args) => {
    args.
    return {ignore: true}
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
