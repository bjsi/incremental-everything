// powerup
export const powerupCode = 'incremental';
export const prioritySlotCode = 'priority';
export const nextRepDateSlotCode = 'nextRepDate';
export const repHistorySlotCode = 'repHist';
export const originalIncrementalDateSlotCode = 'originalIncDate';

// PDF reading state (page, page range, page history, active PDF) as serialized
// JSON, replacing four per-(Rem, PDF) synced-key families. Registered on BOTH
// the Incremental and Dismissed powerups under the same code and shape:
// dismissing a Rem removes the Incremental powerup, so the state is copied
// across as an opaque string rather than being lost. See lib/pdf_state.ts.
export const pdfStateSlotCode = 'pdfState';

// Dismissed Powerup
export const dismissedPowerupCode = 'dismissed';
export const dismissedHistorySlotCode = 'dismissedHistory';
export const dismissedDateSlotCode = 'dismissedDate';

// Marks a "tombstone" rem whose content was removed by the
// 'Preserve history & remove' command but whose review history was preserved on
// its Dismissed powerup. Used purely as a CSS hook (data-rem-tags~="preservedhistory")
// to hide the tombstone in the editor and queue.
export const preservedHistoryPowerupCode = 'preservedHistory';

// Marks a rem that carries at least one image in its text or back text. Applied
// and removed by the 'Tag Rems With Images' command, which exists because
// RemNote's own search indexes text only: an image contributes no searchable
// token, so there is no native way to isolate the images in a document. The tag
// gives RemNote's document Filter something to match on.
//
// A powerup rather than a plain tag rem for two reasons: RemNote's Filter lists
// powerups alongside ordinary tags, and an applied powerup pill carries a stable
// `data-test` attribute, so the chip can be hidden without hiding the user's own
// tags on the same rem (see registerHasImageCSS).
export const hasImagePowerupCode = 'hasImage';
// RemNote derives the data-rem-tags slug from the NAME, lowercased with spaces
// stripped — so this name and the `hasimage` slug in the CSS must stay in step.
export const hasImagePowerupName = 'HasImage';

// Marks a Rem whose text is ONLY an image — no caption, no prose — AND which is
// a PDF/HTML highlight, i.e. an *area* highlight: one where RemNote stored the
// clipped image instead of the selected text.
//
// A separate powerup rather than a CSS combination of HasImage + pdf-highlight,
// because that combination is wrong for the common case of adding a figure to an
// ordinary TEXT highlight — such a rem holds an image and is a highlight, yet is
// not an area highlight. "Image and nothing else" is a property of the rem's
// rich text, which no CSS selector can inspect, so it has to be decided during
// the scan and written down as a tag.
export const pdfAreaHighlightPowerupCode = 'pdfAreaHighlight';
// Slug consumed by the CSS: lowercased, spaces stripped (see hasImagePowerupName).
export const pdfAreaHighlightPowerupName = 'PdfAreaHighlight';

// settings
export const initialIntervalId = 'initial-interval';
export const multiplierId = 'multiplier';
export const betaSchedulerEnabledId = 'beta-scheduler-enabled';
export const betaFirstReviewIntervalId = 'beta-first-review-interval';
export const betaMaxIntervalId = 'beta-max-interval';
export const collapseQueueTopBar = 'collapse-queue-top-bar';
export const defaultPriorityId = 'default-priority';
export const defaultCardPriorityId = 'defaultCardPriority';
export const isolatedQueueModeId = 'isolated-queue-view-mode';
export type IsolatedQueueMode = 'highlights' | 'rems' | 'both' | 'none';
export const priorityStepSizeId = 'priority-step-size';
export const enableHideInQueueIntegrationId = 'enable-hide-in-queue-integration';

