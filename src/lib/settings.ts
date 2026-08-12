/**
 * Single source of truth for Incremental Everything's user settings: their
 * types, defaults, presentation metadata, and where each one is stored.
 *
 * Every read goes through `getIESetting` / `useIESetting` rather than
 * `plugin.settings.getSetting`, so that:
 *
 * 1. Defaults live in exactly one place (`IE_SETTINGS_DEFAULTS`) instead of
 *    being restated — and sometimes contradicted — at each call site.
 * 2. There is one seam (`readRawSetting`) behind which the storage backend can
 *    differ per setting, invisible to the ~70 call sites.
 *
 * Two tiers, see `SettingTier`:
 *
 * - `popup`  — stored in the plugin's own synced blob and edited in the IE
 *   Settings popup, which can group and layer them properly.
 * - `native` — left in RemNote's plugin settings panel. These govern how much
 *   work the plugin is allowed to do, and RemNote's own panel is where someone
 *   chasing a performance problem looks first — long before they discover that
 *   this plugin has a settings window of its own. The SDK has no setter for a
 *   registered setting, so the popup shows them read-only.
 *
 * Why the defaults table is load-bearing: `plugin.settings.getSetting` resolves
 * a setting through its *registration record* and reads `defaultValue` off it.
 * For an id that is not currently registered it does not return `undefined` —
 * it throws `TypeError: Cannot read properties of undefined (reading
 * 'defaultValue')`. Popup-tier settings stop being registered once a knowledge
 * base has migrated, so this module is what keeps them readable.
 */
import { RNPlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import {
  initialIntervalId,
  multiplierId,
  betaSchedulerEnabledId,
  betaFirstReviewIntervalId,
  betaMaxIntervalId,
  collapseQueueTopBar,
  defaultPriorityId,
  defaultCardPriorityId,
  priorityStepSizeId,
  priorityEditorDisplayModeId,
  PriorityEditorDisplayMode,
  displayPriorityShieldId,
  displayWeightedShieldId,
  displayQueueToolbarPriorityId,
  isolatedQueueModeId,
  IsolatedQueueMode,
  autoFocusQueueDashboardId,
  hideCardPriorityTagSettingId,
  showLeftBorderForIncRemsSettingId,
  showPriorityBandsInTablesId,
  showDismissedIndicatorSettingId,
  hideDismissedTagSettingId,
  enableHideInQueueIntegrationId,
  enableFlashcardPrioritisationId,
  performanceModeId,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  displayFsrsDsrId,
  fsrsWeightsId,
  remnoteEnvironmentId,
  flashcardResponseTimeLimitId,
  enableMasteryDrillId,
  oldItemThresholdId,
  masteryDrillMinDelayMinutesId,
  disableFinalDrillNotificationId,
  speedColorModeId,
  SpeedColorMode,
  speedColorRedCpmId,
  speedColorGreenCpmId,
  speedCalibrationPeriodId,
  SpeedCalibrationPeriod,
  speedCalibrationMarginSecondsId,
  ieSettingsValuesKey,
} from './consts';
// Type-only: utils.ts imports getIESetting from this module, so a value import
// here would close a runtime require cycle. `import type` is erased.
import type { PerformanceMode } from './utils';

/**
 * The type of every user setting. Keys are the setting ids as registered with
 * RemNote; adding a setting means adding it here, to `IE_SETTINGS_DEFAULTS` and
 * to `IE_SETTINGS_SCHEMA` (TypeScript enforces all three).
 */
export interface IESettings {
  // Scheduling
  [initialIntervalId]: number;
  [multiplierId]: number;
  [betaSchedulerEnabledId]: boolean;
  [betaFirstReviewIntervalId]: number;
  [betaMaxIntervalId]: number;

  // Priority
  [defaultPriorityId]: number;
  [defaultCardPriorityId]: number;
  [priorityStepSizeId]: number;
  [priorityEditorDisplayModeId]: PriorityEditorDisplayMode;

  // Queue display
  [collapseQueueTopBar]: boolean;
  [displayPriorityShieldId]: boolean;
  [displayWeightedShieldId]: boolean;
  [displayQueueToolbarPriorityId]: boolean;
  [isolatedQueueModeId]: IsolatedQueueMode;
  [autoFocusQueueDashboardId]: boolean;

  // Editor indicators
  [hideCardPriorityTagSettingId]: boolean;
  [showLeftBorderForIncRemsSettingId]: boolean;
  [showPriorityBandsInTablesId]: boolean;
  [showDismissedIndicatorSettingId]: boolean;
  [hideDismissedTagSettingId]: boolean;

  // Integrations / performance
  [enableHideInQueueIntegrationId]: boolean;
  [enableFlashcardPrioritisationId]: boolean;
  [performanceModeId]: PerformanceMode;
  [alwaysUseLightModeOnMobileId]: boolean;
  [alwaysUseLightModeOnWebId]: boolean;

  // FSRS
  [displayFsrsDsrId]: boolean;
  [fsrsWeightsId]: string;

  // Misc
  [remnoteEnvironmentId]: 'beta' | 'www';
  [flashcardResponseTimeLimitId]: number;

  // Mastery Drill
  [enableMasteryDrillId]: boolean;
  [oldItemThresholdId]: number;
  [masteryDrillMinDelayMinutesId]: number;
  [disableFinalDrillNotificationId]: boolean;

  // Queue Dashboard
  [speedColorModeId]: SpeedColorMode;
  [speedColorRedCpmId]: number;
  [speedColorGreenCpmId]: number;
  [speedCalibrationPeriodId]: SpeedCalibrationPeriod;
  [speedCalibrationMarginSecondsId]: number;
}

export type IESettingId = keyof IESettings;

/**
 * The default for every setting. register/settings.ts takes its `defaultValue`
 * from this table rather than restating literals, so a registration and its
 * default cannot drift apart.
 */
export const IE_SETTINGS_DEFAULTS: IESettings = {
  [initialIntervalId]: 1,
  [multiplierId]: 1.5,
  [betaSchedulerEnabledId]: false,
  [betaFirstReviewIntervalId]: 5,
  [betaMaxIntervalId]: 30,

  [defaultPriorityId]: 50,
  [defaultCardPriorityId]: 50,
  [priorityStepSizeId]: 5,
  [priorityEditorDisplayModeId]: 'all',

  [collapseQueueTopBar]: false,
  [displayPriorityShieldId]: true,
  [displayWeightedShieldId]: true,
  [displayQueueToolbarPriorityId]: true,
  [isolatedQueueModeId]: 'highlights',
  [autoFocusQueueDashboardId]: false,

  [hideCardPriorityTagSettingId]: true,
  [showLeftBorderForIncRemsSettingId]: true,
  [showPriorityBandsInTablesId]: true,
  [showDismissedIndicatorSettingId]: true,
  [hideDismissedTagSettingId]: true,

  [enableHideInQueueIntegrationId]: false,
  [enableFlashcardPrioritisationId]: false,
  [performanceModeId]: 'light',
  [alwaysUseLightModeOnMobileId]: true,
  [alwaysUseLightModeOnWebId]: true,

  [displayFsrsDsrId]: true,
  [fsrsWeightsId]: '',

  [remnoteEnvironmentId]: 'www',
  [flashcardResponseTimeLimitId]: 180,

  [enableMasteryDrillId]: false,
  [oldItemThresholdId]: 7,
  [masteryDrillMinDelayMinutesId]: 180,
  [disableFinalDrillNotificationId]: false,

  // Calibrated by default: an absolute cards-per-minute standard says little
  // about a knowledge base whose cards are long extracts or one-word clozes.
  // The two cpm values below stay at the thresholds the dashboard has always
  // used, and are what fixed mode — and the calibrated fallback — apply.
  [speedColorModeId]: 'calibrated',
  [speedColorRedCpmId]: 1.5,
  [speedColorGreenCpmId]: 4,
  [speedCalibrationPeriodId]: 'year',
  [speedCalibrationMarginSecondsId]: 10,
};

// ---------------------------------------------------------------------------
// Presentation schema
// ---------------------------------------------------------------------------

/** Where a setting is stored and edited. See the module comment. */
export type SettingTier = 'popup' | 'native';

export type SettingGroupId =
  | 'flashcardPriority'
  | 'scheduling'
  | 'priority'
  | 'queue'
  | 'editor'
  | 'fsrs'
  | 'masteryDrill'
  | 'queueDashboard'
  | 'performance'
  | 'integrations'
  | 'misc';

export interface SettingGroupSpec {
  label: string;
  /** Shown under the group heading in the popup. */
  blurb?: string;
  /**
   * Page on the docs site, relative to IE_DOCS_BASE_URL, for the feature the
   * whole group configures. Renders a "?" beside the group heading — better
   * than repeating the same link on each of its settings.
   */
  helpPath?: string;
}

/** Display order is the key order here. */
export const IE_SETTING_GROUPS: Record<SettingGroupId, SettingGroupSpec> = {
  flashcardPriority: {
    label: 'Flashcard Prioritisation',
    blurb:
      'Per-flashcard priorities. This is the only part of Incremental Everything that does ' +
      'heavy background work across your whole knowledge base, so it is opt-in.',
  },
  performance: {
    label: 'Performance',
    blurb:
      'How much work the plugin is allowed to do, and where. Kept in RemNote\'s own settings ' +
      'panel, because that is where you would look first if the plugin felt heavy.',
    helpPath: 'Full-Mode-x-Light-Mode/',
  },
  scheduling: {
    label: 'Scheduling',
    blurb: 'How intervals grow between repetitions of an Incremental Rem.',
  },
  priority: {
    label: 'Priority',
    blurb: 'Defaults and editing behaviour for priority values.',
  },
  queue: { label: 'Queue', blurb: 'What the queue shows during review.' },
  editor: { label: 'Editor Indicators', blurb: 'Visual markers on rems in the editor.' },
  fsrs: { label: 'FSRS', blurb: 'Difficulty / Stability / Retrievability display.' },
  masteryDrill: {
    label: 'Mastery Drill',
    blurb: 'Deliberate practice of poorly-rated cards.',
    helpPath: 'History-Queue-Dashboard-and-Mastery-Drill/#mastery-drill',
  },
  queueDashboard: {
    label: 'Queue Dashboard',
    blurb:
      'How the Practiced Queues dashboard reads: the pace at which a speed reading turns red or ' +
      'green, in the live session card, the History Log and the Sessions Summary.',
    helpPath: 'History-Queue-Dashboard-and-Mastery-Drill/#speed-colour-coding',
  },
  integrations: { label: 'Integrations', blurb: 'Features ported from other plugins.' },
  misc: { label: 'Other', blurb: '' },
};

/** Documentation site the "?" help links point at. */
export const IE_DOCS_BASE_URL = 'https://hugomarins.github.io/incremental-everything/';

/**
 * Appended to the description of the LAST native-tier setting, which is where it
 * lands at the bottom of the plugin's section in RemNote's settings panel.
 *
 * RemNote renders only a title and a description per setting — there is no room
 * for a heading, a footer or a link of our own — so the tail of the last
 * description is the single spot available to tell someone reading that panel
 * that the other twenty-eight settings are elsewhere.
 */
export const MORE_SETTINGS_POINTER =
  'MORE SETTINGS: these are only the performance switches. Every other Incremental Everything ' +
  'setting lives in the plugin\'s own settings window — run the "Incremental Everything: ' +
  'Settings" command from the omnibar (quick code: ies).';

interface SettingSpecBase {
  title: string;
  description: string;
  group: SettingGroupId;
  tier: SettingTier;
  /** Takes effect only after RemNote is reloaded. Surfaced as a badge. */
  reloadRequired?: boolean;
  /** Page on the docs site, relative to IE_DOCS_BASE_URL. Renders a "?" link. */
  helpPath?: string;
  /** Rendered as a prominent warning box above the control in the popup. */
  warning?: string;
  /**
   * Appended as the very last line of this setting's description in RemNote's
   * settings panel — after the docs link and the reload note. Panel-only: the
   * popup does not render it. See MORE_SETTINGS_POINTER.
   */
  panelFooter?: string;
  /**
   * Hide this setting in the popup unless another setting holds a given value —
   * for parameters that only mean something once the feature they configure is
   * switched on. Purely a display rule: the value is still stored and read
   * normally, so turning the parent back on restores what was configured.
   */
  showWhen?: { id: IESettingId; equals: unknown };
}

export type SettingSpec =
  | (SettingSpecBase & { kind: 'boolean' })
  | (SettingSpecBase & {
      kind: 'number';
      min?: number;
      max?: number;
      integer?: boolean;
      unit?: string;
    })
  | (SettingSpecBase & { kind: 'string'; placeholder?: string; wide?: boolean })
  | (SettingSpecBase & { kind: 'dropdown'; options: Array<{ value: string; label: string }> });

/**
 * Title, description, control type and tier for every setting. This is what the
 * popup renders and what register/settings.ts registers from — the descriptions
 * used to be duplicated between the two.
 */
export const IE_SETTINGS_SCHEMA: Record<IESettingId, SettingSpec> = {
  // --- Flashcard prioritisation (the opt-in gate) ---
  [enableFlashcardPrioritisationId]: {
    kind: 'boolean',
    tier: 'native',
    group: 'flashcardPriority',
    reloadRequired: true,
    helpPath: 'Priorities-for-Flashcards/',
    title: 'Enable Flashcard Prioritisation',
    warning:
      'Heavy. Only useful if you create Priority Review Documents for flashcards and review ' +
      'the queue there. If you are in doubt, leave this off — nothing else in the plugin ' +
      'depends on it.',
    description:
      'Turns on per-flashcard priorities: priority inheritance down your document tree, the ' +
      'priority shield, relative percentiles, and flashcards in Priority Review Documents.\n\n' +
      'The cost: enabling it tags flashcard rems with the CardPriority powerup across your entire ' +
      'knowledge base and keeps them in step as you edit. On a large library that means a long ' +
      'initial pass and continuous background work, and RemNote can feel slow until it settles.\n\n' +
      'Everything else — extracts, incremental reading, PDF and video, scheduling, the queue, the ' +
      'Mastery Drill, and priorities on Incremental Rems themselves — works exactly the same with ' +
      'this off.',
  },

  // --- Scheduling ---
  [initialIntervalId]: {
    kind: 'number',
    tier: 'popup',
    group: 'scheduling',
    min: 0,
    integer: true,
    unit: 'days',
    title: 'Initial Interval',
    description: 'Number of days until the first repetition of a new Incremental Rem.',
  },
  [multiplierId]: {
    kind: 'number',
    tier: 'popup',
    group: 'scheduling',
    showWhen: { id: betaSchedulerEnabledId, equals: false },
    min: 1,
    title: 'Multiplier',
    description:
      'Multiplier used to calculate the next interval: multiplier × previous interval = next ' +
      'interval. Ignored when the Beta Scheduler is enabled.',
  },
  [betaSchedulerEnabledId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'scheduling',
    helpPath: 'IncRem-Scheduler/#beta-scheduler',
    title: 'Use Beta Scheduler (Saturating Curve)',
    description:
      'Intervals start at the First Review Interval and gradually approach the Max Interval ' +
      'instead of growing exponentially. When enabled, the Multiplier above is ignored.',
  },
  [betaFirstReviewIntervalId]: {
    kind: 'number',
    tier: 'popup',
    group: 'scheduling',
    showWhen: { id: betaSchedulerEnabledId, equals: true },
    min: 1,
    integer: true,
    unit: 'days',
    title: 'First Review Interval (Beta Scheduler)',
    description:
      'Interval assigned after completing the first review. Not to be confused with "Initial ' +
      'Interval", which controls when a new IncRem first appears in the queue, before any review. ' +
      'Only used when the Beta Scheduler is enabled.',
  },
  [betaMaxIntervalId]: {
    kind: 'number',
    tier: 'popup',
    group: 'scheduling',
    showWhen: { id: betaSchedulerEnabledId, equals: true },
    min: 1,
    integer: true,
    unit: 'days',
    title: 'Max Interval (Beta Scheduler)',
    description:
      'Upper bound the interval gradually approaches; it will never exceed this value. Only used ' +
      'when the Beta Scheduler is enabled.',
  },

  // --- Priority ---
  [defaultPriorityId]: {
    kind: 'number',
    tier: 'popup',
    group: 'priority',
    min: 0,
    max: 100,
    integer: true,
    title: 'Default IncRem Priority',
    description: 'Priority given to new Incremental Rems. 0-100, lower = more important.',
  },
  [defaultCardPriorityId]: {
    kind: 'number',
    tier: 'popup',
    group: 'priority',
    min: 0,
    max: 100,
    integer: true,
    title: 'Default Card Priority',
    description:
      'Priority for flashcards with no inherited priority. 0-100, lower = more important.',
  },
  [priorityStepSizeId]: {
    kind: 'number',
    tier: 'popup',
    group: 'priority',
    min: 1,
    max: 50,
    integer: true,
    title: 'Priority Step Size',
    description:
      'Step used by the quick priority increase/decrease shortcuts (Ctrl+Shift+Up/Down).',
  },
  [priorityEditorDisplayModeId]: {
    kind: 'dropdown',
    tier: 'popup',
    group: 'priority',
    title: 'Priority Widget in Editor',
    description:
      'When to show the priority widget in the right-hand margin of each rem in the editor.',
    options: [
      { value: 'all', label: 'Show for IncRem and Cards' },
      { value: 'incRemOnly', label: 'Show only for IncRem' },
      { value: 'disable', label: 'Disable' },
    ],
  },

  // --- Queue ---
  [collapseQueueTopBar]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'queue',
    title: 'Collapse Queue Top Bar (IncRem only)',
    description:
      'Frees vertical space during Incremental Rem review by collapsing the queue top bar to a ' +
      'thin strip; hover to reveal it. No effect on regular flashcard turns.',
  },
  [displayPriorityShieldId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'queue',
    helpPath: 'Prioritization-%26-Sorting/#priority-shield',
    title: 'Display Priority Shield in Queue',
    description:
      'Shows a live status of your highest-priority due items — below the answer buttons for ' +
      'IncRems, and in the card priority widget under the flashcard for regular cards.',
  },
  [displayWeightedShieldId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'queue',
    helpPath: 'Prioritization-%26-Sorting/#weighted-shield',
    title: 'Display Weighted Priority Shield in Queue',
    description:
      'Shows what fraction of your total priority-weighted workload has been processed. ' +
      'High-priority items carry exponentially more weight (~10× at the top vs the bottom), so ' +
      'processing them gives a bigger boost.',
  },
  [displayQueueToolbarPriorityId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'queue',
    title: 'Display Priority in Queue Toolbar',
    description:
      'Shows the priority badge of the current flashcard or IncRem at the top right of the queue.',
  },
  [isolatedQueueModeId]: {
    kind: 'dropdown',
    tier: 'popup',
    group: 'queue',
    title: 'Use Isolated Card View in Queue for',
    description:
      'Which incremental items default to the isolated card view. Highlights that do not use it ' +
      'appear inside the PDF/HTML reader; regular rems that do not use it appear in full document ' +
      'context. You can always toggle in the queue — this only sets the initial view.',
    options: [
      { value: 'highlights', label: 'Highlights (PDF/HTML)' },
      { value: 'rems', label: 'Regular Rems' },
      { value: 'both', label: 'Both' },
      { value: 'none', label: 'None' },
    ],
  },
  [autoFocusQueueDashboardId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'queue',
    helpPath: 'History-Queue-Dashboard-and-Mastery-Drill/#practiced-queues-history-live-dashboard',
    title: 'Auto-focus Queue Dashboard',
    description:
      'Opens the Practiced Queues dashboard in the right sidebar on queue entry, for a live view ' +
      'of the session. PDF IncRems may temporarily steal focus to PDF tabs; the dashboard tab ' +
      'stays available. Does not apply on mobile.',
  },

  // --- Editor indicators ---
  [showLeftBorderForIncRemsSettingId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'editor',
    reloadRequired: true,
    title: 'Green Left Border for IncRems',
    description: 'Marks Incremental Rems in the editor, making your extracts easy to spot.',
  },
  [showDismissedIndicatorSettingId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'editor',
    reloadRequired: true,
    title: 'Yellow Left Border for Dismissed Rems',
    description:
      'Marks rems dismissed from incremental learning, which keep their preserved history.',
  },
  [hideCardPriorityTagSettingId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'editor',
    reloadRequired: true,
    title: 'Hide CardPriority Tag in Editor',
    description:
      'Hides the "CardPriority" powerup tag to reduce clutter. Priority can still be set with Alt+P.',
  },
  [hideDismissedTagSettingId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'editor',
    reloadRequired: true,
    title: 'Hide Dismissed Tag in Editor',
    description: 'Hides the "Dismissed" powerup tag to reduce clutter.',
  },
  [showPriorityBandsInTablesId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'editor',
    reloadRequired: true,
    helpPath: 'Prioritization-%26-Sorting/#priorities-in-tables',
    title: 'Show Priority Badges in Table Cells',
    description:
      'Tables are the one place the priority editor cannot render, so a coloured band badge ' +
      '(e.g. "70s") is drawn in the top-right of each cell instead. Run "Refresh Priority Badges" ' +
      'once to fill in existing rems.',
  },

  // --- FSRS ---
  [displayFsrsDsrId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'fsrs',
    helpPath: 'Reviewing-Items-in-the-Queue/#card-stats-fsrs-integration',
    title: 'Display FSRS DSR Stats (Flashcards)',
    description:
      'Shows calculated FSRS Difficulty / Stability / Retrievability for flashcards in the card ' +
      'info bar. Requires the FSRS v6 scheduler.',
  },
  [fsrsWeightsId]: {
    kind: 'string',
    tier: 'popup',
    group: 'fsrs',
    wide: true,
    placeholder: 'w0, w1, … w20 — leave blank for FSRS v6.1.1 defaults',
    title: 'FSRS Global Weights',
    description:
      'Comma-separated list of 21 FSRS v6 weights (w0–w20). Paste them from your RemNote scheduler ' +
      'settings. Leave blank to use the official defaults.',
  },

  // --- Mastery Drill ---
  [enableMasteryDrillId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'masteryDrill',
    reloadRequired: true,
    title: 'Enable Mastery Drill',
    description:
      'Deliberate practice of the cards you just rated Again or Hard, revisited in the same ' +
      'session once enough time has passed.\n\n' +
      'While enabled, the plugin listens to every flashcard rating and keeps a list of the ones ' +
      'that need drilling, and registers the drill popup, its command and the sidebar ' +
      'notification. Leave it off if you do not use the workflow — none of that work happens then.',
  },
  [oldItemThresholdId]: {
    kind: 'number',
    tier: 'popup',
    group: 'masteryDrill',
    showWhen: { id: enableMasteryDrillId, equals: true },
    min: 1,
    integer: true,
    unit: 'days',
    title: 'Old Items Threshold',
    description: 'Items older than this trigger a warning in the Mastery Drill.',
  },
  [masteryDrillMinDelayMinutesId]: {
    kind: 'number',
    tier: 'popup',
    group: 'masteryDrill',
    showWhen: { id: enableMasteryDrillId, equals: true },
    min: 0,
    integer: true,
    unit: 'minutes',
    title: 'Mastery Drill Minimum Delay',
    description:
      'A card rated Again or Hard will not appear in the drill until this long after its last ' +
      'review, so the same card is not repeated too soon.',
  },
  [disableFinalDrillNotificationId]: {
    kind: 'boolean',
    tier: 'popup',
    group: 'masteryDrill',
    showWhen: { id: enableMasteryDrillId, equals: true },
    title: 'Disable Mastery Drill Notifications',
    description: 'Stops the Mastery Drill sidebar notification from appearing.',
  },

  // --- Queue Dashboard ---
  [speedColorModeId]: {
    kind: 'dropdown',
    tier: 'popup',
    group: 'queueDashboard',
    title: 'Speed Colour Thresholds',
    description:
      'What counts as a "red" (slow) or "green" (fast) pace in the dashboard.\n\n' +
      '"Fixed" uses the two cards-per-minute limits below, the same for everyone. "Calibrated" ' +
      'derives them from your own flashcard history instead, so the colours judge you against ' +
      'your usual pace rather than an absolute standard — useful if your material is much ' +
      'heavier or much lighter than average.',
    options: [
      { value: 'fixed', label: 'Fixed cards-per-minute limits' },
      { value: 'calibrated', label: 'Calibrated from my card history' },
    ],
  },
  [speedColorRedCpmId]: {
    kind: 'number',
    tier: 'popup',
    group: 'queueDashboard',
    showWhen: { id: speedColorModeId, equals: 'fixed' },
    min: 0.1,
    unit: 'cpm',
    title: 'Red At or Below',
    description:
      'A pace at or below this is drawn fully red; between here and the green limit the colour ' +
      'shifts gradually. Default 1.5 cpm (40 s/card).',
  },
  [speedColorGreenCpmId]: {
    kind: 'number',
    tier: 'popup',
    group: 'queueDashboard',
    showWhen: { id: speedColorModeId, equals: 'fixed' },
    min: 0.1,
    unit: 'cpm',
    title: 'Green At or Above',
    description:
      'A pace at or above this is drawn fully green. Must be higher than the red limit. ' +
      'Default 4 cpm (15 s/card).',
  },
  [speedCalibrationPeriodId]: {
    kind: 'dropdown',
    tier: 'popup',
    group: 'queueDashboard',
    showWhen: { id: speedColorModeId, equals: 'calibrated' },
    title: 'Calibration Period',
    description:
      'How far back your average seconds-per-card is measured. Every real flashcard repetition ' +
      'in the window counts, capped by the Flashcard Response Time Limit. A shorter window ' +
      'tracks your current form; a longer one is steadier.',
    options: [
      { value: 'ever', label: 'Ever' },
      { value: 'year', label: 'Last 1 year' },
      { value: 'month', label: 'Last 1 month' },
      { value: 'week', label: 'Last 1 week' },
    ],
  },
  [speedCalibrationMarginSecondsId]: {
    kind: 'number',
    tier: 'popup',
    group: 'queueDashboard',
    showWhen: { id: speedColorModeId, equals: 'calibrated' },
    min: 0.5,
    unit: 'seconds',
    title: 'Margin Around the Average',
    description:
      'Distance from your average, in seconds per card, at which the colour saturates: average ' +
      'plus this many seconds is fully red, average minus it is fully green, and your average ' +
      'itself sits mid-gradient. A smaller margin makes the dashboard react more sharply to ' +
      'small changes of pace.',
  },

  // --- Performance (native tier) ---
  [performanceModeId]: {
    kind: 'dropdown',
    tier: 'native',
    group: 'performance',
    helpPath: 'Full-Mode-x-Light-Mode/',
    title: 'Performance Mode',
    description:
      '"Light" is recommended for web and mobile. "Full" enables relative priority and the ' +
      'priority shield at a significant computational cost, and is best used in the desktop app.',
    options: [
      { value: 'full', label: 'Full (all features, high resource use)' },
      { value: 'light', label: 'Light (faster, no relative priority/shield)' },
    ],
  },
  [alwaysUseLightModeOnMobileId]: {
    kind: 'boolean',
    tier: 'native',
    group: 'performance',
    title: 'Always Use Light Mode on Mobile',
    description:
      'Switches to Light performance mode on iOS and Android, preventing crashes and improving ' +
      'performance. Recommended.',
  },
  [alwaysUseLightModeOnWebId]: {
    kind: 'boolean',
    tier: 'native',
    group: 'performance',
    title: 'Always Use Light Mode on Web Browser',
    description:
      'Switches to Light performance mode in the browser, where Full mode can be slow or unstable. ' +
      'Recommended.',
  },
  // --- Integrations ---
  [enableHideInQueueIntegrationId]: {
    kind: 'boolean',
    tier: 'native',
    group: 'integrations',
    reloadRequired: true,
    helpPath: 'Utilities/#hide-in-queue',
    title: 'Enable Hide-in-Queue Powerups and Commands',
    description:
      'Registers the "Hide in Queue", "Remove from Queue", "No Hierarchy", "Hide Parent" and ' +
      '"Hide Grandparent" powerups and commands inside Incremental Everything.\n\n' +
      'WARNING: only enable this if you do NOT have the standalone "Hide in Queue" plugin ' +
      'installed — duplicate powerup registration throws a fatal error that breaks this plugin. ' +
      'Uninstall the standalone plugin first, then reload RemNote.\n\n' +
      '"Remove Parent" and "Remove Grandparent" are always registered, since the Cloze and Extract ' +
      'creators depend on them.',
    // Last native-tier setting in registration order, so this lands at the very
    // bottom of the plugin's section in RemNote's panel.
    panelFooter: MORE_SETTINGS_POINTER,
  },

  // --- Misc ---
  [remnoteEnvironmentId]: {
    kind: 'dropdown',
    tier: 'popup',
    group: 'misc',
    title: 'RemNote Environment',
    description: 'Which RemNote environment links should open documents in.',
    options: [
      { value: 'www', label: 'Regular (www.remnote.com)' },
      { value: 'beta', label: 'Beta (beta.remnote.com)' },
    ],
  },
  [flashcardResponseTimeLimitId]: {
    kind: 'number',
    tier: 'popup',
    group: 'misc',
    min: 1,
    integer: true,
    unit: 'seconds',
    title: 'Flashcard Response Time Limit',
    description:
      'Answers taking longer than this (because you walked away, say) are counted only up to this ' +
      'limit in Practiced Queues statistics. Matches RemNote\'s own setting of the same name.',
  },
};

