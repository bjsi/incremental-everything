// KB-wide sizing scan for the post-overhaul slot damage.
//
// WHY THIS EXISTS
// ---------------
// lib/raw_slot_dump.ts explains one Rem in full detail. That proved WHAT is
// broken but says nothing about HOW MUCH, and the two defects it uncovered have
// very different consequences at scale:
//
//   1. DETACHED PRIORITY — the priority property's slot reference points at an
//      orphaned, nameless slot Rem instead of the registered one. The value is
//      still on the Rem, so this is recoverable: rewriting the priority creates a
//      correctly-referenced property (confirmed on two Rems).
//
//   2. DANGLING DATE — the Next Rep Date property is correctly referenced, but
//      the Daily Document it points at no longer exists. Nothing on the property
//      can be recovered; only the plugin's own `nextRepMs` history stamp saves
//      the schedule. This is the one that could represent real loss.
//
// The observed sample hinted that dangling dates correlate with how far ahead the
// reference was written (a 30-day interval failed; two 1-day intervals survived),
// which would mean empty future daily documents did not survive the migration.
// The interval breakdown below tests that against the whole knowledge base rather
// than three Rems.
//
// Covers BOTH priority powerups — Incremental and CardPriority — because they
// share the display name "Priority" and the leading theory is that a name-keyed
// migration step is what crossed the references over.
//
// READ-ONLY. Every call is a getter; nothing here writes.

