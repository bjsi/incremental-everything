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

export async function registerClozeExtractCSS(plugin: ReactRNPlugin) {
  const css = `
    /* Badge: violet ↑ pill before the bullet */
    [data-queue-rem-tags~="clozeextract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container,
    [data-queue-rem-tags~="cloze-extract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container {
      position: relative;
    }
    [data-queue-rem-tags~="clozeextract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container::before,
    [data-queue-rem-tags~="cloze-extract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container::before {
      content: '↑';
      background: #7c3aed;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.4;
      padding: 1px 5px;
      border-radius: 3px;
      margin-right: 4px;
    }
    /* Tooltip shown when hovering the bullet container */
    [data-queue-rem-tags~="clozeextract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container:hover::after,
    [data-queue-rem-tags~="cloze-extract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container:hover::after {
      content: 'Cloze child — created from a parent rem via Create Cloze Deletion';
      position: absolute;
      top: -30px;
      left: 0;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      font-size: 11px;
      font-weight: 400;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
      z-index: 100;
      pointer-events: none;
    }

    /* Editor: Make cloze-extract rems less conspicuous */
    .rn-editor [data-rem-tags~="clozeextract"] .rem-text,
    .rn-editor [data-rem-tags~="cloze-extract"] .rem-text {
      opacity: 0.5;
      filter: grayscale(40%);
      zoom: 0.8;
      transition: all 0.2s ease-in-out;
    }

    /* Reveal full opacity when focused/hovered for readability */
    .rn-editor [data-rem-tags~="clozeextract"]:focus-within .rem-text,
    .rn-editor [data-rem-tags~="cloze-extract"]:focus-within .rem-text,
    .rn-editor [data-rem-tags~="clozeextract"]:hover .rem-text,
    .rn-editor [data-rem-tags~="cloze-extract"]:hover .rem-text {
      opacity: 1;
      filter: grayscale(0%);
    }
  `;
  await plugin.app.registerCSS('cloze-extract-badge', css);
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
