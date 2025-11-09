import {
  ReactRNPlugin,
  PropertyLocation,
  PropertyType,
  PluginRem,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  initialIntervalId,
  defaultPriorityId,
  allIncrementalRemKey,
} from '../lib/consts';
import { getDailyDocReferenceForDate } from '../lib/date';
import { getInitialPriority } from '../lib/priority_inheritance';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { IncrementalRem } from '../lib/types';

export async function registerPluginPowerups(plugin: ReactRNPlugin) {
  // New, corrected registerPowerup format with a single object (since plugin-sdk@0.0.39)
  // `slots` is nested inside `options`
  await plugin.app.registerPowerup({
    name: 'Incremental',
    code: powerupCode,
    description: 'Incremental Everything Powerup',
    options: {
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
    },
  });

  // Create Separate Flashcard Priority Powerup
  await plugin.app.registerPowerup({
    name: 'CardPriority',
    code: 'cardPriority',
    description: 'Priority system for flashcards',
    options: {
      slots: [
        {
          code: 'priority',
          name: 'Priority',
          propertyType: PropertyType.NUMBER,
          propertyLocation: PropertyLocation.BELOW,
        },
        {
          code: 'prioritySource',
          name: 'Priority Source',
          propertyType: PropertyType.TEXT,
          propertyLocation: PropertyLocation.BELOW,
        },
        {
          code: 'lastUpdated',
          name: 'Last Updated',
          propertyType: PropertyType.NUMBER,  // Timestamp
          hidden: true,
        }
      ],
    },
  });
}

export async function initIncrementalRem(plugin: ReactRNPlugin, rem: PluginRem) {
  // First, check if the Rem has already been initialized.
  const isAlreadyIncremental = await rem.hasPowerup(powerupCode);

  // Only set the default values if it's a new incremental Rem.
  if (!isAlreadyIncremental) {
    const initialInterval = (await plugin.settings.getSetting<number>(initialIntervalId)) || 0;

    // Get the default priority from settings
    const defaultPrioritySetting = (await plugin.settings.getSetting<number>(defaultPriorityId)) || 10;
    const defaultPriority = Math.min(100, Math.max(0, defaultPrioritySetting));

    // Try to inherit priority from closest incremental ancestor
    const initialPriority = await getInitialPriority(plugin, rem, defaultPriority);

    await rem.addPowerup(powerupCode);

    const nextRepDate = new Date(Date.now() + (initialInterval * 24 * 60 * 60 * 1000));
    const dateRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
    if (!dateRef) {
      return;
    }

    await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef);
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [initialPriority.toString()]);

    // Initialize the history property to prevent validation errors.
    await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify([])]);


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
}