// Setting ids that used to be written as bare string literals at their call
// sites. Named here so lib/settings.ts can be the single source of truth for
// every setting's id, type and default.
export const priorityEditorDisplayModeId = 'priorityEditorDisplayMode';
export type PriorityEditorDisplayMode = 'all' | 'incRemOnly' | 'disable';
// The four below are the *setting* ids. register/settings.ts has same-named
// local consts holding the registerCSS ids for the stylesheets they toggle
// ('hide-card-priority-tag' etc.) — hence the SettingId suffix here.
export const hideCardPriorityTagSettingId = 'hideCardPriorityTag';
export const showLeftBorderForIncRemsSettingId = 'showLeftBorderForIncRems';
export const showDismissedIndicatorSettingId = 'showDismissedIndicator';
export const hideDismissedTagSettingId = 'hideDismissedTag';
// Gates the coloured rings drawn around reference PINS in the editor, and — when
// off — also suppresses the priority-band marker that the highlight stylesheet
// leaks onto those same pin containers. Off by default: the rings only carry
// meaning once "Tag Rems With Images" has been run, and an unasked-for marker on
// every pin is exactly the clutter this setting exists to opt into.
export const showPinRingIndicatorsSettingId = 'showPinRingIndicators';
export const performanceModeId = 'performanceMode';
export const flashcardResponseTimeLimitId = 'flashcard_response_time_limit';
/** Custom acronyms the Text Case Converter keeps uppercase in Title Case. */
export const titleCaseAcronymsId = 'title-case-acronyms';
export const enableMasteryDrillId = 'enable-mastery-drill';
/** Pre-inversion id, kept only so the migration can convert stored values. */
export const legacySkipMasteryDrillId = 'skip_mastery_drill';
export const oldItemThresholdId = 'old_item_threshold';
export const masteryDrillMinDelayMinutesId = 'mastery_drill_min_delay_minutes';
export const disableFinalDrillNotificationId = 'disable_final_drill_notification';

// --- Queue Dashboard: speed colour coding ---
/** Fixed cpm thresholds, or thresholds derived from the user's own history. */
export const speedColorModeId = 'speed_color_mode';
export type SpeedColorMode = 'fixed' | 'calibrated';
/** Fixed mode: at or below this pace the speed reading is fully red. */
export const speedColorRedCpmId = 'speed_color_red_cpm';
/** Fixed mode: at or above this pace the speed reading is fully green. */
export const speedColorGreenCpmId = 'speed_color_green_cpm';
/** Calibrated mode: how far back the average seconds-per-card is measured. */
export const speedCalibrationPeriodId = 'speed_calibration_period';
export type SpeedCalibrationPeriod = 'ever' | 'year' | 'month' | 'week';
/** Calibrated mode: seconds either side of that average for red / green. */
export const speedCalibrationMarginSecondsId = 'speed_calibration_margin_seconds';
/** Device-local cache of the last calibration run (see lib/speed_color.ts). */
export const speedCalibrationCacheKey = 'speed_calibration_cache_v1';

// Opt-in gate for the heavy flashcard-prioritisation machinery (KB-wide
// pretagging, the inheritance cascade and the card-priority cache). Off by
// default: most users want extracts and scheduling, and should not pay for
// per-flashcard priorities they never asked for.
export const enableFlashcardPrioritisationId = 'enable-flashcard-prioritisation';
/**
 * Per-KB record of the last seen value of the gate above, so that turning it OFF
 * can offer the (reversible) inherited/default cleanup exactly once — see
 * lib/card_priority/opt_out.ts.
 *
 * Synced storage is shared across ALL of the user's knowledge bases, and the tags
 * this drives are per-KB, so the value is stored KB-partitioned as
 * `{ [kbId]: record }` — the same shape as the shield history.
 */
export const flashcardPrioritisationOptOutStateKey = 'flashcard-prioritisation-opt-out-state';
/**
 * Per-KB record of the CardPriority hidden-slot migration: whether this KB's
 * priority values have been moved out of the VISIBLE `priority` slot into the
 * hidden `priorityValue` one, and whether the user asked not to be offered it
 * again. See lib/card_priority/slot_access.ts and hidden_slot_migration.ts.
 *
 * SYNCED, and KB-partitioned as `{ [kbId]: record }` like the key above: the
 * migration changes the knowledge base itself, so every device must learn that
 * it has happened — a device still writing the visible slot would recreate the
 * property children the migration deleted.
 */
export const cardPriorityHiddenSlotStateKey = 'card-priority-hidden-slot-state';

