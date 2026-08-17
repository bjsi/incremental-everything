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
  hasImagePowerupCode,
  hasImagePowerupName,
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
  PRIORITY_VALUE_SLOT,
  SOURCE_SLOT,
  LAST_UPDATED_SLOT,
} from '../lib/card_priority/types';

// Re-export for backwards compatibility
export { initIncrementalRem };

/** The deprecated VISIBLE priority slot, kept only for knowledge bases that still
 *  have values in it. See {@link registerPluginPowerups}. */
const deprecatedVisiblePrioritySlot = {
  code: PRIORITY_SLOT,
  name: 'Priority',
  propertyType: PropertyType.NUMBER,
  // ONLY_IN_TABLE, the least visible location that still renders: the row under
  // every tagged rem in the outline is noise, and so is the one in the document
  // header (ONLY_DOCUMENT, what this was before) — after the migration it shows
  // as a bare "Priority — Empty" that cannot even be filled in usefully.
  //
  // This governs NEW slot definition Rems only. RemNote applies slot options when
  // the definition Rem is created and does not mutate an existing one on
  // re-registration — measured: a registration with `hidden: true` ran (the log
  // fired) while getPowerupSlotByCode kept resolving the slot natively, which it
  // only does for visible slots. An existing knowledge base therefore keeps
  // whatever location its slot Rem already has, and is fixed not by this line but
  // by the migration retiring the slot altogether.
  propertyLocation: PropertyLocation.ONLY_IN_TABLE,
};

/**
 * Registers the Incremental RemNote powerups (and card priority powerup) with RemNote.
 *
 * @param plugin ReactRNPlugin entry point used to communicate with RemNote.
 * @param opts.retireVisiblePrioritySlot Omit the deprecated visible `priority`
 *   slot from the CardPriority powerup. Passed when this knowledge base has been
 *   verified to hold nothing in it (`completedAt` in the migration record), which
 *   is what finally removes the leftover "Priority — Empty" row from the editor:
 *   the row is drawn from the slot DEFINITION, so it survives the values being
 *   deleted and only goes away when the definition stops being registered.
 *
 *   Gating a slot rather than a whole powerup is the same shape as the settings
 *   registration, which passes only the ids a knowledge base still has to read
 *   across. The unregistered slot's reads simply stop resolving —
 *   `readRawCardPriority` already tolerates that (both reads are `.catch`ed) and
 *   the write path is gated on the same migration record, so nothing targets a
 *   slot that is no longer there.
 * @returns Promise that resolves once both powerups are registered.
 */
export async function registerPluginPowerups(
  plugin: ReactRNPlugin,
  opts: { retireVisiblePrioritySlot?: boolean } = {}
) {
  // New, corrected registerPowerup format with a single object (since plugin-sdk@0.0.39)
  // `slots` is nested inside `options`
  await plugin.app.registerPowerup({
    name: 'Incremental',
    code: powerupCode,
    description: 'Incremental RemNote Powerup',
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
        // The deprecated visible slot, present only while this knowledge base may
        // still have values in it. See the note on the constant above.
        ...(opts.retireVisiblePrioritySlot ? [] : [deprecatedVisiblePrioritySlot]),
        // (logged below, so which of the two happened is verifiable in the console)
        {
          // Where the priority VALUE lives from v1.0.48 on. Hidden, so RemNote
          // stores it without materialising a property child rem — which is the
          // whole point: a visible slot's child is what makes a tagged rem that
          // is itself a table cell render "Priority — 31" in place of its own
          // value, in simple AND advanced tables alike.
          //
          // Registering this as a NEW code is what makes it work on an existing
          // knowledge base: slot options are applied when the slot definition rem
          // is created, so PRIORITY_SLOT above cannot be flipped, but a code that
          // never had a rem gets one created hidden. The visible slot is migrated
          // into this one by lib/card_priority/hidden_slot_migration.ts.
          code: PRIORITY_VALUE_SLOT,
          name: 'Priority Value',
          propertyType: PropertyType.NUMBER,
          hidden: true,
          onlyProgrammaticModifying: true,
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

  console.log(
    opts.retireVisiblePrioritySlot
      ? '[CardPriority hidden-slot] CardPriority registered WITHOUT the deprecated visible ' +
          '"Priority" slot — this knowledge base has been migrated.'
      : '[CardPriority hidden-slot] CardPriority registered WITH the deprecated visible ' +
          '"Priority" slot (not yet verified empty).'
  );

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

  // HasImage Powerup - marks a rem holding at least one image, so RemNote's own
  // document Filter can isolate them. No slots: the tag itself is the whole
  // payload, and the CSS hook is its data-rem-tags slug (`hasimage`).
  await plugin.app.registerPowerup({
    name: hasImagePowerupName,
    code: hasImagePowerupCode,
    description:
      'Marks a Rem that contains an image. Applied and removed by the "Tag Rems With Images" command; filter a document by this tag to see only its images.',
    options: { slots: [] },
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
