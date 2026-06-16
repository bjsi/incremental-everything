// powerup
export const powerupCode = 'incremental';
export const prioritySlotCode = 'priority';
export const nextRepDateSlotCode = 'nextRepDate';
export const repHistorySlotCode = 'repHist';
export const originalIncrementalDateSlotCode = 'originalIncDate';

// Dismissed Powerup
export const dismissedPowerupCode = 'dismissed';
export const dismissedHistorySlotCode = 'dismissedHistory';
export const dismissedDateSlotCode = 'dismissedDate';

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

// FSRS DSR settings
export const displayFsrsDsrId = 'display-fsrs-dsr';
export const fsrsWeightsId = 'fsrs-weights';

// storage keys
export const allIncrementalRemKey = 'all-incremental-rem';
export const currentIncRemKey = 'current-inc-rem';
export const allCardPriorityInfoKey = 'all-card-priority-info-key';
export const cardAnalyticsCacheKey = 'card-analytics-cache-key';
// Local-storage keys for "last selected period" — survives across sessions /
// app restarts (device-specific). Stored shape: { period, customStart, customEnd }.
export const cardAnalyticsLastPeriodKey = 'card-analytics-last-period';
export const fsrsCalibrationLastPeriodKey = 'fsrs-calibration-last-period';
export const studyDashboardLastPeriodKey = 'study-dashboard-last-period';
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
export const displayQueueToolbarPriorityId = 'display-queue-toolbar-priority';
export const autoFocusQueueDashboardId = 'auto-focus-queue-dashboard';
// Timestamp flag set by the IncRem "Next" paths just before they advance the
// queue (while their widget sandbox is still alive). A persistent QueueLoadCard
// listener consumes it to restore the Practiced Queues dashboard — the refocus
// can't run after removeCurrentCardFromQueue in the widget, which by then has
// been torn down. See refocus flow in lib/incremental_rem + register/events.
export const pendingQueueDashboardRefocusKey = 'pending-queue-dashboard-refocus-at';
export const priorityShieldHistoryKey = 'priority-shield-history-key';
export const priorityShieldHistoryMenuItemId = 'priority-shield-history-menu-item-id';
export const documentPriorityShieldHistoryKey = 'document-priority-shield-history-key';
export const currentSubQueueIdKey = 'current-sub-queue-id-key';
export const cardPriorityShieldHistoryKey = 'card-priority-shield-history-key';
export const documentCardPriorityShieldHistoryKey = 'document-card-priority-shield-history-key';

// --- Keys for the Weighted Priority Shield ---
export const displayWeightedShieldId = 'display-weighted-shield';
export const weightedShieldHistoryKey = 'weighted-shield-history-key';
export const documentWeightedShieldHistoryKey = 'document-weighted-shield-history-key';
export const cardWeightedShieldHistoryKey = 'card-weighted-shield-history-key';
export const documentCardWeightedShieldHistoryKey = 'document-card-weighted-shield-history-key';

// --- Keys for Open Editor in a new tab/window (PDFs) ---
export const remnoteEnvironmentId = 'remnote-environment';

export const noIncRemTimerKey = 'no-inc-rem-timer-end';
export const noIncRemMenuItemId = 'no-inc-rem-15-min';
export const noIncRemTimerWidgetId = 'no-inc-rem-timer-widget';
export const incRemDisabledDeviceKey = 'inc-rem-disabled-device';

export const cardPriorityCacheRefreshKey = 'cardPriorityCacheRefreshKey';
// Pending priority save job: written by priority_light popup before closing,
// picked up and executed by tracker.ts in the persistent index widget.
export const pendingPrioritySaveKey = 'pendingPrioritySave';
// Pending card priority removal job: written by the Priority popup before closing,
// picked up and executed by tracker.ts. Allows instant popup close per fire-and-forget philosophy.
export const pendingCardPriorityRemovalKey = 'pendingCardPriorityRemoval';
// Batch priority+interval save job: written by priority_interval.tsx (popup) before closing,
// picked up by tracker.ts in the persistent index widget. Contains all remIds + the chosen
// priority and interval so the popup can close instantly and let the tracker do all DB writes.
export const pendingIntervalBatchSaveKey = 'pendingIntervalBatchSave';
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

export const pdfHighlightColorId = 'pdf-highlight-color'; // Incremental PDF highlight color

export const currentDocumentIdKey = 'current-document-id';
export const popupDocumentIdKey = 'popup-document-id';

// Pending scroll-to-highlight request, picked up by the main-process listener
// in callbacks.ts after a widget triggers `openRemInNewPane`. The widget's
// iframe dies during the layout reorg, so the scroll must run in main-process.
export const pendingScrollRequestKey = 'pending-scroll-request';

// Priority Review Graph
export const priorityGraphPowerupCode = 'priority_review_graph';
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