// FSRS DSR settings
export const displayFsrsDsrId = 'display-fsrs-dsr';
export const fsrsWeightsId = 'fsrs-weights';
export const fsrsRequestedRetentionId = 'fsrs-requested-retention';

// --- Plugin-owned settings store (see lib/settings_migration.ts) ---
/** Synced blob holding the values of every popup-tier setting. */
export const ieSettingsValuesKey = 'ie_settings_v1';
/** Seed version that last completed; gates the legacy registrations. */
export const ieSettingsMigratedKey = 'ie_settings_migrated';
/** Durable per-setting record of the last migration run. */
export const ieSettingsMigrationReportKey = 'ie_settings_migration_report';

// --- Onboarding hub (see lib/onboarding_tips.ts, widgets/plugin_hub.tsx) ---
/** Sidebar widget id for the "Incremental RemNote" hub panel. */
export const pluginHubWidgetId = 'plugin_hub';
/**
 * Synced, KB-partitioned record of the tips the user has answered "I Got It"
 * to: `{ [kbId]: { acknowledged: string[] } }`.
 */
export const onboardingTipsStateKey = 'onboarding-tips-state';
/**
 * Device-local mirror of the same record, in the same shape.
 *
 * Synced storage has lost this plugin's data before (the shield history went
 * blank when RemNote reworked its storage layer), and an acknowledgement that
 * evaporates is the one failure the user actually notices: the tip they retired
 * comes back. The mirror is written on every acknowledgement and unioned into
 * every read, so a synced value that returns empty — wiped, or simply not
 * hydrated yet when the sidebar mounts — cannot resurrect a retired tip, and
 * cannot be written back over the good record either.
 */
export const onboardingTipsLocalMirrorKey = 'onboarding-tips-state-local';
/** Local timestamp until which the tip panel stays quiet after a ✕ dismissal. */
export const onboardingTipsSnoozeKey = 'onboarding-tips-snooze-until';
/**
 * Set once a tip has been answered in this session, in **session** storage.
 *
 * "One tip per session" was previously enforced only by the hub component not
 * re-drawing while it stayed mounted, which is not the same thing: the sidebar
 * slot remounts as the app is used, and each remount re-ran the draw. With most
 * of a category acknowledged the pool is small, so those re-draws land on the
 * same two or three tips and read as a tip you already answered coming back.
 */
export const onboardingTipsAnsweredSessionKey = 'onboarding-tips-answered-session';
/**
 * The tip drawn in this session, so a remount re-shows THAT tip rather than
 * drawing another. Without it "one tip per session" only held once the tip was
 * answered — before that, every remount rolled again.
 */
export const onboardingTipsDrawnSessionKey = 'onboarding-tips-drawn-session';
/**
 * Local, KB-partitioned record of when each tip was last put on screen:
 * `{ [kbId]: { [tipId]: epochMs } }`. Feeds the least-recently-shown draw.
 *
 * Local rather than synced on purpose. This is pacing, not a decision the user
 * made — it does not deserve sync traffic on every panel mount, and a tip seen
 * on the desktop this morning is not one the phone needs to skip tonight.
 */
export const onboardingTipsLastShownKey = 'onboarding-tips-last-shown';
/** Popup widget id for the "All Tips" list behind the tip card's third button. */
export const onboardingTipsWidgetId = 'onboarding_tips';
/**
 * The user closed the hub panel. **Session** storage on purpose: closing it is
 * "not now, I need the room", not a preference — it comes back on the next
 * start, the same way the Mastery Drill notification does. Cleared early by
 * {@link showPluginHubCommandId}.
 */
export const pluginHubHiddenKey = 'plugin-hub-hidden';
/** Command that brings the hub back within the same session. */
export const showPluginHubCommandId = 'ie_show_plugin_hub';

// storage keys
export const allIncrementalRemKey = 'all-incremental-rem';
/**
 * Selection-only projection of {@link allIncrementalRemKey}: `remId`,
 * `nextRepDate` and `priority`, and nothing else.
 *
 * The full cache carries every Rem's complete repetition history — measured at
 * 7.99MB across 5,525 entries, 4,758 of them with history. Queue item selection
 * needs none of it, but used to pull the whole thing over the plugin bridge on
 * every single GetNextCard call. This projection is roughly a tenth of the size
 * and is written by the same writers, in the same places, so the two cannot
 * drift. Anything needing `history` must still read the full key.
 */
