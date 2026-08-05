import { ReactRNPlugin, PluginNumberSetting } from '@remnote/plugin-sdk';
import {
  initialIntervalId,
  multiplierId,
  betaSchedulerEnabledId,
  betaFirstReviewIntervalId,
  betaMaxIntervalId,
  collapseQueueTopBar,
  collapseTopBarCssId,
  defaultPriorityId,
  defaultCardPriorityId,
  displayPriorityShieldId,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  remnoteEnvironmentId,
  isolatedQueueModeId,
  displayFsrsDsrId,
  fsrsWeightsId,
  displayQueueToolbarPriorityId,
  displayWeightedShieldId,
  autoFocusQueueDashboardId,
  enableHideInQueueIntegrationId,
  showPriorityBandsInTablesId,
  priorityStepSizeId,
  priorityEditorDisplayModeId,
  hideCardPriorityTagSettingId,
  showLeftBorderForIncRemsSettingId,
  showDismissedIndicatorSettingId,
  hideDismissedTagSettingId,
  performanceModeId,
  flashcardResponseTimeLimitId,
  skipMasteryDrillId,
  oldItemThresholdId,
  masteryDrillMinDelayMinutesId,
  disableFinalDrillNotificationId,
} from '../lib/consts';
import { PRIORITY_BAND_TAG_HIDE_CSS } from '../lib/priority_bands';
// Defaults live in lib/settings.ts and are read back here, so a registration
// and its default can never disagree. When these registrations are eventually
// retired, the table stays behind as the only source of defaults.
import { IE_SETTINGS_DEFAULTS, getIESetting } from '../lib/settings';

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

/**
 * Registers every plugin setting (numbers, dropdowns, toggles) and applies startup defaults (e.g. hiding CardPriority tags).
 * Settings covered:
 * - `initialIntervalId`, `multiplierId`, `collapseQueueTopBar`
 * - `hideCardPriorityTag`, `defaultPriorityId`, `defaultCardPriority`
 * - `performanceMode`, `alwaysUseLightModeOnMobileId`, `alwaysUseLightModeOnWebId`
 * - `displayPriorityShieldId`, `priorityEditorDisplayMode`
 * - `remnoteEnvironmentId`, `pdfHighlightColorId`
 *
 * @param plugin RemNote plugin entry point used to register settings/CSS and read persisted values.
 */

// Scheduling settings

