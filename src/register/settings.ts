import { ReactRNPlugin, PluginNumberSetting } from '@remnote/plugin-sdk';
import {
  collapseQueueTopBar,
  collapseTopBarCssId,
  hideCardPriorityTagSettingId,
  showLeftBorderForIncRemsSettingId,
  showDismissedIndicatorSettingId,
  hideDismissedTagSettingId,
} from '../lib/consts';
import { PRIORITY_BAND_TAG_HIDE_CSS } from '../lib/priority_bands';
import {
  IE_SETTINGS_DEFAULTS,
  IE_SETTINGS_SCHEMA,
  IE_DOCS_BASE_URL,
  IESettingId,
  MORE_SETTINGS_POINTER,
  SettingSpec,
  getIESetting,
} from '../lib/settings';

const hideCardPriorityTagId = 'hide-card-priority-tag';
const HIDE_CARD_PRIORITY_CSS = `
  [data-rem-tags~="cardpriority"] .hierarchy-editor__tag-bar__tag {
  display: none; }
`;

const showLeftBorderForIncRemsId = 'show-left-border-for-increms';
const SHOW_LEFT_BORDER_CSS = `
  /* Row-level marker. This is the only one that reaches the queue, portals,
     hover popups and PDF highlights — none of them build the editor container
     div the block rule below depends on. */
  .rem[data-rem-tags~="incremental"] {
    border-left: 3px solid green;
    padding-left: 5px;
  }
  /* Block-level marker in the editor: the container div's box spans the rem AND
     its descendants, so bordering it carries the indicator down the whole
     block. Nothing subtler works here — the editor DOM is flat and absolutely
     positioned, and a rem's descendants (and even its own indentation-guide
     div) are root-level siblings of this element, not children, so no
     descendant or child combinator can reach them. Tailwind's border utilities
     on the container are !important, so ours has to be too.

     The :has() guard excludes exactly one thing: the open document's own
     container, whose box spans the entire document (measured 2901px vs 106px
     for an ordinary rem) and would otherwise draw a bar down the full page.
     RemNote renders the document title once, through .rn-doc-title, so the root
     node renders no .rem row while every other container does — that is the
     only difference between them, their class lists being identical. Anything
     scoped on .rn-document / data-document-tags would be wrong here: those sit
     above the editor and are ancestors of every container equally. */
  [data-rem-container-tags~="incremental"]:has(.rem[data-rem-tags~="incremental"]) {
    border-left: 3px solid green !important;
  }
  /* Where the block rule applies, drop the row bar: the two sit a few pixels
     apart and read as one smeared marker. Descendant rems are unaffected —
     their container divs are siblings, not descendants, of this one. */
  [data-rem-container-tags~="incremental"] .rem[data-rem-tags~="incremental"] {
    border-left: none;
    padding-left: 0;
  }
  /* Same indicator on the document title. There is no .rem wrapper here; the
     document's tags live in data-document-tags on the .rn-document element. */
  .rn-document[data-document-tags~="incremental"] .rn-doc-title {
    border-left: 3px solid green;
    padding-left: 5px;
  }
`;

const showDismissedIndicatorId = 'show-dismissed-indicator';
const SHOW_DISMISSED_INDICATOR_CSS = `
  .rem[data-rem-tags~="dismissed"]:not([data-rem-tags~="incremental"]) {
    border-left: 3px solid #f59e0b;
    padding-left: 5px;
  }
  /* Block-level marker; see the incremental rules above for why the container
     div is the only element that spans the block. */
  [data-rem-container-tags~="dismissed"]:not([data-rem-container-tags~="incremental"]):has(.rem[data-rem-tags~="dismissed"]) {
    border-left: 3px solid #f59e0b !important;
  }
  [data-rem-container-tags~="dismissed"]:not([data-rem-container-tags~="incremental"])
    .rem[data-rem-tags~="dismissed"]:not([data-rem-tags~="incremental"]) {
    border-left: none;
    padding-left: 0;
  }
  /* Same indicator on the document title; suppressed when also incremental so
     the green border wins, matching the outline behaviour above. */
  .rn-document[data-document-tags~="dismissed"]:not([data-document-tags~="incremental"]) .rn-doc-title {
    border-left: 3px solid #f59e0b;
    padding-left: 5px;
  }
`;

const hideDismissedTagId = 'hide-dismissed-tag';
const HIDE_DISMISSED_TAG_CSS = `
  [data-rem-tags~="dismissed"] .hierarchy-editor__tag-bar__tag {
    display: none;
  }
`;

const COLLAPSE_TOP_BAR_CSS = `
  /* Collapse the top bar only during IncRem (Plugin) turns.
     Gated on the queue iframe so regular flashcard turns are unaffected.
     Two fixes over the naive max-height:0 approach:
     1. Use max-height: 3px instead of 0 — gives a thin visible strip as a hover target
        (a 0-height element receives no hover events).
     2. Hide .rn-queue__progress-bar — the progress bar sits immediately below and has
        an invisible absolute overlay that steals hover events. It also shows flashcard
        queue progress which is not meaningful during IncRem turns. */
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .queue__title {
    max-height: 3px;
    overflow: hidden;
    /* collapse: wait 0.6s after mouse leaves, then animate over 0.4s */
    transition: max-height 0.4s ease 0.6s;
    cursor: pointer;
  }
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .queue__title:hover {
    max-height: 180px;
    overflow: visible;
    /* expand: start immediately, smooth over 0.25s */
    transition: max-height 0.25s ease 0s;
  }
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .rn-queue__progress-bar {
    display: none !important;
  }
`;