/** Ids in a stable display order: by group, in `IE_SETTING_GROUPS` order. */
export const IE_SETTING_IDS_BY_GROUP: Array<{ group: SettingGroupId; ids: IESettingId[] }> =
  (Object.keys(IE_SETTING_GROUPS) as SettingGroupId[]).map((group) => ({
    group,
    ids: (Object.keys(IE_SETTINGS_SCHEMA) as IESettingId[]).filter(
      (id) => IE_SETTINGS_SCHEMA[id].group === group
    ),
  }));

/** Every setting stored in the plugin's own blob rather than RemNote's panel. */
export const IE_POPUP_TIER_IDS: IESettingId[] = (
  Object.keys(IE_SETTINGS_SCHEMA) as IESettingId[]
).filter((id) => IE_SETTINGS_SCHEMA[id].tier === 'popup');

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/**
 * Coerces whatever the backend handed back into the setting's declared type,
 * falling back to the default when it cannot.
 *
 * Note the `??` rather than the `||` that most call sites used before: `0` is a
 * legal priority (the scale is 0-100) and `''` is the legal "use FSRS defaults"
 * value, and both are falsy. `||` silently replaced them with the default.
 */
function coerce<K extends IESettingId>(id: K, raw: unknown): IESettings[K] {
  const fallback = IE_SETTINGS_DEFAULTS[id];
  if (raw === undefined || raw === null) {
    return fallback;
  }
  if (typeof fallback === 'number') {
    // Number settings can come back as a string (or NaN) when the user clears
    // the field in RemNote's settings panel.
    const n = typeof raw === 'number' ? raw : Number(raw);
    return (Number.isFinite(n) ? n : fallback) as IESettings[K];
  }
  if (typeof fallback === 'boolean') {
    return Boolean(raw) as IESettings[K];
  }
  return raw as IESettings[K];
}

