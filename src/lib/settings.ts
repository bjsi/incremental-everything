/**
 * Single source of truth for Incremental Everything's user settings.
 *
 * Every read of a user setting goes through `getIESetting` / `useIESetting`
 * instead of calling `plugin.settings.getSetting` directly. Two reasons:
 *
 * 1. Defaults live in exactly one place (`IE_SETTINGS_DEFAULTS`) instead of
 *    being restated — and sometimes contradicted — at each call site.
 * 2. It gives us one seam to swap the storage backend behind. When settings
 *    move out of RemNote's settings panel into the plugin's own popup, only
 *    the body of `readRawSetting` changes; the ~70 call sites do not.
 *
 * Why the defaults table is load-bearing: `plugin.settings.getSetting` resolves
 * a setting through its *registration record* and reads `defaultValue` off it.
 * For an id that is not currently registered it does not return `undefined` —
 * it throws `TypeError: Cannot read properties of undefined (reading
 * 'defaultValue')`. So the moment a setting stops being registered, every read
 * of it throws unless something supplies the default. That is this module.
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
  performanceModeId,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  displayFsrsDsrId,
  fsrsWeightsId,
  remnoteEnvironmentId,
  flashcardResponseTimeLimitId,
  skipMasteryDrillId,
  oldItemThresholdId,
  masteryDrillMinDelayMinutesId,
  disableFinalDrillNotificationId,
} from './consts';
// Type-only: utils.ts imports getIESetting from this module, so a value import
// here would close a runtime require cycle. `import type` is erased.
import type { PerformanceMode } from './utils';

/**
 * The type of every user setting. Keys are the setting ids as registered with
 * RemNote; adding a setting means adding it here *and* to
 * `IE_SETTINGS_DEFAULTS` (TypeScript enforces the pair).
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
  [skipMasteryDrillId]: boolean;
  [oldItemThresholdId]: number;
  [masteryDrillMinDelayMinutesId]: number;
  [disableFinalDrillNotificationId]: boolean;
}

export type IESettingId = keyof IESettings;

/**
 * The default for every setting. register/settings.ts reads its `defaultValue`
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
  [performanceModeId]: 'light',
  [alwaysUseLightModeOnMobileId]: true,
  [alwaysUseLightModeOnWebId]: true,

  [displayFsrsDsrId]: true,
  [fsrsWeightsId]: '',

  [remnoteEnvironmentId]: 'www',
  [flashcardResponseTimeLimitId]: 180,

  [skipMasteryDrillId]: false,
  [oldItemThresholdId]: 7,
  [masteryDrillMinDelayMinutesId]: 120,
  [disableFinalDrillNotificationId]: false,
};

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
 * The one place that talks to the settings backend. Swapping RemNote's settings
 * panel for the plugin's own storage means rewriting this function and nothing
 * else.
 *
 * Throws are swallowed on purpose: `getSetting` raises a TypeError for any id
 * that is not currently registered, and during the migration some ids will be
 * in exactly that state. `undefined` here means "no stored value", which
 * `coerce` turns into the default.
 */
async function readRawSetting(plugin: RNPlugin, id: IESettingId): Promise<unknown> {
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