import { RNPlugin, PluginRem, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { powerupCode, prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode } from './consts';
import { CARD_PRIORITY_CODE, PRIORITY_SLOT, SOURCE_SLOT, PrioritySource } from './card_priority/types';
import { safeRemTextToString } from './pdfUtils';
import { getPowerupSlotByCodeSafe } from './powerup_slot_compat';
import { refIdsIn, readRawText } from './raw_slot_dump';

export interface ScanSample {
  remId: string;
  text: string;
  /** The value found on the property, when there is one. */
  storedValue: string | null;
  /** The slot Rem the property actually references. */
  pointsAt: string | null;
  pointsAtName: string | null;
}

export interface PowerupScanResult {
  label: string;
  code: string;
  /** Registered priority slot definition — the id a healthy property references. */
  registeredSlotId: string | null;
  /** Rems carrying this powerup. */
  total: number;
  /** Priority property present and referencing the registered slot. */
  ok: number;
  /** Priority property present but referencing an unregistered (orphan) slot. */
  detached: number;
  /** No priority property found at all — nothing was ever written, or it is gone. */
  missing: number;
  /**
   * Rems carrying MORE THAN ONE property Rem for the registered priority slot.
   * These read as healthy — the plugin resolves one of them and gets a correct
   * value — but the user sees several "Priority" rows under the Rem, and only
   * one of them tracks what the plugin writes. Distinct from `detached`, where
   * the link is wrong, and from `leftoverSlots`, where the slot Rem is foreign.
   */
  duplicated: number;
  /** detached / total, as a percentage. */
  detachedPct: number;
  /** Which orphan slot Rems the detached properties point at, and how often. */
  orphanTargets: Array<{ slotDefId: string; name: string; count: number }>;
  samples: ScanSample[];
}

export interface DateScanResult {
  /** Incremental Rems that have a Next Rep Date property at all. */
  totalWithProperty: number;
  /** Its Daily Document reference resolves. */
  ok: number;
  /** Its Daily Document reference points at a Rem that no longer exists. */
  dangling: number;
  /** Property present but holding no reference at all. */
  empty: number;
  /** Incremental Rems carrying more than one Next Rep Date property Rem. */
  duplicated: number;
  danglingPct: number;
  /**
   * Of the dangling ones, how many still carry a `nextRepMs` stamp in their own
   * history. That stamp is the only surviving record of the date the deleted
   * Daily Document encoded, so it is exactly what a repair would rebuild from —
   * these are recoverable.
   */
  danglingRecoverable: number;
  /** Dangling with no `nextRepMs` anywhere in history: the date is genuinely gone. */
  danglingUnrecoverable: number;
  /** danglingRecoverable / dangling, as a percentage. */
  recoverablePct: number;
  /**
   * Dangling-vs-healthy split by the scheduling interval recorded in the Rem's
   * last history entry — i.e. how far ahead the Daily Document reference was
   * written. If short intervals survive and long ones do not, future-dated daily
   * documents were pruned. `recoverable` is the repairable subset of `dangling`.
   */
  byInterval: Array<{ bucket: string; ok: number; dangling: number; recoverable: number }>;
  samples: ScanSample[];
  /** The cases a repair could NOT fix — the ones actually worth worrying about. */
  unrecoverableSamples: ScanSample[];
}

/**
 * A priority property Rem left behind on a Rem whose priority now reads fine.
 * Invisible to a readability check, but visible to the user as a stray
 * "Unnamed — N" row in the outliner.
 */
export interface LeftoverProperty {
  propertyRemId: string;
  ownerRemId: string;
  value: string;
  slotId: string;
  slotName: string;
  /**
   * - `ours`        — the slot Rem is a child of Incremental or CardPriority.
   * - `deleted-slot`— the slot Rem no longer exists.
   * - `foreign`     — the slot belongs to some other powerup, so this is somebody
   *                   else's property and NOT litter. Reported, never counted.
   */
  category: 'ours' | 'deleted-slot' | 'foreign';
  /**
   * Whether the owning Rem's priority reads correctly through the API right now.
   *
   * This is the safety flag for any cleanup:
   *  - `true`  — the good value lives elsewhere, so this really is litter.
   *  - `false` — nothing readable on the Rem, so this property may hold the ONLY
   *              surviving copy of that priority. It must be recovered, never
   *              deleted.
   */
  ownerPriorityReadable: boolean;
  /**
   * The owning Rem's CardPriority `prioritySource`, read from its (hidden, and
   * therefore undamaged) slot. Only populated for stranded leftovers, since it is
   * what decides their fate:
   *
   *  - `manual` / `incremental` — the number carries information nothing else
   *    holds. RECOVER it.
   *  - `inherited` / `default`  — derivable; the plugin recomputes it from the
   *    ancestor cascade, so the leftover is redundant and safe to delete.
   */
  ownerSource: PrioritySource | null;
}

export interface SlotScanReport {
  exportedAt: string;
  durationMs: number;
  incremental: PowerupScanResult;
  cardPriority: PowerupScanResult;
  nextRepDate: DateScanResult;
  /**
   * Rems carrying BOTH powerups where a detached property was found. Both
   * powerups' priority slots are displayed as "Priority" and a detached property
   * no longer says which one it came from, so these are attributed on a
   * best-effort basis and counted here so the ambiguity is visible.
   */
  ambiguousBothPowerups: number;
  /** Orphan slot Rems present on the two powerup definitions. */
  orphanSlotsOnDefinitions: Array<{ powerup: string; slotDefId: string; name: string }>;
  /**
   * Leftover priority property Rems — counted regardless of whether the owning
   * Rem's priority reads correctly. This is the litter a cleanup pass would
   * target, and it is deliberately measured separately from `detached`: a Rem can
   * be perfectly readable and still be carrying one.
   */
  leftoverCount: number;
  /** Leftovers whose owning Rem reads fine — genuine litter, safe to delete. */
  leftoverSafeToDelete: number;
  /**
   * Leftovers on Rems with NO readable priority: this property is the only
   * surviving copy. These must be RECOVERED (rewritten through the normal path),
   * never deleted, and they explain part of the `missing` counts above.
   */
  leftoverStranded: number;
  /**
   * Of the stranded ones, those whose CardPriority source is `manual` or
   * `incremental` (or unreadable) — the value is real and must be written back.
   */
  strandedNeedsRecovery: number;
  /**
   * Stranded but `inherited`/`default`: the plugin recomputes those from the
   * ancestor cascade, so the leftover is redundant and safe to delete.
   */
  strandedDiscardable: number;
  /** Full breakdown of the stranded set by source, with the action each implies. */
  strandedBySource: Array<{ source: string; count: number; action: 'recover' | 'discardable' }>;
  /**
   * Leftovers whose owner's priority slot READS — i.e. the value is materialised
   * where it belongs and the orphan is genuinely redundant. This is the correct
   * input to a cleanup: it is derived from the current state, so it updates
   * automatically once something (a repair, or "Update all inherited Card
   * Priorities") has populated the slots.
   */
  safeToDeleteAll: LeftoverProperty[];
  /** The stranded ones, for inspection before anything is written. */
  strandedSamples: LeftoverProperty[];
  /**
   * EVERY stranded leftover, uncapped. This is the authoritative work list — the
   * repair consumes it directly rather than re-deriving the predicate, because
   * two independent implementations of "is this a stranded priority" disagreed
   * three times running (324 vs 375) and each disagreement cost a debugging
   * round. One predicate, two consumers.
   */
  strandedAll: LeftoverProperty[];
  /** Which slot Rems the leftovers point at, and how many each. */
  leftoverSlots: Array<{ slotId: string; name: string; count: number; category: LeftoverProperty['category'] }>;
  leftoverSamples: LeftoverProperty[];
  notes: string[];
}

const SAMPLE_CAP = 20;
const BATCH_SIZE = 200;

const INTERVAL_BUCKETS: Array<{ bucket: string; test: (d: number) => boolean }> = [
  { bucket: '0–1 days', test: (d) => d <= 1 },
  { bucket: '2–7 days', test: (d) => d <= 7 },
  { bucket: '8–30 days', test: (d) => d <= 30 },
  { bucket: '31–90 days', test: (d) => d <= 90 },
  { bucket: '90+ days', test: () => true },
  { bucket: '(unknown)', test: () => true },
];

const bucketFor = (days: number | null): string => {
  if (days == null || isNaN(days)) return '(unknown)';
  return INTERVAL_BUCKETS.find((b) => b.bucket !== '(unknown)' && b.test(days))!.bucket;
};

/** Every slot-definition Rem hanging off a powerup, registered or not. */
async function slotChildrenOf(
  plugin: RNPlugin,
  code: string
): Promise<Array<{ id: string; name: string }>> {
  const powerup = await plugin.powerup.getPowerupByCode(code).catch(() => undefined);
  if (!powerup) return [];
  const children = await powerup.getChildrenRem().catch(() => []);
  const out: Array<{ id: string; name: string }> = [];
  for (const child of children || []) {
    if (!(await child.isPowerupSlot().catch(() => false))) continue;
    out.push({ id: child._id, name: await safeRemTextToString(plugin, child.text) });
  }
  return out;
}

/**
 * Scans the whole knowledge base and sizes both defects.
 *
 * @param onProgress Called as batches complete so the UI can show progress.
 * @param analyzeIntervals Read each Rem's history to bucket dangling dates by
 *        scheduling interval. Costs one extra property read per Incremental Rem;
 *        it is what tests the "future daily documents were pruned" theory.
 */
export async function scanKbForDetachedSlots(
  plugin: RNPlugin,
  onProgress?: (done: number, total: number, phase: string) => void,
  analyzeIntervals = true
): Promise<SlotScanReport> {
  const started = Date.now();
  const notes: string[] = [];

  // ── Slot definitions: which ids are legitimate, which are orphans ─────────
  const [incSlotChildren, cardSlotChildren] = await Promise.all([
    slotChildrenOf(plugin, powerupCode),
    slotChildrenOf(plugin, CARD_PRIORITY_CODE),
  ]);
  const [incPrioritySlot, cardPrioritySlot, nextRepSlot] = await Promise.all([
    getPowerupSlotByCodeSafe(plugin, powerupCode, prioritySlotCode),
    getPowerupSlotByCodeSafe(plugin, CARD_PRIORITY_CODE, PRIORITY_SLOT),
    getPowerupSlotByCodeSafe(plugin, powerupCode, nextRepDateSlotCode),
  ]);
  const incPriorityId = incPrioritySlot?._id ?? null;
  const cardPriorityId = cardPrioritySlot?._id ?? null;
  const nextRepId = nextRepSlot?._id ?? null;

  // Names for every slot Rem we might see referenced, so orphans are identifiable.
  const slotNameById = new Map<string, string>();
  for (const s of [...incSlotChildren, ...cardSlotChildren]) slotNameById.set(s.id, s.name);

  // The union of all slot Rems on both definitions. A property child references
  // one of these; if it is not the registered priority slot, it is detached.
  const allSlotIds = new Set<string>(slotNameById.keys());

  const orphanSlotsOnDefinitions: SlotScanReport['orphanSlotsOnDefinitions'] = [];
  for (const [label, children, registeredIds] of [
    ['Incremental', incSlotChildren, [incPriorityId, nextRepId]],
    ['CardPriority', cardSlotChildren, [cardPriorityId]],
  ] as const) {
    for (const c of children) {
      // A slot child with no name is an orphan by definition; a named one that we
      // cannot map back to a registered code is reported too, minus the ones we
      // positively resolved.
      const isNamedAndKnown = c.name && c.name !== 'Untitled' && c.name !== 'Missing Name';
      if (!isNamedAndKnown && !registeredIds.includes(c.id)) {
        orphanSlotsOnDefinitions.push({ powerup: label, slotDefId: c.id, name: c.name || '(unnamed)' });
      }
    }
  }

  if (!incPriorityId) notes.push('Incremental priority slot could not be resolved — its counts are unreliable.');
  if (!cardPriorityId) notes.push('CardPriority priority slot could not be resolved — its counts are unreliable.');

  // ── Gather the populations ────────────────────────────────────────────────
  const incPowerup = await plugin.powerup.getPowerupByCode(powerupCode).catch(() => undefined);
  const cardPowerup = await plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE).catch(() => undefined);
  const incRems = ((await incPowerup?.taggedRem().catch(() => [])) || []) as PluginRem[];
  const cardRems = ((await cardPowerup?.taggedRem().catch(() => [])) || []) as PluginRem[];

  const incIds = new Set(incRems.map((r) => r._id));

  const mkResult = (label: string, code: string, registeredSlotId: string | null): PowerupScanResult => ({
    label, code, registeredSlotId,
    total: 0, ok: 0, detached: 0, missing: 0, duplicated: 0, detachedPct: 0,
    orphanTargets: [], samples: [],
  });
  const incremental = mkResult('Incremental', powerupCode, incPriorityId);
  const cardPriority = mkResult('CardPriority', CARD_PRIORITY_CODE, cardPriorityId);
  const nextRepDate: DateScanResult = {
    totalWithProperty: 0, ok: 0, dangling: 0, empty: 0, duplicated: 0, danglingPct: 0,
    danglingRecoverable: 0, danglingUnrecoverable: 0, recoverablePct: 0,
    byInterval: [], samples: [], unrecoverableSamples: [],
  };
  const recoverableByBucket = new Map<string, number>();
  let ambiguousBothPowerups = 0;

  const orphanCounts = new Map<string, Map<string, number>>([
    [powerupCode, new Map()],
    [CARD_PRIORITY_CODE, new Map()],
  ]);
  // Daily Document targets repeat across many Rems — resolve each id once.
  const refExistsCache = new Map<string, boolean>();

  // Slot ids a healthy priority property is allowed to reference. Anything else
  // carrying a bare number is a leftover.
  const registeredSlotIds = new Set<string>(
    [incPriorityId, cardPriorityId, nextRepId].filter((id): id is string => !!id)
  );
  // Leftover property Rems, keyed by property Rem id so a Rem carrying both
  // powerups (scanned twice) cannot double-count.
  const leftovers = new Map<string, LeftoverProperty>();

  // Identifying a leftover needs the slot's IDENTITY, not just "is it one of the
  // three ids we resolved". A first cut used that cheaper test and reported 12,793
  // leftovers — almost all of them legitimate properties of OTHER powerups
  // (built-in ones included), betrayed by values like 214 and 238 that cannot be
  // priorities. A property is only ours if the slot Rem it references is a child
  // of one of OUR two powerup definitions, or has vanished entirely.
  const ourPowerupIds = new Set<string>(
    [incPowerup?._id, cardPowerup?._id].filter((id): id is string => !!id)
  );
  type SlotInfo = { exists: boolean; name: string; isSlot: boolean; ours: boolean };
  const slotInfoCache = new Map<string, SlotInfo>();
  const resolveSlotInfo = async (id: string): Promise<SlotInfo> => {
    const hit = slotInfoCache.get(id);
    if (hit) return hit;
    let info: SlotInfo = { exists: false, name: '', isSlot: false, ours: false };
    try {
      const slotRem = await plugin.rem.findOne(id);
      if (slotRem) {
        const parent = await slotRem.getParentRem().catch(() => undefined);
        info = {
          exists: true,
          name: await safeRemTextToString(plugin, slotRem.text),
          isSlot: await slotRem.isPowerupSlot().catch(() => false),
          ours: !!parent && ourPowerupIds.has(parent._id),
        };
      }
    } catch {
      /* treat as non-existent */
    }
    slotInfoCache.set(id, info);
    return info;
  };
  const intervalTally = new Map<string, { ok: number; dangling: number }>();

  /** Classify one Rem's priority property for one powerup. */
  const classifyPriority = async (
    rem: PluginRem,
    children: PluginRem[],
    registeredId: string | null,
    result: PowerupScanResult,
    code: string
  ): Promise<'ok' | 'detached' | 'missing'> => {
    let linked: PluginRem | null = null;
    let detachedChild: PluginRem | null = null;
    let detachedTarget: string | null = null;
    /** How many property Rems on this Rem carry the registered slot (1 = healthy). */
    let linkedCount = 0;
    // Leftovers found on THIS Rem in this pass, so the owner's readability can be
    // stamped onto them once it is known. That flag is what separates litter that
    // is safe to delete from a value that is the only remaining copy.
    const leftoversHere: string[] = [];

    for (const child of children) {
      const refs = refIdsIn(child.text);
      if (!refs.length) continue;
      if (registeredId && refs.includes(registeredId)) {
        // Do NOT break here. A Rem whose priority reads perfectly can still be
        // carrying a leftover property Rem from the migration — the user sees it
        // as a stray "Unnamed — N" row. Breaking on the healthy one made those
        // invisible to this scan, which measured readability and silently
        // reported litter as clean.
        //
        // Nor is a second match here an error: several property Rems can carry
        // the SAME registered slot, which reads as healthy while showing the
        // user repeated rows. Count them so that fault is measurable.
        linkedCount++;
        linked = child;
        continue;
      }
      // References a slot Rem that exists on one of the two definitions but is
      // NOT the registered priority slot — the detached signature.
      const orphanRef = refs.find((id) => allSlotIds.has(id) && id !== nextRepId);
      if (orphanRef && !detachedChild) {
        detachedChild = child;
        detachedTarget = orphanRef;
      }

      // Leftover detection, independent of readability: a Rem whose priority
      // reads fine can still carry an abandoned property from the migration, and
      // a write has been observed to strand the old one on a brand-new unnamed
      // slot Rem (JF0lnO7kCGbDrHRrt), so membership of the known orphan list is
      // not sufficient either.
      //
      // The property must be OURS, which means the slot it references either
      // belongs to one of our two powerup definitions or no longer exists.
      // Without that test this flags every numeric property of every other
      // powerup in the knowledge base.
      if (
        refs.length === 1 &&
        !registeredSlotIds.has(refs[0]) &&
        !leftovers.has(child._id)
      ) {
        const v = (await readRawText(plugin, (child as any).backText)).trim();
        // Priorities are 0–100. A wider pattern lets page numbers and similar
        // three-digit metadata in.
        const looksLikePriority = /^\d{1,3}$/.test(v) && Number(v) <= 100;
        if (looksLikePriority) {
          const info = await resolveSlotInfo(refs[0]);
          // Record every candidate, but CLASSIFY it. Silently dropping the
          // foreign ones would hide the case that matters most: a leftover whose
          // slot Rem sits outside both powerup definitions.
          const category: LeftoverProperty['category'] =
            !info.exists ? 'deleted-slot' : info.ours ? 'ours' : 'foreign';
          leftovers.set(child._id, {
            propertyRemId: child._id,
            ownerRemId: rem._id,
            value: v,
            slotId: refs[0],
            slotName: !info.exists ? '(slot Rem deleted)' : info.name || '(unnamed)',
            category,
            ownerPriorityReadable: false,
            ownerSource: null,
          });
          if (category !== 'foreign') leftoversHere.push(child._id);
        }
      }
    }

    if (linkedCount > 1) {
      result.duplicated++;
      if (result.samples.length < SAMPLE_CAP) {
        result.samples.push({
          remId: rem._id,
          text: (await safeRemTextToString(plugin, rem.text)).slice(0, 120),
          storedValue: `${linkedCount} property Rems on the same slot`,
          pointsAt: registeredId,
          pointsAtName: '(duplicated — plugin reads one of them)',
        });
      }
    }

    if (linked) {
      const value = await readRawText(plugin, (linked as any).backText);
      if (value.trim() !== '') {
        // Mark this Rem's leftovers as safe to remove: the value survives on a
        // properly linked property. A Rem carrying both powerups is scanned
        // twice, and one readable powerup is enough — hence set, never unset.
        for (const id of leftoversHere) {
          const l = leftovers.get(id);
          if (l) l.ownerPriorityReadable = true;
        }
        result.ok++;
        return 'ok';
      }
      // Linked but empty — nothing stored, not a detachment.
      result.missing++;
      return 'missing';
    }

    if (detachedChild && detachedTarget) {
      const value = await readRawText(plugin, (detachedChild as any).backText);
      // Only count it as a stranded priority if it actually holds a number;
      // otherwise it is some other slot's property and says nothing about this one.
      if (/^\s*\d{1,3}\s*$/.test(value)) {
        result.detached++;
        const tally = orphanCounts.get(code)!;
        tally.set(detachedTarget, (tally.get(detachedTarget) || 0) + 1);
        if (result.samples.length < SAMPLE_CAP) {
          result.samples.push({
            remId: rem._id,
            text: (await safeRemTextToString(plugin, rem.text)).slice(0, 120),
            storedValue: value.trim(),
            pointsAt: detachedTarget,
            pointsAtName: slotNameById.get(detachedTarget) || '(unnamed)',
          });
        }
        return 'detached';
      }
    }

    result.missing++;
    return 'missing';
  };

  // ── Pass 1: Incremental ───────────────────────────────────────────────────
  incremental.total = incRems.length;
  for (let i = 0; i < incRems.length; i += BATCH_SIZE) {
    const batch = incRems.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (rem) => {
        const children = ((await rem.getChildrenRem().catch(() => [])) || []) as PluginRem[];
        const verdict = await classifyPriority(rem, children, incPriorityId, incremental, powerupCode);
        if (verdict === 'detached' && (await rem.hasPowerup(CARD_PRIORITY_CODE).catch(() => false))) {
          ambiguousBothPowerups++;
        }

        // Next Rep Date — Incremental only.
        const dateChildren = nextRepId
          ? children.filter((c) => refIdsIn(c.text).includes(nextRepId))
          : [];
        const dateChild = dateChildren[0];
        if (!dateChild) return;
        nextRepDate.totalWithProperty++;
        // Same duplicate fault as priority: the date reads fine while the Rem
        // shows repeated "Next Rep Date" rows, one of them stale.
        if (dateChildren.length > 1) nextRepDate.duplicated++;

        const targets = refIdsIn((dateChild as any).backText);
        if (targets.length === 0) {
          nextRepDate.empty++;
          return;
        }

        let exists = false;
        for (const id of targets) {
          let cached = refExistsCache.get(id);
          if (cached === undefined) {
            cached = !!(await plugin.rem.findOne(id).catch(() => undefined));
            refExistsCache.set(id, cached);
          }
          if (cached) exists = true;
        }

        // Interval from the last history entry = how far ahead the reference was
        // written. The correlation this exposes is the point of the whole scan.
        //
        // The same read also answers the question a date repair depends on: is
        // there a `nextRepMs` stamp to rebuild the Daily Document reference from?
        // A dangling date with no stamp cannot be recovered from the Rem at all.
        let intervalDays: number | null = null;
        let recoverableMs: number | null = null;
        if (analyzeIntervals) {
          try {
            const raw = await rem.getPowerupProperty(powerupCode, repHistorySlotCode);
            const hist = raw ? JSON.parse(String(raw)) : null;
            if (Array.isArray(hist)) {
              for (let k = hist.length - 1; k >= 0; k--) {
                if (intervalDays === null && typeof hist[k]?.interval === 'number') {
                  intervalDays = hist[k].interval;
                }
                if (recoverableMs === null && typeof hist[k]?.nextRepMs === 'number') {
                  recoverableMs = hist[k].nextRepMs;
                }
                if (intervalDays !== null && recoverableMs !== null) break;
              }
            }
          } catch {
            /* unreadable history — bucketed as unknown, and unrecoverable */
          }
        }
        const bucket = bucketFor(intervalDays);
        const tally = intervalTally.get(bucket) || { ok: 0, dangling: 0 };
        if (exists) {
          nextRepDate.ok++;
          tally.ok++;
        } else {
          nextRepDate.dangling++;
          tally.dangling++;
          // Can a repair rebuild this date? Only if the Rem's own history still
          // carries the timestamp the reference was supposed to encode.
          if (recoverableMs !== null) {
            nextRepDate.danglingRecoverable++;
            const b = bucketFor(intervalDays);
            recoverableByBucket.set(b, (recoverableByBucket.get(b) || 0) + 1);
          } else {
            nextRepDate.danglingUnrecoverable++;
            if (nextRepDate.unrecoverableSamples.length < SAMPLE_CAP) {
              nextRepDate.unrecoverableSamples.push({
                remId: rem._id,
                text: (await safeRemTextToString(plugin, rem.text)).slice(0, 120),
                storedValue: null,
                pointsAt: targets[0] ?? null,
                pointsAtName: '(missing Daily Document, no nextRepMs in history)',
              });
            }
          }
          if (nextRepDate.samples.length < SAMPLE_CAP) {
            nextRepDate.samples.push({
              remId: rem._id,
              text: (await safeRemTextToString(plugin, rem.text)).slice(0, 120),
              storedValue: intervalDays != null ? `interval ${intervalDays}d` : null,
              pointsAt: targets[0] ?? null,
              pointsAtName: '(missing Daily Document)',
            });
          }
        }
        intervalTally.set(bucket, tally);
      })
    );
    onProgress?.(Math.min(i + BATCH_SIZE, incRems.length), incRems.length, 'Incremental');
  }

  // ── Pass 2: CardPriority ──────────────────────────────────────────────────
  cardPriority.total = cardRems.length;
  for (let i = 0; i < cardRems.length; i += BATCH_SIZE) {
    const batch = cardRems.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (rem) => {
        const children = ((await rem.getChildrenRem().catch(() => [])) || []) as PluginRem[];
        const verdict = await classifyPriority(rem, children, cardPriorityId, cardPriority, CARD_PRIORITY_CODE);
        if (verdict === 'detached' && incIds.has(rem._id)) ambiguousBothPowerups++;
      })
    );
    onProgress?.(Math.min(i + BATCH_SIZE, cardRems.length), cardRems.length, 'CardPriority');
  }

  // ── Stranded leftovers: recover or discard? ───────────────────────────────
  //
  // A stranded leftover holds the only surviving copy of a priority — but that
  // only matters if the value carried information in the first place. The
  // CardPriority `prioritySource` slot is hidden, so it survived the migration
  // intact and can still say which:
  //
  //   manual / incremental — a deliberate value. Nothing else holds it. RECOVER.
  //   inherited / default  — derived from the ancestor cascade, which the plugin
  //                          recomputes on demand. The leftover adds nothing and
  //                          can simply be deleted.
  //
  // Splitting these is what turns "375 stranded values" into a much smaller set
  // that actually needs writing.
  const sourceByOwner = new Map<string, PrioritySource | null>();
  for (const l of leftovers.values()) {
    if (l.category === 'foreign' || l.ownerPriorityReadable) continue;
    let source = sourceByOwner.get(l.ownerRemId);
    if (source === undefined) {
      source = null;
      try {
        const owner = await plugin.rem.findOne(l.ownerRemId);
        const raw = owner
          ? await owner.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT).catch(() => null)
          : null;
        if (raw === 'manual' || raw === 'inherited' || raw === 'default' || raw === 'incremental') {
          source = raw;
        }
      } catch {
        /* leave null — reported as unknown, and treated as needing recovery */
      }
      sourceByOwner.set(l.ownerRemId, source);
    }
    l.ownerSource = source;
  }

  const strandedList = Array.from(leftovers.values()).filter(
    (l) => l.category !== 'foreign' && !l.ownerPriorityReadable
  );
  const isDerivable = (s: PrioritySource | null) => s === 'inherited' || s === 'default';
  // Unknown source counts as needing recovery: the conservative direction, since
  // the cost of a redundant write is nothing and the cost of a wrong delete is a
  // lost priority.
  const strandedNeedsRecovery = strandedList.filter((l) => !isDerivable(l.ownerSource));
  const strandedDiscardable = strandedList.filter((l) => isDerivable(l.ownerSource));

  const strandedBySource = Array.from(
    strandedList.reduce((m, l) => {
      const key = l.ownerSource ?? '(unreadable)';
      m.set(key, (m.get(key) || 0) + 1);
      return m;
    }, new Map<string, number>())
  )
    .map(([source, count]) => ({
      source,
      count,
      action: isDerivable(source as PrioritySource) ? ('discardable' as const) : ('recover' as const),
    }))
    .sort((a, b) => b.count - a.count);

  // ── Finalise ──────────────────────────────────────────────────────────────
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  incremental.detachedPct = pct(incremental.detached, incremental.total);
  cardPriority.detachedPct = pct(cardPriority.detached, cardPriority.total);
  nextRepDate.danglingPct = pct(nextRepDate.dangling, nextRepDate.totalWithProperty);

  for (const [code, result] of [[powerupCode, incremental], [CARD_PRIORITY_CODE, cardPriority]] as const) {
    result.orphanTargets = Array.from(orphanCounts.get(code)!.entries())
      .map(([slotDefId, count]) => ({ slotDefId, name: slotNameById.get(slotDefId) || '(unnamed)', count }))
      .sort((a, b) => b.count - a.count);
  }

  nextRepDate.recoverablePct = pct(nextRepDate.danglingRecoverable, nextRepDate.dangling);
  nextRepDate.byInterval = INTERVAL_BUCKETS.map((b) => b.bucket)
    .filter((bucket, idx, arr) => arr.indexOf(bucket) === idx)
    .map((bucket) => ({
      bucket,
      ...(intervalTally.get(bucket) || { ok: 0, dangling: 0 }),
      recoverable: recoverableByBucket.get(bucket) || 0,
    }))
    .filter((row) => row.ok > 0 || row.dangling > 0);

  if (ambiguousBothPowerups > 0) {
    notes.push(
      `${ambiguousBothPowerups} Rem(s) carry both powerups and had a detached property. ` +
      'A detached property no longer records which powerup it belonged to, so those are ' +
      'attributed best-effort and may be counted under either.'
    );
  }

  const report: SlotScanReport = {
    exportedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    incremental,
    cardPriority,
    nextRepDate,
    ambiguousBothPowerups,
    orphanSlotsOnDefinitions,
    // Only `ours` and `deleted-slot` are litter. `foreign` rows are other
    // powerups' legitimate properties and are reported for transparency only.
    leftoverCount: Array.from(leftovers.values()).filter((l) => l.category !== 'foreign').length,
    leftoverSlots: Array.from(
      Array.from(leftovers.values()).reduce((m, l) => {
        const cur =
          m.get(l.slotId) || { slotId: l.slotId, name: l.slotName, count: 0, category: l.category };
        cur.count++;
        m.set(l.slotId, cur);
        return m;
      }, new Map<string, { slotId: string; name: string; count: number; category: LeftoverProperty['category'] }>())
        .values()
    ).sort((a, b) => b.count - a.count),
    leftoverSamples: Array.from(leftovers.values())
      .filter((l) => l.category !== 'foreign')
      .slice(0, SAMPLE_CAP),
    leftoverSafeToDelete: Array.from(leftovers.values()).filter(
      (l) => l.category !== 'foreign' && l.ownerPriorityReadable
    ).length,
    leftoverStranded: strandedList.length,
    strandedNeedsRecovery: strandedNeedsRecovery.length,
    strandedDiscardable: strandedDiscardable.length,
    strandedBySource,
    // Sample the ones that actually need writing, not the discardable majority.
    strandedSamples: strandedNeedsRecovery.slice(0, SAMPLE_CAP),
    strandedAll: strandedList,
    safeToDeleteAll: Array.from(leftovers.values()).filter(
      (l) => l.category !== 'foreign' && l.ownerPriorityReadable
    ),
    notes,
  };

  logSlotScan(report);
  return report;
}