export const allIncrementalRemSlimKey = 'all-incremental-rem-slim';

/**
 * Whether the priority-calculation scope stored in `priorityCalcScopeRemIdsKey`
 * was derived from COMPLETE caches, per item type: `{ incRem, card }`.
 *
 * Why this has to be recorded at build time rather than checked at use time: for
 * a Priority Review Document scoped to the whole KB, that scope is not walked
 * from the rem tree — it is *materialised from the two session caches* as
 * "every card rem plus every incremental rem". If a cache is still loading when
 * QueueEnter runs (a full IncRem load was measured at 28s on a 5,525-rem KB),
 * the resulting id list is permanently missing that type, and no later cache
 * load repairs it.
 *
 * QueueExit's `isIncRemCacheLoaded || !skipIncRemHistorySave` guard cannot catch
 * this: by exit the cache HAS finished loading, so the guard passes and a
 * document shield gets written against the truncated scope. That is how a
 * session recorded an IncRem document shield over a universe of 239 instead of
 * 5,525 — a wrong number, silently, in permanent history.
 *
 * Scopes built by `buildComprehensiveScope` walk the rem tree and do not depend
 * on either cache, so they are always complete.
 */
export const priorityCalcScopeCompletenessKey = 'priority-calc-scope-completeness';
export const currentIncRemKey = 'current-inc-rem';
export const allCardPriorityInfoKey = 'all-card-priority-info-key';
export const cardAnalyticsCacheKey = 'card-analytics-cache-key';
// Local-storage keys for "last selected period" — survives across sessions /
// app restarts (device-specific). Stored shape: { period, customStart, customEnd }.
export const cardAnalyticsLastPeriodKey = 'card-analytics-last-period';

/** Session cache for the paused-deck scan (see lib/paused_decks.ts). Paused decks
 *  suppress their whole subtree without touching any card's nextRepetitionTime,
 *  so they have to be discovered once and reused. */
export const pausedDeckScanKey = 'paused-deck-scan';

/** Session cache for the Suppressed Cards tab's report (see
 *  lib/card_analytics_export.ts → buildSuppressionReport). */
export const suppressionReportKey = 'suppression-report';

/** SYNCED: Rem ids the user has reviewed in the Suppressed Cards tab and marked
 *  as checked, so the judgement survives a restart and reaches other devices.
 *  Ids only — the actionable set is a couple of hundred, far inside the
 *  per-key budget. */
export const verifiedSuppressedRemsKey = 'verified-suppressed-rems';

/** Session: the anchor Rem the Card Enablement Audit panel opened on. Set by
 *  the command / document-menu item before the popup mounts, exactly as the
 *  batch card-priority panel does with its own anchor. */
export const cardEnablementAnchorKey = 'card-enablement-anchor-rem';

/** Session: the last Card Enablement Audit apply's before-state, so the panel
 *  can offer an undo after a bulk write. Session rather than synced — an undo
 *  belongs to the run that is still on screen. */
export const cardEnablementSnapshotKey = 'card-enablement-last-snapshot';
export const fsrsCalibrationLastPeriodKey = 'fsrs-calibration-last-period';
export const studyDashboardLastPeriodKey = 'study-dashboard-last-period';
/**
 * Queue Selection Odds panel: last selected universe, as its `kind-scope` key
 * (e.g. `card-kb`). Device-local, like the period keys above — which universe
 * you compare in is a reading preference, not shared knowledge-base state.
 */