/**
 * The one place that talks to a settings backend, dispatching on tier.
 *
 * Popup-tier reads hit the synced blob; a missing key means "no opinion" and
 * resolves to the default, which is what lets a changed default still reach
 * users who never customised that setting.
 *
 * Native-tier throws are swallowed on purpose: `getSetting` raises a TypeError
 * for any id that is not currently registered, which is the state a popup-tier
 * id is in after migration and a native id would be in only if registration
 * failed. Either way the default is the right answer.
 */
async function readRawSetting(plugin: RNPlugin, id: IESettingId): Promise<unknown> {
  if (IE_SETTINGS_SCHEMA[id].tier === 'popup') {
    const values = await plugin.storage.getSynced<Partial<IESettings>>(ieSettingsValuesKey);
    return values ? values[id] : undefined;
  }
  try {
    return await plugin.settings.getSetting<unknown>(id);
  } catch (e) {
    console.warn(`[IESettings] read failed for "${id}", using default:`, e);
    return undefined;
  }
}

/**
 * Reads one setting, typed, with its default applied.
 *
 * @param plugin Plugin instance. Pass the reactive one inside a tracker if the
 *   caller should re-run when the setting changes.
 * @param id Setting id.
 */
export async function getIESetting<K extends IESettingId>(
  plugin: RNPlugin,
  id: K
): Promise<IESettings[K]> {
  return coerce(id, await readRawSetting(plugin, id));
}

