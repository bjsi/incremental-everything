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
  priorityGraphDataSlotCode,
  pdfStateSlotCode,
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
// Registration must use the same constants every READER uses. Hardcoding the code
// or slot codes here lets the definition drift away from the reads, and the failure
// mode is silent: getPowerupProperty() would simply return nothing for a rem that
// visibly carries the tag. card_priority/types is a leaf module of plain constants,
// so importing it here introduces no cycle.
import {
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
  SOURCE_SLOT,
  LAST_UPDATED_SLOT,
} from '../lib/card_priority/types';

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
          // PDF reading state — page, range, page history and active PDF, as
          // serialized JSON. Machine state, so hidden and programmatic-only.
          code: pdfStateSlotCode,
          name: 'Reading State',
          propertyType: PropertyType.TEXT,
          hidden: true,
          onlyProgrammaticModifying: true,
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
    code: CARD_PRIORITY_CODE,
    description: 'Priority system for flashcards',
    options: {
      slots: [
        {
          code: PRIORITY_SLOT,
          name: 'Priority',
          propertyType: PropertyType.NUMBER,
          propertyLocation: PropertyLocation.BELOW,
        },
        {
          code: SOURCE_SLOT,
          name: 'Priority Source',
          propertyType: PropertyType.TEXT,
          hidden: true,
        },
        {
          code: LAST_UPDATED_SLOT,
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
      slots: [
        {
          // The graph's own data, as serialized JSON. Hidden and
          // programmatic-only: it is machine state, not something to edit by hand.
          code: priorityGraphDataSlotCode,
          name: 'Graph Data',
          propertyType: PropertyType.TEXT,
          hidden: true,
          onlyProgrammaticModifying: true,
        },
      ],
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
        {
          // Mirror of the Incremental powerup's slot, same code and same shape.
          // Dismissal removes the Incremental powerup, so the reading state is
          // copied here to survive it and copied back on re-activation.
          code: pdfStateSlotCode,
          name: 'Reading State',
          propertyType: PropertyType.TEXT,
          hidden: true,
          onlyProgrammaticModifying: true,
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
