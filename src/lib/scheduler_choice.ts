/**
 * Which scheduler an Incremental Rem uses, read from and written to RemNote.
 * The rules themselves are pure and live in scheduler_core.ts; this file is the
 * SDK side: the settings, the rem's type and its hidden Scheduler slot.
 */
import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import {
  betaFirstReviewIntervalId,
  initialIntervalForDocumentsId,
  initialIntervalForHighlightsId,
  initialIntervalForRemsId,
  initialIntervalForVideosId,
  initialIntervalId,
  betaMaxIntervalId,
  betaSchedulerEnabledId,
  multiplierId,
  powerupCode,
  schedulerForDocumentsId,
  schedulerForHighlightsId,
  schedulerForRemsId,
  schedulerForVideosId,
  schedulerSlotCode,
} from './consts';
import { remToActionItemType } from './incremental_rem/action_items';
import { getIESettings, SchedulerTypeDefault } from './settings';
import {
  overrideForChoice,
  parseSchedulerOverride,
  ResolvedScheduler,
  resolveInheritedScheduler,
  resolveInitialInterval,
  resolveScheduler,
  SchedulerChoice,
  SchedulerOverride,
  SchedulerTypeGroup,
  schedulerTypeGroup,
  serializeSchedulerOverride,
} from './scheduler_core';

export interface SchedulerSettings {
  defaultKind: 'multiplier' | 'curve';
  defaultFactor: number;
  curveFirstInterval: number;
  curveMaxInterval: number;
  typeDefaults: Record<SchedulerTypeGroup, SchedulerTypeDefault>;
}

export async function getSchedulerSettings(plugin: RNPlugin): Promise<SchedulerSettings> {
  const s = await getIESettings(plugin, [
    betaSchedulerEnabledId,
    multiplierId,
    betaFirstReviewIntervalId,
    betaMaxIntervalId,
    schedulerForDocumentsId,
    schedulerForVideosId,
    schedulerForHighlightsId,
    schedulerForRemsId,
  ]);
  return {
    defaultKind: s[betaSchedulerEnabledId] ? 'curve' : 'multiplier',
    defaultFactor: Number(s[multiplierId]),
    curveFirstInterval: Number(s[betaFirstReviewIntervalId]),
    curveMaxInterval: Number(s[betaMaxIntervalId]),
    typeDefaults: {
      documents: s[schedulerForDocumentsId],
      videos: s[schedulerForVideosId],
      highlights: s[schedulerForHighlightsId],
      rems: s[schedulerForRemsId],
    },
  };
}

export async function readSchedulerOverride(rem: PluginRem): Promise<SchedulerOverride | null> {
  try {
    return parseSchedulerOverride(await rem.getPowerupProperty(powerupCode, schedulerSlotCode));
  } catch {
    return null;
  }
}

/**
 * The scheduler the settings give this rem, ignoring its own slot. The rem's
 * type is only worked out when a per-type setting could actually change the
 * answer — it costs several bridge calls, and Next runs this on every review.
 */
export async function getInheritedScheduler(
  plugin: RNPlugin,
  rem: PluginRem,
  settings: SchedulerSettings
): Promise<ResolvedScheduler> {
  const anyTypeDefault = Object.values(settings.typeDefaults).some(
    (v) => v === 'multiplier' || v === 'curve'
  );
  let typeDefault: SchedulerTypeDefault = 'default';
  if (anyTypeDefault) {
    let type = null;
    try {
      type = (await remToActionItemType(plugin, rem, { silent: true }))?.type ?? null;
    } catch {
      // Unresolvable type: schedule it as a regular rem.
    }
    typeDefault = settings.typeDefaults[schedulerTypeGroup(type)];
  }
  return resolveInheritedScheduler({
    typeDefault,
    defaultKind: settings.defaultKind,
    defaultFactor: settings.defaultFactor,
  });
}

export interface RemSchedulerInfo {
  /** What Next uses for this rem right now. */
  scheduler: ResolvedScheduler;
  /** What it would use with its own slot cleared. */
  inherited: ResolvedScheduler;
  settings: SchedulerSettings;
}

export async function getRemSchedulerInfo(
  plugin: RNPlugin,
  rem: PluginRem,
  settings?: SchedulerSettings
): Promise<RemSchedulerInfo> {
  const resolvedSettings = settings ?? (await getSchedulerSettings(plugin));
  const [override, inherited] = await Promise.all([
    readSchedulerOverride(rem),
    getInheritedScheduler(plugin, rem, resolvedSettings),
  ]);
  return {
    scheduler: resolveScheduler(override, inherited),
    inherited,
    settings: resolvedSettings,
  };
}

/**
 * Put a rem on `choice`. The slot is written only when the choice differs from
 * what the settings already give the rem, and cleared otherwise — so a rem that
 * was never singled out keeps following the settings as they change.
 */
export async function applySchedulerChoice(
  plugin: RNPlugin,
  rem: PluginRem,
  choice: SchedulerChoice,
  settings?: SchedulerSettings
): Promise<void> {
  const resolvedSettings = settings ?? (await getSchedulerSettings(plugin));
  const inherited = await getInheritedScheduler(plugin, rem, resolvedSettings);
  const wanted = overrideForChoice(choice, inherited);
  const wantedText = wanted ? serializeSchedulerOverride(wanted) : '';

  const current = await readSchedulerOverride(rem);
  const currentText = current ? serializeSchedulerOverride(current) : '';
  if (wantedText === currentText) return;

  await rem.setPowerupProperty(powerupCode, schedulerSlotCode, [wantedText]);
}

const INITIAL_INTERVAL_IDS = {
  documents: initialIntervalForDocumentsId,
  videos: initialIntervalForVideosId,
  highlights: initialIntervalForHighlightsId,
  rems: initialIntervalForRemsId,
} as const;

/**
 * The Initial Interval for a rem being made Incremental: its type's own setting
 * when one is set, otherwise the general one.
 *
 * Pass a `group` when the type is already known (a rem the caller just created
 * as a plain rem), which skips the type lookup. Otherwise the type is worked out
 * only if some per-type value is actually set — this runs inside the create
 * flow, where every extra bridge call is felt.
 */
export async function getInitialIntervalForRem(
  plugin: RNPlugin,
  rem: PluginRem | null,
  group?: SchedulerTypeGroup
): Promise<number> {
  const s = await getIESettings(plugin, [initialIntervalId, ...Object.values(INITIAL_INTERVAL_IDS)]);
  const general = Number(s[initialIntervalId]);
  const anySet = Object.values(INITIAL_INTERVAL_IDS).some((id) => String(s[id] ?? '').trim() !== '');
  if (!anySet) return resolveInitialInterval('', general);

  let resolvedGroup = group;
  if (!resolvedGroup) {
    let type = null;
    if (rem) {
      try {
        type = (await remToActionItemType(plugin, rem, { silent: true }))?.type ?? null;
      } catch {
        // Unresolvable type: treat it as a regular rem.
      }
    }
    resolvedGroup = schedulerTypeGroup(type);
  }
  return resolveInitialInterval(s[INITIAL_INTERVAL_IDS[resolvedGroup]], general);
}