/**
 * Reads several settings in one go. Convenience for call sites that used to
 * fire a `Promise.all` of `getSetting` calls.
 */
export async function getIESettings<K extends IESettingId>(
  plugin: RNPlugin,
  ids: readonly K[]
): Promise<{ [P in K]: IESettings[P] }> {
  const values = await Promise.all(ids.map((id) => getIESetting(plugin, id)));
  const out = {} as { [P in K]: IESettings[P] };
  ids.forEach((id, i) => {
    out[id] = values[i] as IESettings[K];
  });
  return out;
}

/**
 * Writes a popup-tier setting.
 *
 * A value equal to the default is *removed* rather than stored, so that editing
 * a default later still reaches everyone who has not deliberately diverged from
 * it. Native-tier settings have no SDK setter and can only be changed in
 * RemNote's own panel — calling this for one is a no-op with a warning.
 */
export async function setIESetting<K extends IESettingId>(
  plugin: RNPlugin,
  id: K,
  value: IESettings[K]
): Promise<void> {
  if (IE_SETTINGS_SCHEMA[id].tier !== 'popup') {
    console.warn(
      `[IESettings] "${id}" lives in RemNote's settings panel and cannot be written by the plugin.`
    );
    return;
  }
  const values = {
    ...((await plugin.storage.getSynced<Partial<IESettings>>(ieSettingsValuesKey)) || {}),
  };
  if (JSON.stringify(value) === JSON.stringify(IE_SETTINGS_DEFAULTS[id])) {
    delete values[id];
  } else {
    values[id] = value;
  }
  await plugin.storage.setSynced(ieSettingsValuesKey, values);
}

