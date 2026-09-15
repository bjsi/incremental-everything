import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { priorityCalcScopeRemIdsKey } from '../consts';
import type { CardPriorityInfo } from '../card_priority/types';
import { CoolingScanner } from './cooling_gather';
import { findHeldByCoolingAncestor } from './shield_eligibility';
import { HeldByCoolingAncestor, readCoolingCache } from './cooling_store';
import { isCardCacheUsable } from './card_source';

/**
 * The shield's cooling scan: which of the top overdue Rems may not set the
 * Priority Shield because they are cooling, or held back by a cooling ancestor.
 *
 * The result lives in SESSION storage (cooling_store), so a RemNote restart
 * empties it. The live shield in the queue reads it; before this ran at startup,
 * the first queue after a restart counted every cooling Rem until its exit
 * published a scan — a live shield of P5 against a saved one of P9, measured.
 *
 * It runs at three moments, all through {@link runShieldCoolingScan}:
 *   - queue exit, fresh, before the shield history is saved;
 *   - once at startup, as soon as the card cache has finished loading;
 *   - at queue entry, in the background, only if no scan has run yet in this
 *     RemNote run (a queue opened before the startup scan finished).
 * Always from the card cache — never a card.getAll().
 */

/** How many of the top overdue Rems the shield can move through. */
const KB_HEAD = 150;
const SCOPE_HEAD = 100;

export interface ShieldCoolingScanResult {
  /** Rems excluded from the shield: cooling themselves, or held by a cooling ancestor. */
  excludedIds: Set<RemId>;
  held: HeldByCoolingAncestor[];
  checked: number;
  coolingInHead: number;
}

export async function runShieldCoolingScan(
  plugin: RNPlugin,
  opts: {
    allCardInfos: CardPriorityInfo[];
    seenRemIds?: Iterable<RemId>;
    /** The document scope's Rem ids, when the shield also has a document scope. */
    scopeRemIds?: RemId[] | null;
    scopeRemId?: RemId | null;
  }
): Promise<ShieldCoolingScanResult> {
  const seenSet = new Set<RemId>(opts.seenRemIds ?? []);
  const overdueByPriority = opts.allCardInfos
    .filter((info) => (info.dueCardsOverdue ?? 0) > 0 && !info.paused && !seenSet.has(info.remId))
    .sort((a, b) => a.priority - b.priority);
  const headIds = overdueByPriority.slice(0, KB_HEAD).map((info) => info.remId);
  const scopeIdSet = opts.scopeRemIds ? new Set(opts.scopeRemIds) : null;
  const scopeHeadIds = scopeIdSet
    ? overdueByPriority.filter((info) => scopeIdSet.has(info.remId)).slice(0, SCOPE_HEAD).map((info) => info.remId)
    : [];

  const scanner = new CoolingScanner(plugin, {
    scopeRemId: opts.scopeRemId ?? null,
    priorityByRemId: new Map(overdueByPriority.map((info) => [info.remId, info.priority])),
  });
  const toCheck = [...new Set([...headIds, ...scopeHeadIds])];
  await scanner.scan(toCheck);
  // Not cooling themselves, but held back by a cooling ancestor: just as
  // unavailable, so just as ineligible to set the shield. A due ancestor that
  // is NOT cooling keeps its child counted — that review is open.
  const held = await findHeldByCoolingAncestor(
    plugin,
    toCheck.filter((id) => !scanner.isCooling(id)),
    scanner
  );
  await scanner.publish({ held, heldCheckedIds: new Set(toCheck) });
  return {
    excludedIds: new Set([...scanner.coolingIds(), ...held.map((h) => h.remId)]),
    held,
    checked: toCheck.length,
    coolingInHead: toCheck.filter((id) => scanner.isCooling(id)).length,
  };
}

let ensureInFlight = false;

/**
 * Runs the scan once if nothing has published cooling data in this RemNote run
 * and the card cache is ready. Returns without doing anything otherwise — in
 * Light Mode, while the cache is still loading, or once any scan (startup, an
 * exit, a refresh, Rescan) has published.
 *
 * Resolves `true` when cooling data is published (by this call or an earlier
 * one; a call already in flight counts), `false` when it was skipped or failed.
 */
export async function ensureShieldCoolingScanned(plugin: RNPlugin, reason: string): Promise<boolean> {
  if (ensureInFlight) return true;
  ensureInFlight = true;
  const tag = `[CoolingScan] ${reason}`;
  try {
    if (await readCoolingCache(plugin)) return true;
    const infos = await isCardCacheUsable(plugin);
    if (!infos) {
      console.log(`${tag}: skipped, the card cache is not ready (or Light Mode)`);
      return false;
    }
    const startedAt = Date.now();
    const scopeRemIds = (await plugin.storage.getSession<RemId[] | null>(priorityCalcScopeRemIdsKey)) ?? null;
    const result = await runShieldCoolingScan(plugin, { allCardInfos: infos, scopeRemIds });
    console.log(
      `${tag}: ${result.coolingInHead} of ${result.checked} top overdue Rems cooling, ` +
        `${result.held.length} held back by a cooling ancestor — published for the live shield, ` +
        `in ${Date.now() - startedAt}ms`
    );
    return true;
  } catch (e) {
    console.warn(`${tag}: failed`, e);
    return false;
  } finally {
    ensureInFlight = false;
  }
}

const STARTUP_WAIT_MS = 10 * 60 * 1000;
const STARTUP_POLL_MS = 3000;

/**
 * Once per startup: waits for the card cache to finish loading, then runs the
 * scan so the first queue of this RemNote run already excludes cooling Rems.
 * Call only where the card cache is built (Full Mode, prioritisation on).
 *
 * Resolves with the scan's outcome, or `false` if the card cache never finished
 * loading in time — the startup status reads it (lib/startup_status.ts).
 */
export function registerStartupShieldCoolingScan(plugin: RNPlugin): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + STARTUP_WAIT_MS;
    const tick = async () => {
      try {
        const loaded = await plugin.storage.getSession<boolean>('card_priority_cache_fully_loaded');
        if (loaded) {
          resolve(await ensureShieldCoolingScanned(plugin, 'startup'));
          return;
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() < deadline) setTimeout(tick, STARTUP_POLL_MS);
      else {
        console.log('[CoolingScan] startup: skipped, the card cache did not finish loading in time');
        resolve(false);
      }
    };
    setTimeout(tick, STARTUP_POLL_MS);
  });
}