export async function registerPluginSettings(plugin: ReactRNPlugin) {
  plugin.settings.registerNumberSetting({
    id: initialIntervalId,
    title: 'Initial Interval',
    description: 'Sets the number of days until the first repetition.',
    defaultValue: IE_SETTINGS_DEFAULTS[initialIntervalId],
  });

  plugin.settings.registerNumberSetting({
    id: multiplierId,
    title: 'Multiplier',
    description:
      'Sets the multiplier to calculate the next interval. Multiplier * previous interval = next interval.',
    defaultValue: IE_SETTINGS_DEFAULTS[multiplierId],
  });

  // --- Beta Scheduler Settings ---
  plugin.settings.registerBooleanSetting({
    id: betaSchedulerEnabledId,
    title: 'Use Beta Scheduler (Saturating Curve)',
    description:
      'Enable the beta saturating scheduler. Intervals start at the First Review Interval and gradually approach the Max Interval, instead of growing exponentially. When enabled, the Multiplier setting above is ignored. See the IncRem Scheduler wiki page for details.',
    defaultValue: IE_SETTINGS_DEFAULTS[betaSchedulerEnabledId],
  });

  plugin.settings.registerNumberSetting({
    id: betaFirstReviewIntervalId,
    title: 'First Review Interval (Beta Scheduler)',
    description:
      'Interval in days assigned after completing the first review. Not to be confused with "Initial Interval", which controls when a new IncRem first appears in the queue (before any review). Only used when the Beta Scheduler is enabled. Default: 5 days.',
    defaultValue: IE_SETTINGS_DEFAULTS[betaFirstReviewIntervalId],
  });

  plugin.settings.registerNumberSetting({
    id: betaMaxIntervalId,
    title: 'Max Interval (Beta Scheduler)',
    description:
      'Upper bound in days the interval gradually approaches. The interval will never exceed this value. Only used when the Beta Scheduler is enabled. Default: 30 days.',
    defaultValue: IE_SETTINGS_DEFAULTS[betaMaxIntervalId],
  });

  plugin.settings.registerBooleanSetting({
    id: collapseQueueTopBar,
    title: 'Collapse Queue Top Bar (IncRem Only)',
    description:
      'Creates extra vertical space during Incremental Rem review by collapsing the queue top bar to a thin strip. Hover over it to reveal the full bar. Has no effect on regular flashcard turns.',
    defaultValue: IE_SETTINGS_DEFAULTS[collapseQueueTopBar],
  });

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

  const shouldCollapseTopBar = await getIESetting(plugin, collapseQueueTopBar);
  if (shouldCollapseTopBar) {
    await plugin.app.registerCSS(collapseTopBarCssId, COLLAPSE_TOP_BAR_CSS);
  }

  // Priority settings

  plugin.settings.registerNumberSetting({
    id: defaultPriorityId,
    title: 'Default IncRem Priority',
    description: 'Sets the default priority for new incremental rem (0-100, Lower = more important). Default: 10',
    defaultValue: IE_SETTINGS_DEFAULTS[defaultPriorityId],
    validators: [
      {
        type: 'int' as const,
      },
      {
        type: 'gte' as const,
        arg: 0,
      },
      {
        type: 'lte' as const,
        arg: 100,
      },
    ],
  } as PluginNumberSetting);

  plugin.settings.registerNumberSetting({
    id: defaultCardPriorityId,
    title: 'Default Card Priority',
    description: 'Default priority for flashcards without inherited priority (0-100, Lower = more important).  Default: 50',
    defaultValue: IE_SETTINGS_DEFAULTS[defaultCardPriorityId],
    validators: [
      { type: 'int' as const },
      { type: 'gte' as const, arg: 0 },
      { type: 'lte' as const, arg: 100 },
    ],
  } as PluginNumberSetting);

  plugin.settings.registerNumberSetting({
    id: priorityStepSizeId,
    title: 'Priority Step Size',
    description: 'Sets the step size for quick priority increase/decrease shortcuts (Ctrl+Shift+Up/Down). Default: 5',
    defaultValue: IE_SETTINGS_DEFAULTS[priorityStepSizeId],
    validators: [
      { type: 'int' as const },
      { type: 'gte' as const, arg: 1 },
      { type: 'lte' as const, arg: 50 },
    ],
  } as PluginNumberSetting);


  plugin.settings.registerDropdownSetting({
    id: priorityEditorDisplayModeId,
    title: 'Priority Widget in Editor',
    description: 'Controls when to show the priority widget in the right-hand margin of each Rem in the editor.',
    defaultValue: IE_SETTINGS_DEFAULTS[priorityEditorDisplayModeId],
    options: [
      {
        key: 'all',
        label: 'Show for IncRem and Cards',
        value: 'all',
      },
      {
        key: 'incRemOnly',
        label: 'Show only for IncRem',
        value: 'incRemOnly',
      },
      {
        key: 'disable',
        label: 'Disable',
        value: 'disable',
      },
    ],
  });

  // Queue Display Settings

  plugin.settings.registerBooleanSetting({
    id: displayPriorityShieldId,
    title: 'Display Priority Shield in Queue',
    description:
      'If enabled, shows a real-time status of your highest-priority due items in the queue (below the Answer Buttons for IncRems, and in the card priority widget under the flashcard in case of regular cards).',
    defaultValue: IE_SETTINGS_DEFAULTS[displayPriorityShieldId],
  });

  plugin.settings.registerBooleanSetting({
    id: displayWeightedShieldId,
    title: 'Display Weighted Priority Shield in Queue',
    description:
      'If enabled, shows what fraction of your total priority-weighted workload has been processed. ' +
      'High-priority items carry exponentially more weight (~10× at the top vs bottom), so processing ' +
      'them gives a bigger boost. Always increases as you review items.',
    defaultValue: IE_SETTINGS_DEFAULTS[displayWeightedShieldId],
  });

  plugin.settings.registerBooleanSetting({
    id: displayQueueToolbarPriorityId,
    title: 'Display Priority in Queue Toolbar',
    description:
      'If enabled, exhibits the PriorityBadge of the current flashcard or IncRem at the top right of the queue.',
    defaultValue: IE_SETTINGS_DEFAULTS[displayQueueToolbarPriorityId],
  });

  plugin.settings.registerDropdownSetting({
    id: isolatedQueueModeId,
    title: 'Use Isolated Card View in Queue for',
    description:
      'Choose which incremental items use the isolated card view as their default view in the queue. ' +
      'Highlights that do NOT use the isolated card view will be shown inside the PDF/HTML reader instead, ' +
      'and regular Rems that do NOT use it will be shown in the full document context. ' +
      'You can always toggle between the two views with the button in the queue — this setting only determines the initial view.',
    defaultValue: IE_SETTINGS_DEFAULTS[isolatedQueueModeId],
    options: [
      {
        key: 'highlights',
        label: 'Highlights (PDF/HTML)',
        value: 'highlights',
      },
      {
        key: 'rems',
        label: 'Regular Rems',
        value: 'rems',
      },
      {
        key: 'both',
        label: 'Both',
        value: 'both',
      },
      {
        key: 'none',
        label: 'None',
        value: 'none',
      },
    ],
  });

  plugin.settings.registerBooleanSetting({
    id: autoFocusQueueDashboardId,
    title: 'Auto focus Queue Dashboard',
    description:
      'When enabled, opens the Practiced Queues dashboard in the Right Sidebar automatically on Queue Enter so you always have a live view of the current session. Note: PDF IncRems may temporarily steal focus to PDF-related tabs; the dashboard tab stays available for re-selection. (Does not apply to mobile)',
    defaultValue: IE_SETTINGS_DEFAULTS[autoFocusQueueDashboardId],
  });


  // Visual Indicators in Editor

  plugin.settings.registerBooleanSetting({
    id: hideCardPriorityTagSettingId,
    title: 'Hide CardPriority Tag in Editor',
    description:
      'If enabled, this will hide the "CardPriority" powerup tag in the editor to reduce clutter. You can still set priority with (Alt+P). After changing this setting, reload RemNote.',
    defaultValue: IE_SETTINGS_DEFAULTS[hideCardPriorityTagSettingId],
  });

  const shouldHide = await getIESetting(plugin, hideCardPriorityTagSettingId);
  if (shouldHide) {
    await plugin.app.registerCSS(hideCardPriorityTagId, HIDE_CARD_PRIORITY_CSS);
  }

  plugin.settings.registerBooleanSetting({
    id: showLeftBorderForIncRemsSettingId,
    title: 'Show a green left Border for IncRems in Editor',
    description:
      'If enabled, this will show a green left border for IncRems in Editor, to make it easier to identify your "extracts".',
    defaultValue: IE_SETTINGS_DEFAULTS[showLeftBorderForIncRemsSettingId],
  });

  const shouldShowLeftBorderForIncRems = await getIESetting(plugin, showLeftBorderForIncRemsSettingId);
  if (shouldShowLeftBorderForIncRems) {
    await plugin.app.registerCSS(showLeftBorderForIncRemsId, SHOW_LEFT_BORDER_CSS);
  }

  // Table-cell priority badges. RemNote renders no plugin widget inside a table
  // cell, so `priority_editor` cannot follow the user into a table; this CSS
  // draws a badge from the band powerup tags instead. See lib/priority_bands.ts.
  //
  // Registered here because registerPluginSettings runs from onActivate in
  // widgets/index.tsx — registerCSS is index-only and silently no-ops elsewhere.
  // Like the border/indicator toggles above, taking effect needs a reload.
  plugin.settings.registerBooleanSetting({
    id: showPriorityBandsInTablesId,
    title: 'Show Priority Badges in Table Cells',
    description:
      'Tables are the one place the priority editor cannot render. Shows a coloured band badge (e.g. "70s") in the top-right of each table cell. Run "Refresh Priority Badges" once to fill in existing rems. Takes effect after a reload.',
    defaultValue: IE_SETTINGS_DEFAULTS[showPriorityBandsInTablesId],
  });

  // Unconditional: the band tags are an implementation detail, so their tag-bar
  // chips stay hidden even when the badges themselves are switched off.
  await plugin.app.registerCSS('priority-band-tag-hide', PRIORITY_BAND_TAG_HIDE_CSS);

  // The badge stylesheet itself is registered by registerTableBandBadgeCSS from
  // index.tsx, which re-runs when the band→percentile colour mapping changes.

  // Dismissed Rems settings
  plugin.settings.registerBooleanSetting({
    id: showDismissedIndicatorSettingId,
    title: 'Show Yellow Left Border for Dismissed Rems',
    description:
      'If enabled, Rems that have been dismissed from Incremental learning (via Dismiss button) will show a yellow left border to indicate they have preserved history.',
    defaultValue: IE_SETTINGS_DEFAULTS[showDismissedIndicatorSettingId],
  });

  const shouldShowDismissedIndicator = await getIESetting(plugin, showDismissedIndicatorSettingId);
  if (shouldShowDismissedIndicator) {
    await plugin.app.registerCSS(showDismissedIndicatorId, SHOW_DISMISSED_INDICATOR_CSS);
  }

  // Hide dismissed powerup tag setting
  plugin.settings.registerBooleanSetting({
    id: hideDismissedTagSettingId,
    title: 'Hide Dismissed Tag in Editor',
    description:
      'If enabled, this will hide the "Dismissed" powerup tag in the editor to reduce clutter. After changing this setting, reload RemNote.',
    defaultValue: IE_SETTINGS_DEFAULTS[hideDismissedTagSettingId],
  });

  const shouldHideDismissedTag = await getIESetting(plugin, hideDismissedTagSettingId);
  if (shouldHideDismissedTag) {
    await plugin.app.registerCSS(hideDismissedTagId, HIDE_DISMISSED_TAG_CSS);
  }



  // Hide-in-Queue integration (powerups + commands ported from the standalone
  // "Hide in Queue" plugin). Excludes "Remove Parent" and "Remove Grandparent",
  // which are always registered (the Cloze and Extract creators depend on them).

  plugin.settings.registerBooleanSetting({
    id: enableHideInQueueIntegrationId,
    title: 'Enable Hide-in-Queue powerups and commands',
    description:
      'If enabled, registers the "Hide in Queue", "Remove from Queue", "No Hierarchy", "Hide Parent", and "Hide Grandparent" powerups and their commands directly inside Incremental Everything.\n\n' +
      'WARNING: only enable this if you do NOT have the standalone "Hide in Queue" plugin installed — duplicate powerup registration throws a fatal error that breaks this plugin. If you currently have the standalone plugin, uninstall it first, then reload RemNote.\n\n' +
      'The "Remove Parent" and "Remove Grandparent" powerups/commands (used internally by the Cloze and Extract creators) are always registered regardless of this setting.\n\n' +
      'After changing this setting, reload RemNote.',
    defaultValue: IE_SETTINGS_DEFAULTS[enableHideInQueueIntegrationId],
  });

  // Performance Mode

  plugin.settings.registerDropdownSetting({
    id: performanceModeId,
    title: 'Performance Mode',
    description:
      'Choose performance level. "Light" is recommended for web/mobile. "Full" can bring significant computational overhead (best used in the Desktop App); it will also automatically start a pretagging process of all flashcards, that can make RemNote slow untill everything is tagged/synced/wired/cached!',
    defaultValue: IE_SETTINGS_DEFAULTS[performanceModeId],
    options: [
      {
        key: 'full',
        label: 'Full (All Features, High Resource Use)',
        value: 'full',
      },
      {
        key: 'light',
        label: 'Light (Faster, No Relative Priority/Shield)',
        value: 'light',
      },
    ],
  });

  plugin.settings.registerBooleanSetting({
    id: alwaysUseLightModeOnMobileId,
    title: 'Always use Light Mode on Mobile',
    description:
      'Automatically switch to Light performance mode when using RemNote on iOS or Android. This prevents crashes and improves performance on mobile devices. Recommended: enabled.',
    defaultValue: IE_SETTINGS_DEFAULTS[alwaysUseLightModeOnMobileId],
  });

  plugin.settings.registerBooleanSetting({
    id: alwaysUseLightModeOnWebId,
    title: 'Always use Light Mode on Web Browser',
    description:
      'Automatically switch to Light performance mode when using RemNote on the web browser. Full Mode can be slow or unstable on web browsers. Recommended: enabled.',
    defaultValue: IE_SETTINGS_DEFAULTS[alwaysUseLightModeOnWebId],
  });



  // --- FSRS DSR Settings ---
  plugin.settings.registerBooleanSetting({
    id: displayFsrsDsrId,
    title: 'Display FSRS DSR Stats (Flashcards)',
    description:
      'If enabled, shows calculated FSRS Difficulty / Stability / Retrievability for flashcards in the card info bar widget. Requires FSRS v6 scheduler.',
    defaultValue: IE_SETTINGS_DEFAULTS[displayFsrsDsrId],
  });

  plugin.settings.registerStringSetting({
    id: fsrsWeightsId,
    title: 'FSRS Global Weights',
    description:
      'Comma-separated list of 21 FSRS v6 weights (w0–w20). Paste them from your RemNote scheduler settings. Leave blank to use the official FSRS v6.1.1 defaults.',
    defaultValue: IE_SETTINGS_DEFAULTS[fsrsWeightsId],
  });


  // Environment

  plugin.settings.registerDropdownSetting({
    id: remnoteEnvironmentId,
    title: 'RemNote Environment',
    description: 'Choose which RemNote environment to open documents in (beta.remnote.com or www.remnote.com)',
    defaultValue: IE_SETTINGS_DEFAULTS[remnoteEnvironmentId],
    options: [
      {
        key: 'beta',
        label: 'Beta (beta.remnote.com)',
        value: 'beta',
      },
      {
        key: 'www',
        label: 'Regular (www.remnote.com)',
        value: 'www',
      },
    ],
  });

  // Practiced Queues Settings

  plugin.settings.registerNumberSetting({
    id: flashcardResponseTimeLimitId,
    title: 'Flashcard Response Time Limit (seconds)',
    description:
      "If you take longer to answer a flashcard than this (e.g. because you walked away), " +
      "only this much time will be counted in Practiced Queues session statistics. " +
      "Matches RemNote's native 'Flashcard Response Time Limit' setting. Default: 180s.",
    defaultValue: IE_SETTINGS_DEFAULTS[flashcardResponseTimeLimitId],
  });

  // Mastery Drill Settings

  plugin.settings.registerBooleanSetting({
    id: skipMasteryDrillId,
    title: 'Skip Mastery Drill',
    description:
      'If enabled, all Mastery Drill features are turned off: the drill popup and sidebar ' +
      'notification are hidden, the "Mastery Drill" command is not registered, and cards rated ' +
      'Again or Hard are no longer tracked or added to the drill queue. Turn this on if you ' +
      'do not want to use the Mastery Drill workflow at all.' +
      'Requires reloading RemNote to take effect.',
    defaultValue: IE_SETTINGS_DEFAULTS[skipMasteryDrillId],
  });

  plugin.settings.registerNumberSetting({
    id: oldItemThresholdId,
    title: 'Old Items Threshold (Days) for Mastery Drill',
    description: 'Items older than this number of days will trigger a warning in the Mastery Drill.',
    defaultValue: IE_SETTINGS_DEFAULTS[oldItemThresholdId],
  });

  plugin.settings.registerNumberSetting({
    id: masteryDrillMinDelayMinutesId,
    title: 'Mastery Drill Minimum Delay (Minutes)',
    description:
      'A card rated Again or Hard will not appear in the Mastery Drill until at least this many minutes have passed since it was last reviewed. Prevents reviewing the same card again too soon. Default: 120 minutes.',
    defaultValue: IE_SETTINGS_DEFAULTS[masteryDrillMinDelayMinutesId],
  });

  plugin.settings.registerBooleanSetting({
    id: disableFinalDrillNotificationId,
    title: 'Disable Mastery Drill Notifications',
    description: 'If enabled, the Mastery Drill sidebar notification will not appear.',
    defaultValue: IE_SETTINGS_DEFAULTS[disableFinalDrillNotificationId],
  });

}
