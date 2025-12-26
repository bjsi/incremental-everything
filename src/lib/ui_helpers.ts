import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  queueCounterId,
  scrollToHighlightId,
  collapseTopBarId,
  hideIncEverythingId,
} from './consts';

/**
 * Registers CSS to display the incremental rem counter next to the flashcard counter.
 *
 * @param plugin Plugin instance
 * @param count Number of due incremental rems to display
 */
export function registerQueueCounter(plugin: ReactRNPlugin, count: number): void {
  const css = `
    .rn-queue__card-counter {
      /*visibility: hidden;*/
    }

    .light .rn-queue__card-counter:after {
      content: ' + ${count}';
    }

    .dark .rn-queue__card-counter:after {
      content: ' + ${count}';
    }
  `.trim();

  plugin.app.registerCSS(queueCounterId, css);
  console.log(`QUEUE ENTER: Queue counter updated to show ${count} due IncRems`);
}

export async function registerQueueHidingCSS(plugin: ReactRNPlugin) {
  
  const css = `
      /* Hide Priority and Priority Source Slots  */
      [data-rem-property~="priority"],
      [data-rem-container-property~="priority"],
      [data-rem-property~="priority-source"],
      [data-rem-container-property~="priority-source"] {
        display: none !important; 
      }
  `;

  await plugin.app.registerCSS('hide-priority-in-queue', css);

}

/**
 * Clears all queue-specific UI elements (menu items and CSS).
 * Called when the user navigates away from the flashcards view.
 *
 * @param plugin Plugin instance
 */
export function clearQueueUI(plugin: ReactRNPlugin): void {
  plugin.app.unregisterMenuItem(scrollToHighlightId);
  plugin.app.registerCSS(collapseTopBarId, '');
  plugin.app.registerCSS(queueCounterId, '');
  plugin.app.registerCSS(hideIncEverythingId, '');
}