export const selectionOddsLastUniverseKey = 'selection-odds-last-universe';
// Priority Shield Graph: persists the "Show Weighted Shield" checkbox and the
// 1M/3M/6M/1Y/All period filter across sessions. Device-specific.
// Stored shape: { showWeightedShield: boolean, timePeriod: 'month'|'3m'|'6m'|'year'|'all' }.
export const priorityShieldGraphPrefsKey = 'priority-shield-graph-prefs';
export const incremReviewStartTimeKey = 'increm-review-start-time';
// Intentional reactive signal: bump this key (via setSession) to trigger an IncRem cache reload.
// The tracker reads it via `rp` (reactive), but calls loadIncrementalRemCache with the
// non-reactive `plugin` reference so that taggedRem() does NOT register broad subscriptions.
export const incRemCacheReloadKey = 'inc-rem-cache-reload-trigger';

// widgets
export const scrollToHighlightId = 'scroll-to-highlight';
export const pageRangeWidgetId = 'page-range';
export const parentSelectorWidgetId = 'parent_selector';

// css
export const collapseTopBarId = 'collapse-top-bar';
export const collapseTopBarKey = 'collapseTopBarState';

export const queueCounterId = 'queue-counter';

export const hideIncEverythingId = 'hide-inc-everything';
export const shouldHideIncEverythingKey = 'shouldHideIncEverything';

// commands
export const dismissIncRemCommandId = 'dismiss-inc-rem';
export const nextInQueueCommandId = 'next-in-queue';
export const togglePdfHighlightBordersCommandId = 'toggle-pdf-highlight-borders';

// Local (per-device) flag controlling whether the pdfextract/incremental marker
// borders are drawn over PDF-viewer highlights. Default ON (undefined => true).
// The "peek" toggle (command + highlight-toolbar button) flips this and the CSS
// is re-registered to match. See registerPdfHighlightCSS in lib/ui_helpers.ts.
export const pdfHighlightBordersEnabledKey = 'pdf-highlight-borders-enabled';

// Local (per-device) flag for the parent selector's "Filter only headers"
// checkbox. When on, expanded branches show only rems carrying a heading
// (H1–H6); the initial IncRem root candidates are never filtered.
// Default OFF (undefined => false).
export const parentSelectorHeadingsOnlyKey = 'parent-selector-headings-only';

// Local (per-device) flag for the parent selector's "List headings first"
// checkbox. When on, heading children are hoisted above the rest of a branch,
// shallowest level first; when off, children keep their editor order.
// Default ON (undefined => true).
export const parentSelectorHeadingsFirstKey = 'parent-selector-headings-first';

// Session key bumped whenever the borders flag is toggled. registerCSS can only be
// called from the index widget, so the toggle (which may run in the highlight-toolbar
// iframe) can't re-register the CSS itself. Instead it bumps this key; a plugin.track
// in the index widget subscribes to it and re-registers. Session storage is the
// codebase's cross-iframe reactive channel (plugin.track only tracks getSession/getSynced).
export const pdfHighlightBordersReloadKey = 'pdf-highlight-borders-reload';

// --- Keys for our successful fixes ---
export const queueLayoutFixId = 'incremental-everything-queue-layout-fix';
export const queueHideElementsId = 'incremental-everything-queue-hide-elements';
export const collapseTopBarCssId = 'incremental-everything-collapse-top-bar'; // CSS registration ID
export const incrementalQueueActiveKey = 'incremental-queue-active';
export const activeHighlightIdKey = 'active-highlight-id-key';
export const currentIncrementalRemTypeKey = 'current-incremental-rem-type-key';
export const currentScopeRemIdsKey = 'current-scope-rem-ids-key';

