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
  showRemsAsIsolatedInQueueId,
  displayFsrsDsrId,
  fsrsWeightsId,
  displayQueueToolbarPriorityId,
  displayWeightedShieldId,
  autoFocusQueueDashboardId,
  enableHideInQueueIntegrationId,
} from '../lib/consts';

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
`;

const showDismissedIndicatorId = 'show-dismissed-indicator';
const SHOW_DISMISSED_INDICATOR_CSS = `
  .rem[data-rem-tags~="dismissed"]:not([data-rem-tags~="incremental"]) {
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
    defaultValue: 1,
  });

  plugin.settings.registerNumberSetting({
    id: multiplierId,
    title: 'Multiplier',
    description:
      'Sets the multiplier to calculate the next interval. Multiplier * previous interval = next interval.',
    defaultValue: 1.5,
  });

  // --- Beta Scheduler Settings ---
  plugin.settings.registerBooleanSetting({
    id: betaSchedulerEnabledId,
    title: 'Use Beta Scheduler (Saturating Curve)',
    description:
      'Enable the beta saturating scheduler. Intervals start at the First Review Interval and gradually approach the Max Interval, instead of growing exponentially. When enabled, the Multiplier setting above is ignored. See the IncRem Scheduler wiki page for details.',
    defaultValue: false,
  });

  plugin.settings.registerNumberSetting({
    id: betaFirstReviewIntervalId,
    title: 'First Review Interval (Beta Scheduler)',
    description:
      'Interval in days assigned after completing the first review. Not to be confused with "Initial Interval", which controls when a new IncRem first appears in the queue (before any review). Only used when the Beta Scheduler is enabled.',
    defaultValue: 5,
  });

  plugin.settings.registerNumberSetting({
    id: betaMaxIntervalId,
    title: 'Max Interval (Beta Scheduler)',
    description:
      'Upper bound in days the interval gradually approaches. The interval will never exceed this value. Only used when the Beta Scheduler is enabled.',
    defaultValue: 30,
  });

  plugin.settings.registerBooleanSetting({
    id: collapseQueueTopBar,
    title: 'Collapse Queue Top Bar (IncRem Only)',
    description:
      'Creates extra vertical space during Incremental Rem review by collapsing the queue top bar to a thin strip. Hover over it to reveal the full bar. Has no effect on regular flashcard turns.',
    defaultValue: false,
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

  const shouldCollapseTopBar = await plugin.settings.getSetting<boolean>(collapseQueueTopBar);
  if (shouldCollapseTopBar) {
    await plugin.app.registerCSS(collapseTopBarCssId, COLLAPSE_TOP_BAR_CSS);
  }

  // Priority settings

  plugin.settings.registerNumberSetting({
    id: defaultPriorityId,
    title: 'Default IncRem Priority',
    description: 'Sets the default priority for new incremental rem (0-100, Lower = more important). Default: 10',
    defaultValue: 10,
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
    defaultValue: 50,
    validators: [
      { type: 'int' as const },
      { type: 'gte' as const, arg: 0 },
      { type: 'lte' as const, arg: 100 },
    ],
  } as PluginNumberSetting);

  plugin.settings.registerNumberSetting({
    id: 'priority-step-size',
    title: 'Priority Step Size',
    description: 'Sets the step size for quick priority increase/decrease shortcuts (Ctrl+Shift+Up/Down). Default: 5',
    defaultValue: 5,
    validators: [
      { type: 'int' as const },
      { type: 'gte' as const, arg: 1 },
      { type: 'lte' as const, arg: 50 },
    ],
  } as PluginNumberSetting);


  plugin.settings.registerDropdownSetting({
    id: 'priorityEditorDisplayMode',
    title: 'Priority Widget in Editor',
    description: 'Controls when to show the priority widget in the right-hand margin of each Rem in the editor.',
    defaultValue: 'all',
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
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: displayWeightedShieldId,
    title: 'Display Weighted Priority Shield in Queue',
    description:
      'If enabled, shows what fraction of your total priority-weighted workload has been processed. ' +
      'High-priority items carry exponentially more weight (~10× at the top vs bottom), so processing ' +
      'them gives a bigger boost. Always increases as you review items.',
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: displayQueueToolbarPriorityId,
    title: 'Display Priority in Queue Toolbar',
    description:
      'If enabled, exhibits the PriorityBadge of the current flashcard or IncRem at the top right of the queue.',
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: showRemsAsIsolatedInQueueId,
    title: 'Show regular Rems in isolated view (Queue)',
    description:
      'When enabled, incremental Rems that are plain Rems will use the isolated card view in the queue instead of the full document context. Switch back to context with the button in the queue.',
    defaultValue: false,
  });

  plugin.settings.registerBooleanSetting({
    id: autoFocusQueueDashboardId,
    title: 'Auto focus Queue Dashboard',
    description:
      'When enabled, opens the Practiced Queues dashboard in the Right Sidebar automatically on Queue Enter so you always have a live view of the current session. Note: PDF IncRems may temporarily steal focus to PDF-related tabs; the dashboard tab stays available for re-selection. (Does not apply to mobile)',
    defaultValue: false,
  });


  // Visual Indicators in Editor

  plugin.settings.registerBooleanSetting({
    id: 'hideCardPriorityTag',
    title: 'Hide CardPriority Tag in Editor',
    description:
      'If enabled, this will hide the "CardPriority" powerup tag in the editor to reduce clutter. You can still set priority with (Alt+P). After changing this setting, reload RemNote.',
    defaultValue: true,
  });

  const shouldHide = await plugin.settings.getSetting('hideCardPriorityTag');
  if (shouldHide) {
    await plugin.app.registerCSS(hideCardPriorityTagId, HIDE_CARD_PRIORITY_CSS);
  }

  plugin.settings.registerBooleanSetting({
    id: 'showLeftBorderForIncRems',
    title: 'Show a green left Border for IncRems in Editor',
    description:
      'If enabled, this will show a green left border for IncRems in Editor, to make it easier to identify your "extracts".',
    defaultValue: true,
  });

  const shouldShowLeftBorderForIncRems = await plugin.settings.getSetting('showLeftBorderForIncRems');
  if (shouldShowLeftBorderForIncRems) {
    await plugin.app.registerCSS(showLeftBorderForIncRemsId, SHOW_LEFT_BORDER_CSS);
  }

  // Dismissed Rems settings
  plugin.settings.registerBooleanSetting({
    id: 'showDismissedIndicator',
    title: 'Show Yellow Left Border for Dismissed Rems',
    description:
      'If enabled, Rems that have been dismissed from Incremental learning (via Dismiss button) will show a yellow left border to indicate they have preserved history.',
    defaultValue: true,
  });

  const shouldShowDismissedIndicator = await plugin.settings.getSetting('showDismissedIndicator');
  if (shouldShowDismissedIndicator) {
    await plugin.app.registerCSS(showDismissedIndicatorId, SHOW_DISMISSED_INDICATOR_CSS);
  }

  // Hide dismissed powerup tag setting
  plugin.settings.registerBooleanSetting({
    id: 'hideDismissedTag',
    title: 'Hide Dismissed Tag in Editor',
    description:
      'If enabled, this will hide the "Dismissed" powerup tag in the editor to reduce clutter. After changing this setting, reload RemNote.',
    defaultValue: true,
  });

  const shouldHideDismissedTag = await plugin.settings.getSetting('hideDismissedTag');
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
    defaultValue: false,
  });

  // Performance Mode

  plugin.settings.registerDropdownSetting({
    id: 'performanceMode',
    title: 'Performance Mode',
    description:
      'Choose performance level. "Light" is recommended for web/mobile. "Full" can bring significant computational overhead (best used in the Desktop App); it will also automatically start a pretagging process of all flashcards, that can make RemNote slow untill everything is tagged/synced/wired/cached!',
    defaultValue: 'light',
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
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: alwaysUseLightModeOnWebId,
    title: 'Always use Light Mode on Web Browser',
    description:
      'Automatically switch to Light performance mode when using RemNote on the web browser. Full Mode can be slow or unstable on web browsers. Recommended: enabled.',
    defaultValue: true,
  });



  // --- FSRS DSR Settings ---
  plugin.settings.registerBooleanSetting({
    id: displayFsrsDsrId,
    title: 'Display FSRS DSR Stats (Flashcards)',
    description:
      'If enabled, shows calculated FSRS Difficulty / Stability / Retrievability for flashcards in the card priority display widget. Requires FSRS v6 scheduler.',
    defaultValue: true,
  });

  plugin.settings.registerStringSetting({
    id: fsrsWeightsId,
    title: 'FSRS Global Weights',
    description:
      'Comma-separated list of 21 FSRS v6 weights (w0–w20). Paste them from your RemNote scheduler settings. Leave blank to use the official FSRS v6.1.1 defaults.',
    defaultValue: '',
  });


  // Environment

  plugin.settings.registerDropdownSetting({
    id: remnoteEnvironmentId,
    title: 'RemNote Environment',
    description: 'Choose which RemNote environment to open documents in (beta.remnote.com or www.remnote.com)',
    defaultValue: 'www',
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
    id: 'flashcard_response_time_limit',
    title: 'Flashcard Response Time Limit (seconds)',
    description:
      "If you take longer to answer a flashcard than this (e.g. because you walked away), " +
      "only this much time will be counted in Practiced Queues session statistics. " +
      "Matches RemNote's native 'Flashcard Response Time Limit' setting. Default: 180s.",
    defaultValue: 180,
  });

  // Mastery Drill Settings

  plugin.settings.registerBooleanSetting({
    id: 'skip_mastery_drill',
    title: 'Skip Mastery Drill',
    description:
      'If enabled, all Mastery Drill features are turned off: the drill popup and sidebar ' +
      'notification are hidden, the "Mastery Drill" command is not registered, and cards rated ' +
      'Again or Hard are no longer tracked or added to the drill queue. Turn this on if you ' +
      'do not want to use the Mastery Drill workflow at all.' +
      'Requires reloading RemNote to take effect.',
    defaultValue: false,
  });

  plugin.settings.registerNumberSetting({
    id: 'old_item_threshold',
    title: 'Old Items Threshold (Days) for Mastery Drill',
    description: 'Items older than this number of days will trigger a warning in the Mastery Drill.',
    defaultValue: 7,
  });

  plugin.settings.registerNumberSetting({
    id: 'mastery_drill_min_delay_minutes',
    title: 'Mastery Drill Minimum Delay (Minutes)',
    description:
      'A card rated Again or Hard will not appear in the Mastery Drill until at least this many minutes have passed since it was last reviewed. Prevents reviewing the same card again too soon. Default: 120 minutes.',
    defaultValue: 120,
  });

  plugin.settings.registerBooleanSetting({
    id: 'disable_final_drill_notification',
    title: 'Disable Mastery Drill Notifications',
    description: 'If enabled, the Mastery Drill sidebar notification will not appear.',
    defaultValue: false,
  });

}