/** Console summary, shaped for pasting into the support ticket. */
export function logSlotScan(report: SlotScanReport): void {
  console.log('\n========== KB-WIDE SLOT DAMAGE SCAN ==========');
  console.log(`Took ${(report.durationMs / 1000).toFixed(1)}s\n`);

  console.log('--- Priority slot health ---');
  console.table(
    [report.incremental, report.cardPriority].map((r) => ({
      powerup: r.label,
      total: r.total,
      OK: r.ok,
      DETACHED: r.detached,
      'no value': r.missing,
      DUPLICATED: r.duplicated,
      'detached %': `${r.detachedPct}%`,
      registeredSlot: r.registeredSlotId ?? '(unresolved)',
    }))
  );

  for (const r of [report.incremental, report.cardPriority]) {
    if (r.orphanTargets.length) {
      console.log(`\n${r.label} — orphan slots the detached properties point at:`);
      console.table(r.orphanTargets);
    }
  }

  console.log('\n--- Next Rep Date (Daily Document references) ---');
  console.table([{
    'with property': report.nextRepDate.totalWithProperty,
    OK: report.nextRepDate.ok,
    DANGLING: report.nextRepDate.dangling,
    'no reference': report.nextRepDate.empty,
    DUPLICATED: report.nextRepDate.duplicated,
    'dangling %': `${report.nextRepDate.danglingPct}%`,
    'recoverable from history': report.nextRepDate.danglingRecoverable,
    'UNRECOVERABLE': report.nextRepDate.danglingUnrecoverable,
    'recoverable %': `${report.nextRepDate.recoverablePct}%`,
  }]);
  if (report.nextRepDate.danglingUnrecoverable > 0) {
    console.log('\nDangling dates with NO nextRepMs in history — a repair cannot rebuild these:');
    console.table(report.nextRepDate.unrecoverableSamples);
  }

  if (report.nextRepDate.byInterval.length) {
    console.log('\nBy scheduling interval — does failure track how far ahead the reference was written?');
    console.table(report.nextRepDate.byInterval);
    console.log('If dangling is concentrated in the longer buckets, future-dated daily');
    console.log('documents did not survive the migration.');
  }

  if (report.orphanSlotsOnDefinitions.length) {
    console.log('\n--- Orphan slot Rems on the powerup definitions ---');
    console.table(report.orphanSlotsOnDefinitions);
  }

  console.log(`\n--- Leftover priority properties: ${report.leftoverCount} ---`);
  console.log('(rows below marked "foreign" are other powerups\' legitimate properties');
  console.log(' and are NOT included in that count — shown so the filter is auditable)');
  if (report.leftoverSlots.length > 0) {
    console.log('These sit on Rems whose priority reads CORRECTLY, so they do not appear');
    console.log('in the detached counts above. The user sees each one as a stray');
    console.log('"Unnamed — N" row. This is what a cleanup pass would remove.');
    console.table(report.leftoverSlots);
    console.log(
      `  safe to delete (owner reads fine): ${report.leftoverSafeToDelete}` +
      `   |   STRANDED (only surviving copy): ${report.leftoverStranded}`
    );
    if (report.leftoverStranded > 0) {
      console.log(
        `  Of the ${report.leftoverStranded} stranded: ` +
        `${report.strandedNeedsRecovery} need RECOVERY (manual/incremental), ` +
        `${report.strandedDiscardable} are derivable and can simply be deleted.`
      );
      console.table(report.strandedBySource);
      console.log('  Sample of the ones that must be written back:');
      console.table(report.strandedSamples);
    }
    console.table(report.leftoverSamples);
  }

  for (const n of report.notes) console.log(`NOTE: ${n}`);
  console.log('==============================================\n');
}