/**
 * Renders a schema entry's prose for RemNote's settings panel, which takes a
 * single plain-text string: warning first, then the description, then the docs
 * link and the reload note.
 *
 * @param isLast Append MORE_SETTINGS_POINTER. Passed for whichever setting is
 *   registered last, so the pointer reads as the closing line of the plugin's
 *   section — RemNote gives us no heading or footer of our own.
 */
function panelDescription(spec: SettingSpec, isLast: boolean): string {
  const parts: string[] = [];
  if (spec.warning) parts.push(`⚠️ ${spec.warning}`);
  parts.push(spec.description);
  if (spec.helpPath) parts.push(`Documentation: ${IE_DOCS_BASE_URL}${spec.helpPath}`);
  if (spec.reloadRequired) parts.push('Takes effect after reloading RemNote.');
  if (isLast) parts.push(MORE_SETTINGS_POINTER);
  return parts.join('\n\n');
}

/** Registers one schema entry with RemNote, picking the register* call by kind. */
async function registerFromSchema(plugin: ReactRNPlugin, id: IESettingId, isLast: boolean) {
  const spec = IE_SETTINGS_SCHEMA[id];
  const common = { id, title: spec.title, description: panelDescription(spec, isLast) };

  switch (spec.kind) {
    case 'boolean':
      await plugin.settings.registerBooleanSetting({
        ...common,
        defaultValue: IE_SETTINGS_DEFAULTS[id] as boolean,
      });
      return;
    case 'number': {
      const validators = [
        ...(spec.integer ? [{ type: 'int' as const }] : []),
        ...(spec.min !== undefined ? [{ type: 'gte' as const, arg: spec.min }] : []),
        ...(spec.max !== undefined ? [{ type: 'lte' as const, arg: spec.max }] : []),
      ];
      await plugin.settings.registerNumberSetting({
        ...common,
        defaultValue: IE_SETTINGS_DEFAULTS[id] as number,
        ...(validators.length ? { validators } : {}),
      } as PluginNumberSetting);
      return;
    }
    case 'string':
      await plugin.settings.registerStringSetting({
        ...common,
        defaultValue: IE_SETTINGS_DEFAULTS[id] as string,
      });
      return;
    case 'dropdown':
      await plugin.settings.registerDropdownSetting({
        ...common,
        defaultValue: IE_SETTINGS_DEFAULTS[id] as string,
        options: spec.options.map((o) => ({ key: o.value, label: o.label, value: o.value })),
      });
      return;
  }
}

/**
 * Registers plugin settings with RemNote and applies the startup CSS that some
 * of them drive.
 *
 * Titles, descriptions, control types and defaults all come from
 * IE_SETTINGS_SCHEMA / IE_SETTINGS_DEFAULTS in lib/settings.ts, so the panel and
 * the IE Settings popup can never describe the same setting differently.
 *
 * @param plugin RemNote plugin entry point.
 * @param opts.ids The settings to put into RemNote's own panel — only those the
 *   migration still has to read across (`settingIdsNeedingRegistration`), which
 *   is EMPTY for an up-to-date knowledge base. `getSetting` throws for an
 *   unregistered id, so a value can only be read while its registration is live;
 *   once read, the IE Settings popup owns it and the panel entry would only
 *   confuse. The CSS below is registered regardless.
 */
export async function registerPluginSettings(
  plugin: ReactRNPlugin,
  opts: { ids: IESettingId[] }
) {
  for (let i = 0; i < opts.ids.length; i++) {
    await registerFromSchema(plugin, opts.ids[i], i === opts.ids.length - 1);
  }

  // --- Startup CSS driven by the toggles above ---
  // registerCSS is index-only (it silently no-ops from other iframes). These
  // read their setting through getIESetting, i.e. from the plugin's own store,
  // so they are unaffected by whether anything was registered above.

  if (await getIESetting(plugin, collapseQueueTopBar)) {
    await plugin.app.registerCSS(collapseTopBarCssId, COLLAPSE_TOP_BAR_CSS);
  }
  if (await getIESetting(plugin, hideCardPriorityTagSettingId)) {
    await plugin.app.registerCSS(hideCardPriorityTagId, HIDE_CARD_PRIORITY_CSS);
  }
  if (await getIESetting(plugin, showLeftBorderForIncRemsSettingId)) {
    await plugin.app.registerCSS(showLeftBorderForIncRemsId, SHOW_LEFT_BORDER_CSS);
  }
  if (await getIESetting(plugin, showDismissedIndicatorSettingId)) {
    await plugin.app.registerCSS(showDismissedIndicatorId, SHOW_DISMISSED_INDICATOR_CSS);
  }
  if (await getIESetting(plugin, hideDismissedTagSettingId)) {
    await plugin.app.registerCSS(hideDismissedTagId, HIDE_DISMISSED_TAG_CSS);
  }

  // Unconditional: the band tags are an implementation detail, so their tag-bar
  // chips stay hidden even when the badges themselves are switched off.
  await plugin.app.registerCSS('priority-band-tag-hide', PRIORITY_BAND_TAG_HIDE_CSS);

  // The table-cell badge stylesheet itself (gated on showPriorityBandsInTables)
  // is registered by registerTableBandBadgeCSS from index.tsx, which re-runs
  // when the band→percentile colour mapping changes.
}