// --- Keys for the Priority Protection ---
export const seenRemInSessionKey = 'seen-rem-in-session-key';
export const seenCardInSessionKey = 'seen-card-in-session-key';
export const displayPriorityShieldId = 'display-priority-shield';
// Spoiler protection: hold back an IncRem while a card it would give away is
// still due this session — one on the rem itself, or one on a direct child
// tagged `cloze-extract` (a cloze carved out of it with Alt+Z) — so the extract
// cannot hand over the answer before the card is graded. See lib/queue_prefetch.
export const deferSpoilerIncRemsId = 'defer-spoiler-increms';
export const displayQueueToolbarPriorityId = 'display-queue-toolbar-priority';
export const autoFocusQueueDashboardId = 'auto-focus-queue-dashboard';
// Timestamp flag set by the IncRem "Next" paths just before they advance the
// queue (while their widget sandbox is still alive). A persistent QueueLoadCard
// listener consumes it to restore the Practiced Queues dashboard — the refocus
// can't run after removeCurrentCardFromQueue in the widget, which by then has
// been torn down. See refocus flow in lib/incremental_rem + register/events.
export const pendingQueueDashboardRefocusKey = 'pending-queue-dashboard-refocus-at';
// Session mount marker written by the practiced_queues widget. Read by
// lib/queue_dashboard as both a "did the tab come up?" acknowledgement and as
// the canary target for its wedged-channel watchdog.
export const practicedQueuesVisibleKey = 'practiced_queues_visible';
export const priorityShieldHistoryKey = 'priority-shield-history-key';
export const priorityShieldHistoryMenuItemId = 'priority-shield-history-menu-item-id';
export const documentPriorityShieldHistoryKey = 'document-priority-shield-history-key';
export const currentSubQueueIdKey = 'current-sub-queue-id-key';
export const cardPriorityShieldHistoryKey = 'card-priority-shield-history-key';
export const documentCardPriorityShieldHistoryKey = 'document-card-priority-shield-history-key';
// Dated backups written by the "Remove CardPriority Tags…" cleanup (full scope) before it
// clears this KB's shield partition, plus an index listing them for restore.
export const cardShieldCleanupBackupPrefix = 'card-shield-cleanup-backup-';
export const cardShieldCleanupBackupIndexKey = 'card-shield-cleanup-backup-index';
// Characters kept in the `text` preview of the history jump-lists. The stored
// field is "front back" and the limit applies to that COMBINED string — it used
// to be per side, which let a single entry hold 2×limit + 1 characters.
// These lists are searched by substring and shown as one-line previews — they are
// caches for navigation, not a copy of the card, and they live in synced storage
// where a 900KB per-key ceiling applies (896KB in practice, counted in UTF-16
// bytes, i.e. HALF the character count our audit reports as UTF-8). Keep the
// writer and the widget backfill on the same constant so they cannot drift apart.
export const flashcardHistoryTextLimit = 400;
export const remHistoryTextLimit = 400;
// Entries kept per knowledge base. `text` dominates an entry, so these caps and
// the limits above are what actually bound the key; see history_shards.ts for
// the byte budget that backstops both.
export const flashcardHistoryMaxEntries = 500;
export const remHistoryMaxEntries = 500;

// Restore point of a rem's Incremental history, captured by the debug tools
// before a hand-edit. One synced key per backed-up rem — lives here (not in
// debug.tsx) so the synced-key audit can reconstruct the family.
export const debugHistoryBackupPrefix = 'debug_history_backup_';

// --- Keys for the Weighted Priority Shield ---
// NOTE: the weighted-shield value is stored INLINE on each main shield-history
// entry (the `weightedShield` field), and the graph reads it from there. The
// dedicated *-weighted-shield-history-key stores were never written or read, so
// they were removed as dead code.
export const displayWeightedShieldId = 'display-weighted-shield';

// --- Keys for Open Editor in a new tab/window (PDFs) ---
export const remnoteEnvironmentId = 'remnote-environment';

export const noIncRemTimerKey = 'no-inc-rem-timer-end';
export const noIncRemMenuItemId = 'no-inc-rem-15-min';
export const noIncRemTimerWidgetId = 'no-inc-rem-timer-widget';
export const incRemDisabledDeviceKey = 'inc-rem-disabled-device';

