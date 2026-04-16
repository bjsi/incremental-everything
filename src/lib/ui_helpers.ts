import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  queueCounterId,
  scrollToHighlightId,
  // collapseTopBarId, // Disabled: feature not working
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

export async function registerPluginHidingCSS(plugin: ReactRNPlugin) {

  const css = `
      /* Hide cardPriority Slots - Priority, Priority Source and Last Updated   */
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-property~="priority"],
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-container-property~="priority"],
      [data-rem-property~="priority"]:has(.rem-powerup-icon),
      [data-rem-container-property~="priority"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-property~="priority-source"],
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-container-property~="priority-source"],
      [data-rem-property~="priority-source"]:has(.rem-powerup-icon),
      [data-rem-container-property~="priority-source"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-property~="last-updated"],
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-container-property~="last-updated"],
      [data-rem-property~="last-updated"]:has(.rem-powerup-icon),
      [data-rem-container-property~="last-updated"]:has(.rem-powerup-icon),

      /* Hide Incremental Slots - Created and History */
      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-property~="created"],
      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-container-property~="created"],
      [data-rem-property~="created"]:has(.rem-powerup-icon),
      [data-rem-container-property~="created"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-property~="history"],
      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-container-property~="history"],
      [data-rem-property~="history"]:has(.rem-powerup-icon),
      [data-rem-container-property~="history"]:has(.rem-powerup-icon),

      /* Hide Dismissed Slots */
      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-property~="dismissed-history"],
      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-container-property~="dismissed-history"],
      [data-rem-property~="dismissed-history"]:has(.rem-powerup-icon),
      [data-rem-container-property~="dismissed-history"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-property~="dismissed-date"],
      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-container-property~="dismissed-date"],
      [data-rem-property~="dismissed-date"]:has(.rem-powerup-icon),
      [data-rem-container-property~="dismissed-date"]:has(.rem-powerup-icon) {
        display: none !important; 
      }
  `;

  await plugin.app.registerCSS('hide-plugin-properties-globally', css);

}

// Register CSS for PDF Highlight coloring based on tags
// This replaces the old manual color setting logic
export async function registerPdfHighlightCSS(plugin: ReactRNPlugin) {
  const css = `
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"],
    [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] { 
      background-color: #75ccf8 !important;
      padding-bottom: 2.7px;
    } 
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"],
    [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] { 
      background-color: #75f8b2 !important;
      padding-bottom: 2.7px;
    }
  `;

  await plugin.app.registerCSS('pdf-inc-highlight-styling', css);
}

/**
 * Clears all queue-specific UI elements (menu items and CSS).
 * Called when the user navigates away from the flashcards view.
 *
 * @param plugin Plugin instance
 */
export function clearQueueUI(plugin: ReactRNPlugin): void {
  plugin.app.unregisterMenuItem(scrollToHighlightId);
  // plugin.app.registerCSS(collapseTopBarId, ''); // Disabled: feature not working
  plugin.app.registerCSS(queueCounterId, '');
  plugin.app.registerCSS(hideIncEverythingId, '');
}
