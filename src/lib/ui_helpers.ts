import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  queueCounterId,
  scrollToHighlightId,
  // collapseTopBarId, // Disabled: feature not working
  hideIncEverythingId,
  pdfHighlightBordersEnabledKey,
  pdfHighlightBordersReloadKey,
} from './consts';

/**
 * Whether the pdfextract/incremental marker borders are currently drawn over
 * PDF-viewer highlights. Backed by a per-device local flag; defaults to ON.
 */
export async function getPdfHighlightBordersEnabled(plugin: ReactRNPlugin): Promise<boolean> {
  const stored = await plugin.storage.getLocal<boolean>(pdfHighlightBordersEnabledKey);
  return stored ?? true;
}

/**
 * "Peek" toggle: flip the marker-border flag. Persists the value in local storage
 * and bumps a session key so the index widget's plugin.track re-registers the CSS
 * (registerCSS is index-only, and this may run in the highlight-toolbar iframe).
 * Returns the new enabled state. Shared by the toggle command and toolbar button.
 */
export async function togglePdfHighlightBorders(plugin: ReactRNPlugin): Promise<boolean> {
  const next = !(await getPdfHighlightBordersEnabled(plugin));
  await plugin.storage.setLocal(pdfHighlightBordersEnabledKey, next);
  await plugin.storage.setSession(pdfHighlightBordersReloadKey, Date.now());
  return next;
}

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
  // "Peek" toggle: when disabled, the PDF-viewer marker borders are omitted so the
  // highlights read cleanly (original background only). Editor styling is unaffected.
  const bordersEnabled = await getPdfHighlightBordersEnabled(plugin);
  const pdfextractMarkers = bordersEnabled
    ? `border-bottom: 1.5px dashed #1565a8 !important;
      border-right: 3px solid #73a5cd !important;`
    : '';
  const incrementalMarkers = bordersEnabled
    ? `border-bottom: 1.5px dashed #15803d !important;
      border-right: 3px solid #4baf70 !important;`
    : '';
  const css = `
    /* PDF viewer: keep the highlight's ORIGINAL background and distinguish the tag
       with (a) a dashed underline and (b) a thin left bar. The underline gets
       covered by the next line's background between lines, so it's only a reliable
       marker at a block's bottom edge; the left bar is the dependable block marker
       — with box-decoration-break: clone it draws on every wrapped line, forming a
       vertical rule down the left edge regardless of what follows the extract.
       This base (unscoped) rule reaches both the PDF viewer and the editor; the
       editor is overridden below to keep its coloured background (no bar/underline).
       The border declarations are gated by the "peek" toggle (bordersEnabled). */
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"],
    [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] {
      ${pdfextractMarkers}
      padding-bottom: 2.7px;
      padding-left: 4px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    /* High-contrast text selection inside pdfextract highlights */
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"] ::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] ::selection,
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"]::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"]::selection {
      background-color: #0b2e6b !important;
      color: #ffffff !important;
    }
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"],
    [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] {
      ${incrementalMarkers}
      padding-bottom: 2.7px;
      padding-left: 4px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    /* High-contrast text selection inside incremental highlights */
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"] ::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] ::selection,
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"]::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"]::selection {
      background-color: #0b4a2e !important;
      color: #ffffff !important;
    }

    /* Editor: keep the coloured-background look (no underline). Overrides the
       dashed-underline base rules above. The dark-mode editor rules below only
       swap the background, so this border-bottom:none carries into dark mode too. */
    .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"],
    .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] {
      background-color: #8ad0f3 !important;
      border-bottom: none !important;
      border-right: none !important;
      padding-left: 0 !important;
    }
    .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"],
    .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] {
      background-color: #75f8b2 !important;
      border-bottom: none !important;
      border-right: none !important;
      padding-left: 0 !important;
    }

    /* Dark mode: darken highlight backgrounds so light text stays readable.
       Scoped to .rn-editor only. In the PDF viewer the highlight keeps its original
       background (see the base rules above) and is distinguished by the dashed
       underline instead, so no dark-mode background handling is needed there. */
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"],
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] {
      background-color: #1e496b !important;
    }
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"],
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] {
      background-color: #1a5c3a !important;
    }
    /* Dark mode (editor): lighten the selection so it stands out on the darkened
       background. The PDF viewer keeps the light-mode selection (navy/white). */
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"] ::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] ::selection,
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"]::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"]::selection {
      background-color: #7cc4f5 !important;
      color: #06203f !important;
    }
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"] ::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] ::selection,
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"]::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"]::selection {
      background-color: #6ee7a8 !important;
      color: #05381f !important;
    }

    [data-rem-tags~="pdfextract"] .hierarchy-editor__tag-bar__tag {
      font-size: 0px;
    }
    [data-rem-tags~="pdfextract"] .hierarchy-editor__tag-bar__tag:before {
      font-size: 12px;
      content: '✂️';
    }
  `;

  await plugin.app.registerCSS('pdf-inc-highlight-styling', css);
}