export const cardPriorityCacheRefreshKey = 'cardPriorityCacheRefreshKey';
// Rem IDs whose cards exist but whose parent rem could not be found during the
// last cache build (orphan-card candidates). Written by Phase 2 of
// loadCardPriorityCache, read by the 'Update all inherited Card Priorities'
// cleanup so it can skip re-scanning to find them.
export const orphanRemIdsKey = 'orphan-rem-ids-key';
// Pending priority save job: written by priority_light popup before closing,
// picked up and executed by tracker.ts in the persistent index widget.
// Setting id AND registerCSS id for the table-cell priority badges.
export const showPriorityBandsInTablesId = 'showPriorityBandsInTables';
// Bumped whenever the band→percentile mapping should be recomputed and the band
// stylesheets re-registered (caches warmed at startup, or a badge refresh). Same
// pattern as pdfHighlightBordersReloadKey: registerCSS is index-only, so a
// plugin.track in index.tsx watches this key and re-registers there.
export const priorityBandColorsReloadKey = 'priority-band-colors-reload';
// Per-device opt-in for the band-colour instrumentation: the full band →
// percentile → colour table each stylesheet is built from. Off by default — the
// dump is four tables per re-registration and would swamp the console — but the
// mapping is otherwise invisible, since a badge coloured from the ABSOLUTE
// fallback scale looks exactly like a correctly ranked one. Local, not session,
// so it survives a reload once switched on. Toggled by the
// `toggle-priority-band-logging` command.
export const priorityBandVerboseLogsKey = 'priority-band-verbose-logs';
export const pendingPrioritySaveKey = 'pendingPrioritySave';
// Rem ids a priority popup should apply to when opened in batch mode (Opt+P /
// Ctrl+Opt+P over a multi-rem selection, e.g. several table rows). Written by the
// command, read by priority.tsx / priority_light.tsx. Distinct from
// batchPriorityIntervalRemIds, which is the post-extract IncRem-only flow.
export const batchPriorityTargetRemIdsKey = 'batchPriorityTargetRemIds';
// Pending card priority removal job: written by the Priority popup before closing,
// picked up and executed by tracker.ts. Allows instant popup close per fire-and-forget philosophy.
export const pendingCardPriorityRemovalKey = 'pendingCardPriorityRemoval';
// Batch priority+interval save job: written by priority_interval.tsx (popup) before closing,
// picked up by tracker.ts in the persistent index widget. Contains all remIds + the chosen
// priority and interval so the popup can close instantly and let the tracker do all DB writes.
export const pendingIntervalBatchSaveKey = 'pendingIntervalBatchSave';
// Deferred "create IncRem" tail job: written by createRemUnderParent (parent-selector
// popup) right before it opens the priority popup, picked up by tracker.ts in the
// persistent index widget. Contains everything the priority popup does NOT need
// (cache update, pdfextract tag, last-destination memory, bookmark, highlight cleanup)
// so the popup can appear immediately instead of waiting ~3s for these writes. Running
// in the index widget also means the writes survive popup teardown and can be wrapped
// in the plugin_operation_active / incRemBatchActive suppression flags.
export const pendingIncRemCreateTailKey = 'pendingIncRemCreateTail';
// Delta queue for quick increase/decrease priority commands.
// Each keypress APPENDS a delta entry here; the tracker drains them all atomically.
// This prevents the last-write-wins race that plagued the single-slot pendingPrioritySaveKey approach.
export const pendingPriorityDeltaQueueKey = 'pendingPriorityDeltaQueue';
export const queueSessionCacheKey = 'queueSessionCache';
export const priorityCalcScopeRemIdsKey = 'priority-calc-scope-rem-ids-key';

// --- Keys for Mobile Light Mode Auto-Switch ---
// Mobile Detection
export const alwaysUseLightModeOnMobileId = 'always-use-light-mode-on-mobile';
export const lastDetectedOSKey = 'last-detected-os';
export const isMobileDeviceKey = 'is-mobile-device'; // Stores whether current device is mobile

// Web Platform Detection
export const alwaysUseLightModeOnWebId = 'alwaysUseLightModeOnWeb';
export const isWebPlatformKey = 'isWebPlatform';
export const lastDetectedPlatformKey = 'lastDetectedPlatform';

//Editor Review Timer
export const editorReviewTimerRemIdKey = 'editor-review-timer-rem-id';
export const editorReviewTimerStartKey = 'editor-review-timer-start';
export const editorReviewTimerIntervalKey = 'editor-review-timer-interval';
export const editorReviewTimerPriorityKey = 'editor-review-timer-priority';
export const editorReviewTimerRemNameKey = 'editor-review-timer-rem-name';
// The timer's clock is a PAIR: elapsed = accumulated + (now − start), with
// `paused-at` freezing the running segment. Anything adjusting the elapsed time
// must write both, or the widget and the recorder disagree.
export const editorReviewTimerAccumulatedMsKey = 'editor-review-timer-accumulated-ms';
export const editorReviewTimerPausedAtKey = 'editor-review-timer-paused-at';
export const editorReviewTimerOriginKey = 'editor-review-timer-origin';
export const editorReviewTimerDateOverrideKey = 'editor-review-timer-date-override';

