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
} from '../../lib/consts';
import { initIncrementalRem } from '../../lib/incremental_rem';

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