export async function registerIgnoreTagCSS(plugin: ReactRNPlugin) {
  const css = `
    /* Shrink and dim rems tagged with #ignore so they read as archived snippets */
    [data-rem-container-tags~="ignore"] .rem-text * {
      font-size: 0.85rem !important;
    }
    [data-rem-container-tags~="ignore"] .rem-text:not(:focus-within):not(:hover) * {
      opacity: 0.88;
    }

    /* Hide the #ignore tag chip in the editor tag bar to declutter */
    [data-rem-tags~="ignore"] .hierarchy-editor__tag-bar__tag {
      display: none;
    }
  `;
  await plugin.app.registerCSS('ignore-tag-styling', css);
}

export async function registerTagBadgeCSS(plugin: ReactRNPlugin) {
  const css = `
    /* Replace the "Incremental" powerup label with a 🔍 badge in the editor.

       A RemNote change made an applied powerup render in TWO places that both
       carry the .hierarchy-editor__tag-bar__tag class the old rule keyed on:
         1. the "Applied Powerup Pill" (a sibling of the Tag Bar), and
         2. a legacy pill inside [data-test="Tag Bar"] (shown when the rem has a
            single tag).
       The old broad selector matched both — and, because its only qualifier was
       "any rem tagged incremental", it also matched the pills of OTHER powerups
       (e.g. CardPriority) on the same rem. So the badge appeared twice and
       leaked onto unrelated powerups.

       Fix: badge only the Incremental Applied Powerup Pill (matched by its stable
       data-test), and hide the redundant Tag-Bar duplicate below. The extra
       .hierarchy-editor__tag-bar__tag qualifier keeps this off the document
       header's Applied Powerups Menu button, which reuses the same data-test but
       is a <button> whose inline font-size our reset can't override. */
    [data-test="Applied Powerup Pill Incremental"].hierarchy-editor__tag-bar__tag {
      font-size: 0px;
    }
    [data-test="Applied Powerup Pill Incremental"].hierarchy-editor__tag-bar__tag:before {
      font-size: 12px;
      content: '🔍';
    }

    /* Hide the powerup pill RemNote now duplicates inside the editor Tag Bar
       (only visible for single-tag rems); the Applied Powerup Pill above is the
       canonical representation. Scoped to our powerups via the rem's own
       data-rem-tags so we never hide an unrelated tag, and gated on
       .rem-powerup-icon (the ⚡) which marks a powerup pill, never a plain user
       tag. */
    [data-rem-tags~="incremental" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon),
    [data-rem-tags~="cardpriority" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon),
    [data-rem-tags~="dismissed" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon) {
      display: none;
    }
  `;
  await plugin.app.registerCSS('tag-badge-styling', css);
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

    /* Dark-mode contrast fix for the "already-clozed" source mark that Create
       Cloze Deletion applies to the parent text (yellow highlight + red font,
       see commands.ts). Bright-yellow-bg/red-text is low-contrast on a dark
       canvas; swap to deep amber + light coral. The yellow+red class pair is
       unique to our mark, so native RemNote clozes are left untouched. Covers
       both the editor leaf container and the queue linear-editor item. */
    .dark .has-highlight-color.highlight-color--yellow.text-color--red {
      background-color: #4a3700 !important;
      color: #ff9e80 !important;
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