export const pdfHighlightColorId = 'pdf-highlight-color'; // Incremental PDF highlight color

export const currentDocumentIdKey = 'current-document-id';
export const popupDocumentIdKey = 'popup-document-id';

// Pending scroll-to-highlight request, picked up by the main-process listener
// in callbacks.ts after a widget triggers `openRemInNewPane`. The widget's
// iframe dies during the layout reorg, so the scroll must run in main-process.
export const pendingScrollRequestKey = 'pending-scroll-request';

// SYNCED: set once the plugin has pinned the "Priority Review Queue" tag Rem to
// the left sidebar, so the pin is offered exactly once per knowledge base. A
// user who unpins it afterwards keeps it unpinned — see
// priority_review_document/sidebar_pin.ts.
export const prqTagSidebarPinnedKey = 'prq-tag-sidebar-pinned';

// Priority Review Graph
export const priorityGraphPowerupCode = 'priority_review_graph';
// Hidden slot on the graph Rem holding that graph's data as serialized JSON.
// Replaces the per-graph synced key `priority_review_graph_data_<remId>`: the
// snapshot belongs to the graph Rem, so storing it there means it is deleted
// with the Priority Review Document instead of being orphaned in plugin storage
// (which has no deletion API — orphans were unreclaimable).
export const priorityGraphDataSlotCode = 'graphData';
export const GRAPH_DATA_KEY_PREFIX = 'priority_review_graph_data_';
// Synced index of every graph Rem ID we've written graph data for. Used to find
// orphaned `GRAPH_DATA_KEY_PREFIX + remId` entries on startup so they can be cleared.
export const REVIEW_GRAPH_INDEX_KEY = 'priority_review_graph_index';

// Priority Graph (document-scope, inline in inc_rem_counter)
export const PRIORITY_GRAPH_DATA_KEY_PREFIX = 'priority_graph_data_';

// Video Extract Powerup
export const videoExtractPowerupCode = 'videoExtract';
export const videoExtractUrlSlotCode = 'videoUrl';
export const videoExtractStartSlotCode = 'startTime';
export const videoExtractEndSlotCode = 'endTime';

// IncRem Notes Sidebar (right sidebar widget)
// Stable rem id published by ExtractViewer while a Rem-type IncRem is shown in
// the queue, so the notes sidebar can edit it without depending on
// currentIncrementalRemTypeKey — which the queue clears on every effect-cleanup
// and so races with the sidebar auto-open. Cleared by ExtractViewer on unmount
// and (defensively) by the QueueLoadCard listener in register/events.
export const incremNotesSidebarRemIdKey = 'increm-notes-sidebar-rem-id';
// Opened programmatically by the Reader 📝 button; reads currentIncRemKey directly.
export const incremNotesSidebarWidgetId = 'increm_notes_sidebar';
// Host document ID for highlight IncRems (PDF/HTML source Rem).
// Set by queue.tsx so the sidebar can discover related IncRems without
// re-resolving the action item type.
export const currentHostDocumentIdKey = 'current-host-document-id';

// Source Popup (floating variant) — opened by the `open-source-in-floating`
// command. openFloatingWidget has no contextData param, so the resolved target
// is handed off via session storage, and the live widget id is stashed so the
// QueueLoadCard listener can auto-close it on card advance.
export const sourceFloatingWidgetId = 'pdf_source_floating';
export const sourceFloatingTargetKey = 'source-floating-target';
export const sourceFloatingActiveIdKey = 'source-floating-active-id';


// Convert literal \[..\] / \(..\) / **..** left by PDF text-layer extraction
// into real RemNote rich text (formulas, bold, italic).
export const convertExtractedMarkupCommandId = 'convert-extracted-markup';
