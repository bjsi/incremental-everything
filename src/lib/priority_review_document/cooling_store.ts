import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { coolingCacheKey, coolingOverridesKeyPrefix, coolingIntervalPercentId, coolingMinDaysId, coolingMaxDaysId } from '../consts';
import { getIESettings } from '../settings';
import {
  CoolingOverrides,
  CoolingParams,
  CoolingVerdict,
  DAY_MS,
  DEFAULT_COOLING_PARAMS,
  EMPTY_COOLING_OVERRIDES,
  pruneCoolingOverrides,
} from './cooling';

/**
 * Persistence for cooling — deliberately thin.
 *
 * Synced storage holds ONLY the user's overrides, one small record per KB.
 * Synced storage has lost this plugin's data before (the shield history went
 * blank in the storage overhaul), so nothing that can be recomputed is kept
 * there: the cooling set itself is derived from card data on every refresh.
 * Losing the overrides costs at most a few "release now" clicks.
 *
 * Session storage holds the last computed verdicts so the shields and the
 * Cooling list can read them without rerunning the scan. Verdicts carry their
 * own `until`, so the set self-expires between refreshes.
 */

const FALLBACK_KB_ID = 'default';

/** The cooling window parameters from the IE settings, with the defaults as fallback. */
export async function getCoolingParams(plugin: RNPlugin): Promise<CoolingParams> {
  try {
    const s = await getIESettings(plugin, [coolingIntervalPercentId, coolingMinDaysId, coolingMaxDaysId]);
    const pct = Number(s[coolingIntervalPercentId]);
    const min = Number(s[coolingMinDaysId]);
    const max = Number(s[coolingMaxDaysId]);
    return {
      intervalFraction: Number.isFinite(pct) ? Math.max(0, pct) / 100 : DEFAULT_COOLING_PARAMS.intervalFraction,
      minDays: Number.isFinite(min) ? Math.max(0, min) : DEFAULT_COOLING_PARAMS.minDays,
      maxDays: Number.isFinite(max) ? Math.max(0, max) : DEFAULT_COOLING_PARAMS.maxDays,
    };
  } catch {
    return DEFAULT_COOLING_PARAMS;
  }
}

async function getKbId(plugin: RNPlugin): Promise<string> {
  try {
    const kb = await plugin.kb.getCurrentKnowledgeBaseData();
    return kb?._id ?? FALLBACK_KB_ID;
  } catch {
    return FALLBACK_KB_ID;
  }
}

async function overridesKey(plugin: RNPlugin): Promise<string> {
  return `${coolingOverridesKeyPrefix}_${await getKbId(plugin)}`;
}

/** Fills in any half-missing record, so callers never null-check fields. */
function normalise(raw: Partial<CoolingOverrides> | null | undefined): CoolingOverrides {
  return {
    released: { ...(raw?.released ?? {}) },
    extended: { ...(raw?.extended ?? {}) },
    never: [...(raw?.never ?? [])],
  };
}

export async function readCoolingOverrides(plugin: RNPlugin): Promise<CoolingOverrides> {
  try {
    const raw = await plugin.storage.getSynced<Partial<CoolingOverrides>>(await overridesKey(plugin));
    return normalise(raw);
  } catch (e) {
    console.warn('[Cooling] Could not read overrides:', e);
    return normalise(EMPTY_COOLING_OVERRIDES);
  }
}

async function writeCoolingOverrides(plugin: RNPlugin, overrides: CoolingOverrides): Promise<void> {
  const pruned = pruneCoolingOverrides(overrides, Date.now(), await getCoolingParams(plugin));
  await plugin.storage.setSynced(await overridesKey(plugin), pruned);
}

/** "Release now": events seen up to this instant stop cooling the Rem. */
export async function releaseCooling(plugin: RNPlugin, remId: RemId): Promise<void> {
  const overrides = await readCoolingOverrides(plugin);
  overrides.released[remId] = Date.now();
  delete overrides.extended[remId];
  await writeCoolingOverrides(plugin, overrides);
  await dropFromCache(plugin, remId);
}

