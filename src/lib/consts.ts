// powerup
export const powerupCode = 'incremental';
export const prioritySlotCode = 'priority';
export const nextRepDateSlotCode = 'nextRepDate';
export const repHistorySlotCode = 'repHist';

// settings
export const initialIntervalId = 'initial-interval';
export const multiplierId = 'multiplier';
export const collapseQueueTopBar = 'collapse-queue-top-bar';
export const defaultPriorityId = 'default-priority';
export const defaultCardPriorityId = 'defaultCardPriority';
export const showRemsAsIsolatedInQueueId = 'show-rems-as-isolated-in-queue';

// storage keys
export const allIncrementalRemKey = 'all-incremental-rem';
export const currentIncRemKey = 'current-inc-rem';
export const allCardPriorityInfoKey = 'all-card-priority-info-key';
export const incremReviewStartTimeKey = 'increm-review-start-time';

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
export const nextRepCommandId = 'next-rep-cmd';

// --- Keys for our successful fixes ---
export const queueLayoutFixId = 'incremental-everything-queue-layout-fix';
export const incrementalQueueActiveKey = 'incremental-queue-active';
export const activeHighlightIdKey = 'active-highlight-id-key';
export const currentIncrementalRemTypeKey = 'current-incremental-rem-type-key';
export const currentScopeRemIdsKey = 'current-scope-rem-ids-key';

// --- Keys for the Priority Protection ---
export const seenRemInSessionKey = 'seen-rem-in-session-key';
export const seenCardInSessionKey = 'seen-card-in-session-key';
export const displayPriorityShieldId = 'display-priority-shield';
export const priorityShieldHistoryKey = 'priority-shield-history-key';
export const priorityShieldHistoryMenuItemId = 'priority-shield-history-menu-item-id';
export const documentPriorityShieldHistoryKey = 'document-priority-shield-history-key';
export const currentSubQueueIdKey = 'current-sub-queue-id-key';
export const cardPriorityShieldHistoryKey = 'card-priority-shield-history-key';
export const documentCardPriorityShieldHistoryKey = 'document-card-priority-shield-history-key';

// --- Keys for Open Editor in a new tab/window (PDFs) ---
export const remnoteEnvironmentId = 'remnote-environment';

export const noIncRemTimerKey = 'no-inc-rem-timer-end';
export const noIncRemMenuItemId = 'no-inc-rem-15-min';
export const noIncRemTimerWidgetId = 'no-inc-rem-timer-widget';

export const cardPriorityCacheRefreshKey = 'cardPriorityCacheRefreshKey';
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

// Priority Review Graph
export const priorityGraphPowerupCode = 'priority_review_graph';
export const GRAPH_DATA_KEY_PREFIX = 'priority_review_graph_data_';
