import {
  ReactRNPlugin,
  PropertyLocation,
  PropertyType,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  originalIncrementalDateSlotCode,
  priorityGraphPowerupCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  dismissedDateSlotCode,
  preservedHistoryPowerupCode,
  videoExtractPowerupCode,
  videoExtractUrlSlotCode,
  videoExtractStartSlotCode,
  videoExtractEndSlotCode,
} from '../lib/consts';
import { initIncrementalRem } from '../lib/incremental_rem';
import { BAND_COUNT, bandPowerupCode, bandPowerupName } from '../lib/priority_bands';

// Re-export for backwards compatibility
export { initIncrementalRem };

/**
 * Registers the Incremental Everything powerups (and card priority powerup) with RemNote.
 *
 * @param plugin ReactRNPlugin entry point used to communicate with RemNote.
 * @returns Promise that resolves once both powerups are registered.
 */
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
        {
          code: originalIncrementalDateSlotCode,
          name: 'Created',
          propertyType: PropertyType.DATE,
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
          hidden: true,
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

  await plugin.app.registerPowerup({
    name: 'Priority Review Graph',
    code: priorityGraphPowerupCode,
    description: 'Displays a distribution graph of priorities for items in this document.',
    options: {
      slots: [] // No special slots needed, we just use the tag as a trigger
    }
  });



  // Dismissed Powerup - stores history of previously Incremental Rems
  await plugin.app.registerPowerup({
    name: 'Dismissed',
    code: dismissedPowerupCode,
    description: 'Stores history of previously Incremental Rems',
    options: {
      slots: [
        {
          code: dismissedHistorySlotCode,
          name: 'History',
          hidden: true,
        },
        {
          code: dismissedDateSlotCode,
          name: 'Dismissed Date',
          propertyType: PropertyType.DATE,
          hidden: true,
        },
      ],
    },
  });

  // Preserved History Powerup - marks a "tombstone" rem whose content was
  // removed by 'Preserve history & remove' but whose review history was preserved
  // on its Dismissed powerup. No slots — it exists purely as a CSS hook
  // (data-rem-tags~="preservedhistory") to hide the tombstone in editor and queue.
  await plugin.app.registerPowerup({
    name: 'Preserved History',
    code: preservedHistoryPowerupCode,
    description:
      'Marks a rem whose content was removed but whose review history was preserved. Hidden from the editor and queue.',
    options: { slots: [] },
  });

  // Video Extract Powerup - stores start/end times for YouTube video segments
  await plugin.app.registerPowerup({
    name: 'VideoExtract',
    code: videoExtractPowerupCode,
    description: 'A segment extracted from a YouTube video with start/end times',
    options: {
      slots: [
        {
          code: videoExtractUrlSlotCode,
          name: 'Video URL',
          propertyType: PropertyType.TEXT,
          hidden: true,
        },
        {
          code: videoExtractStartSlotCode,
          name: 'Start Time',
          propertyType: PropertyType.NUMBER,
          hidden: true,
        },
        {
          code: videoExtractEndSlotCode,
          name: 'End Time',
          propertyType: PropertyType.NUMBER,
          hidden: true,
        },
      ],
    },
  });

  // Priority band powerups — one per band of ten. These exist purely as CSS
  // hooks: RemNote puts powerup slugs in `data-rem-tags` on the rem span, and
  // that attribute is the ONLY channel that reaches inside a table cell, where
  // no plugin widget can render. See lib/priority_bands.ts.
  for (let band = 0; band < BAND_COUNT; band++) {
    await plugin.app.registerPowerup({
      name: bandPowerupName(band),
      code: bandPowerupCode(band),
      description: `Priority ${band * 10}–${band * 10 + 9} — used to draw the table-cell priority badge. Managed automatically.`,
      options: { slots: [] },
    });
  }
}