/** Restores a popup-tier setting to its default by removing it from the blob. */
export async function resetIESetting(plugin: RNPlugin, id: IESettingId): Promise<void> {
  await setIESetting(plugin, id, IE_SETTINGS_DEFAULTS[id]);
}

/**
 * React hook form, reactive: the component re-renders whenever the setting
 * changes. Returns `undefined` only while the first read is in flight.
 *
 * Use this — rather than `useIESetting` — wherever the code must distinguish
 * "not loaded yet" from "loaded, and it happens to equal the default". That
 * matters when a decision taken during the loading frame is not revisited: the
 * default would be treated as the user's answer and stick.
 */
export function useIESettingOptional<K extends IESettingId>(
  id: K
): IESettings[K] | undefined {
  return useTrackerPlugin(async (rp) => await getIESetting(rp, id), [id]);
}

/**
 * React hook form. Same reactivity, but substitutes the default for the loading
 * frame so callers never handle `undefined`. Right for display toggles, where
 * rendering the default for one frame is harmless.
 */
export function useIESetting<K extends IESettingId>(id: K): IESettings[K] {
  const value = useIESettingOptional(id);
  return value === undefined ? IE_SETTINGS_DEFAULTS[id] : value;
}

/**
 * Whether a setting should be shown, given the current values. Settings with no
 * `showWhen` are always shown.
 */
