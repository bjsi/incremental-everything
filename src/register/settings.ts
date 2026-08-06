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
  .rem[data-rem-tags~="incremental"] {
    border-left: 3px solid green;
    padding-left: 5px;
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
 */
function panelDescription(spec: SettingSpec): string {
  const parts: string[] = [];
  if (spec.warning) parts.push(`⚠️ ${spec.warning}`);
  parts.push(spec.description);
  if (spec.helpPath) parts.push(`Documentation: ${IE_DOCS_BASE_URL}${spec.helpPath}`);
  if (spec.reloadRequired) parts.push('Takes effect after reloading RemNote.');
  // Last, deliberately: on the final setting of the panel this is the pointer to
  // the settings popup, and it should read as the closing line of the section.
  if (spec.panelFooter) parts.push(spec.panelFooter);
  return parts.join('\n\n');
}

/** Registers one schema entry with RemNote, picking the register* call by kind. */
async function registerFromSchema(plugin: ReactRNPlugin, id: IESettingId) {
  const spec = IE_SETTINGS_SCHEMA[id];
  const common = { id, title: spec.title, description: panelDescription(spec) };

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
 * @param opts.includePopupTier Also register the settings that have moved into
 *   the IE Settings popup. True only while this knowledge base still needs
 *   seeding: `getSetting` throws for an unregistered id, so the migration can
 *   only read a value while its registration is live. Once seeded, these
 *   disappear from RemNote's panel and the popup owns them.
 */
export async function registerPluginSettings(
  plugin: ReactRNPlugin,
  opts: { includePopupTier: boolean }
) {
  const ids = (Object.keys(IE_SETTINGS_SCHEMA) as IESettingId[]).filter(
    (id) => IE_SETTINGS_SCHEMA[id].tier === 'native' || opts.includePopupTier
  );
  for (const id of ids) {
    await registerFromSchema(plugin, id);
  }

  // --- Startup CSS driven by the toggles above ---
  // registerCSS is index-only (it silently no-ops from other iframes), and these
  // read their setting through getIESetting, so they work whether the value
  // comes from RemNote's panel or the plugin's own store.

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