/** Keep the Rem cooling for at least `days` more from now. */
export async function extendCooling(plugin: RNPlugin, remId: RemId, days: number): Promise<number> {
  const until = Date.now() + Math.max(0, days) * DAY_MS;
  const overrides = await readCoolingOverrides(plugin);
  overrides.extended[remId] = Math.max(overrides.extended[remId] ?? 0, until);
  await writeCoolingOverrides(plugin, overrides);
  await patchCache(plugin, remId, (v) => ({ ...v, until: Math.max(v.until, until), extendedUntil: until }));
  return until;
}

export async function setNeverCool(plugin: RNPlugin, remId: RemId, never: boolean): Promise<void> {
  const overrides = await readCoolingOverrides(plugin);
  const set = new Set(overrides.never);
  if (never) set.add(remId);
  else set.delete(remId);
  overrides.never = [...set];
  await writeCoolingOverrides(plugin, overrides);
  if (never) await dropFromCache(plugin, remId);
}

// --- session cache ---------------------------------------------------------

export interface CoolingCache {
  computedAt: number;
  /** Scope the scan ran for: null = full KB; otherwise the scope Rem. Informational. */
  scopeRemId: RemId | null;
  verdicts: CoolingVerdict[];
}

export async function writeCoolingCache(plugin: RNPlugin, cache: CoolingCache): Promise<void> {
  await plugin.storage.setSession(coolingCacheKey, cache);
}

export async function readCoolingCache(plugin: RNPlugin): Promise<CoolingCache | null> {
  try {
    return (await plugin.storage.getSession<CoolingCache>(coolingCacheKey)) ?? null;
  } catch {
    return null;
  }
}

async function dropFromCache(plugin: RNPlugin, remId: RemId): Promise<void> {
  const cache = await readCoolingCache(plugin);
  if (!cache) return;
  await writeCoolingCache(plugin, {
    ...cache,
    verdicts: cache.verdicts.filter((v) => v.remId !== remId),
  });
}

async function patchCache(
  plugin: RNPlugin,
  remId: RemId,
  patch: (v: CoolingVerdict) => CoolingVerdict
): Promise<void> {
  const cache = await readCoolingCache(plugin);
  if (!cache) return;
  await writeCoolingCache(plugin, {
    ...cache,
    verdicts: cache.verdicts.map((v) => (v.remId === remId ? patch(v) : v)),
  });
}

/**
 * The Rems currently cooling, as of `now`, from the last scan. This is what
 * the shields subtract before taking their minimum: a Rem whose sibling you
 * just reviewed must not be the one pinning the shield at its priority. Reads
 * the cache only — never rescans — and drops verdicts whose window has run
 * out, so the set shrinks on its own between refreshes.
 */
export async function getCoolingRemIdSet(plugin: RNPlugin, now: number = Date.now()): Promise<Set<RemId>> {
  const cache = await readCoolingCache(plugin);
  if (!cache) return new Set();
  return new Set(cache.verdicts.filter((v) => v.until > now).map((v) => v.remId));
}

/**
 * Merges a scan into the cache: Rems the scan judged replace their previous
 * entry (so a Rem that stopped cooling disappears), Rems it did not look at
 * keep theirs while their window lasts. This is what lets a document-scoped
 * refresh and a full-KB refresh share one cache without one wiping the other's
 * knowledge of the KB's top.
 */
export async function mergeCoolingCache(
  plugin: RNPlugin,
  scan: { computedAt: number; scopeRemId: RemId | null; checkedIds: ReadonlySet<RemId>; verdicts: CoolingVerdict[] }
): Promise<void> {
  const existing = await readCoolingCache(plugin);
  const kept = (existing?.verdicts ?? []).filter(
    (v) => v.until > scan.computedAt && !scan.checkedIds.has(v.remId)
  );
  await writeCoolingCache(plugin, {
    computedAt: scan.computedAt,
    scopeRemId: scan.scopeRemId,
    verdicts: [...scan.verdicts, ...kept],
  });
}