export function isSettingVisible(id: IESettingId, values: IESettings | undefined): boolean {
  const dep = IE_SETTINGS_SCHEMA[id].showWhen;
  if (!dep) return true;
  // Nothing loaded yet: show everything rather than flash rows in and out.
  if (!values) return true;
  return JSON.stringify(values[dep.id]) === JSON.stringify(dep.equals);
}

/**
 * Settings hidden right now because they depend on `id` holding a different
 * value, grouped by the value each needs.
 *
 * Grouped rather than flat because a setting can gate others in both directions
 * — the Beta Scheduler hides its own parameters when off and hides the
 * Multiplier when on — and the popup's hint has to name the right direction.
 */
export function hiddenDependentsOf(
  id: IESettingId,
  values: IESettings | undefined
): Array<{ requires: unknown; ids: IESettingId[] }> {
  const byRequired = new Map<string, { requires: unknown; ids: IESettingId[] }>();
  for (const other of Object.keys(IE_SETTINGS_SCHEMA) as IESettingId[]) {
    const dep = IE_SETTINGS_SCHEMA[other].showWhen;
    if (dep?.id !== id || isSettingVisible(other, values)) continue;
    const key = JSON.stringify(dep.equals);
    const entry = byRequired.get(key) ?? { requires: dep.equals, ids: [] };
    entry.ids.push(other);
    byRequired.set(key, entry);
  }
  return [...byRequired.values()];
}
