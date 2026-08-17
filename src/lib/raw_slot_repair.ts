// Repair pass for CardPriority properties detached by the storage/sync overhaul.
//
// WHY CARDPRIORITY FIRST
// ----------------------
// The KB scan (lib/raw_slot_scan.ts) found the detachment in both priority
// powerups, but they are not equally urgent:
//
//   Incremental — ~100% detached, yet MITIGATED. getIncrementalRemFromRem
//     recovers the value from the Rem's own repetition history, so the plugin
//     shows the right number today.
//
//   CardPriority — ~6.7% detached and NOT mitigated. getCardPriority has no
//     history to fall back on; it silently resolves an inherited value or the
//     default. Those priorities are simply wrong in the app right now, even
//     though the correct value is still sitting on the Rem.
//
// So this repairs CardPriority. The mechanism is the one proven by hand in the
// support report: writing through the normal path creates a new, correctly
// referenced property Rem. The stale one is left behind — deliberately. Deleting
// it is a separate, staged step (see `testDeleteOrphanProperties`), because at
// this scale an unverified bulk delete is the one action here that could destroy
// something.
//
// WHAT IT PRESERVES
// -----------------
// `prioritySource` and `lastUpdated` are HIDDEN slots, so they migrated cleanly
// and are still readable. The repair therefore restores the value under its
// ORIGINAL source and re-stamps the ORIGINAL timestamp, rather than rewriting
// every card as a fresh manual edit. A repair must not look like a user action.
//
// Dry-run by default.

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { CARD_PRIORITY_CODE, PRIORITY_SLOT, SOURCE_SLOT, LAST_UPDATED_SLOT, PrioritySource } from './card_priority/types';
import { setCardPriority, getCardPriority } from './card_priority';
import { getRawCardPriorityString } from './card_priority/slot_access';
import { safeRemTextToString } from './pdfUtils';
import { readRawText } from './raw_slot_dump';
import { scanKbForDetachedSlots, LeftoverProperty } from './raw_slot_scan';
import { getIESetting } from './settings';
import { enableFlashcardPrioritisationId } from './consts';

export interface RepairCandidate {
  remId: string;
  text: string;
  /** The value stranded on the detached property. */
  storedValue: number;
  /** What getCardPriority currently resolves to instead — the wrong value in use. */
  currentValue: number | null;
  source: PrioritySource;
  lastUpdated: number | null;
  /** The mis-pointed property Rem. Left in place; input to the deletion stage. */
  orphanPropertyRemId: string;
  orphanSlotId: string;
}

export interface RepairReport {
  exportedAt: string;
  dryRun: boolean;
  durationMs: number;
  scanned: number;
  /** Detached properties found holding a usable value. */
  candidates: number;
  /** Skipped because their source is derivable and will be recomputed anyway. */
  skippedDerivable: number;
  /** Written successfully and verified readable afterwards. */
  repaired: number;
  /** Written but the value still does not read back — investigate before continuing. */
  failedVerification: number;
  errors: Array<{ remId: string; error: string }>;
  /**
   * Every orphan property Rem left behind, in repair order. This is the input to
   * `testDeleteOrphanProperties` — keep it; it is the only record of what to clean.
   */
  orphanPropertyRemIds: string[];
  /**
   * Orphan property Rems belonging to the SKIPPED derivable Rems. Also litter,
   * but their values are reconstructible, which makes them the safe population to
   * try the first deletions on — unlike the recovered manual values above.
   */
  derivableOrphanPropertyRemIds: string[];
  samples: RepairCandidate[];
  notes: string[];
}

const SAMPLE_CAP = 25;

export interface RepairOptions {
  /** Default true — reports what it WOULD do and writes nothing. */
  dryRun?: boolean;
  /**
   * Repair 'inherited'/'default' values too. Off by default: those are derived,
   * the plugin recomputes them from the ancestor cascade, and writing them
   * re-materialises tags that `mayWriteCardPrioritySource` deliberately
   * suppresses when flashcard prioritisation is disabled. Only 'manual' and
   * 'incremental' carry information that cannot be reconstructed.
   */
  includeDerivable?: boolean;
  /** Stop after this many repairs. Use a small number for the first live run. */
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Finds CardPriority Rems whose priority property is detached, and restores the
 * stranded value through the canonical write path.
 */
export async function repairDetachedCardPriorities(
  plugin: RNPlugin,
  options: RepairOptions = {}
): Promise<RepairReport> {
  const { dryRun = true, includeDerivable = false, limit, onProgress } = options;
  const started = Date.now();
  const notes: string[] = [];

  // ── Work list ─────────────────────────────────────────────────────────────
  //
  // The candidates come from the KB scan, NOT from a second walk of the Rem tree.
  //
  // This function used to re-derive "is this a stranded priority" itself, and its
  // answer disagreed with the scan three times running (324 vs 375). Each round
  // produced a plausible-looking cause — an early `break`, an empty linked
  // property, an incomplete `taggedRem()` index — and each fix left the numbers
  // unchanged, because the real problem was having two implementations of one
  // predicate at all. The scan is the authority; this consumes its output.
  //
  // Cost: the scan runs first (~25s, read-only). Worth it for a one-shot repair.
  const scan = await scanKbForDetachedSlots(plugin, (done: number, total: number) =>
    onProgress?.(done, total)
  );

  const isDerivable = (s: PrioritySource | null) => s === 'inherited' || s === 'default';
  const work = scan.strandedAll.filter(
    (l: LeftoverProperty) => includeDerivable || !isDerivable(l.ownerSource)
  );
  const skippedDerivable = scan.strandedAll.length - work.length;

  // The derivable ones are skipped for repair, but their orphan property Rems are
  // still litter — and they are the RIGHT first target for the deletion test.
  // Their values are reconstructible from the ancestor cascade, so a delete that
  // goes wrong costs nothing, whereas the repaired manual values are the most
  // expensive thing in the set to lose.
  const derivableOrphanPropertyRemIds = scan.strandedAll
    .filter((l: LeftoverProperty) => isDerivable(l.ownerSource))
    .map((l: LeftoverProperty) => l.propertyRemId);

  const report: RepairReport = {
    exportedAt: new Date().toISOString(),
    dryRun,
    durationMs: 0,
    scanned: scan.strandedAll.length,
    candidates: 0,
    skippedDerivable,
    repaired: 0,
    failedVerification: 0,
    errors: [],
    orphanPropertyRemIds: [],
    derivableOrphanPropertyRemIds,
    samples: [],
    notes,
  };
  notes.push(
    `Work list taken from the KB scan: ${scan.leftoverStranded} stranded, ` +
    `${scan.strandedNeedsRecovery} needing recovery, ${scan.strandedDiscardable} derivable.`
  );

  let stopped = false;

  for (let i = 0; i < work.length && !stopped; i++) {
    if (limit !== undefined && report.repaired >= limit) {
      stopped = true;
      notes.push(`Stopped after reaching the limit of ${limit} repair(s).`);
      break;
    }

    const item = work[i];
    try {
      const rem = await plugin.rem.findOne(item.ownerRemId);
      if (!rem) {
        report.errors.push({ remId: item.ownerRemId, error: 'Rem not found' });
        continue;
      }

      // The scan already read the value off the orphan property; re-validate the
      // range rather than trusting it, since this is the write path.
      const storedValue = parseInt(item.value, 10);
      if (isNaN(storedValue) || storedValue < 0 || storedValue > 100) {
        report.errors.push({ remId: item.ownerRemId, error: `implausible value "${item.value}"` });
        continue;
      }

      // Source and lastUpdated live in hidden slots, which survived the migration,
      // so the original provenance is restored rather than stamping every repaired
      // card as a fresh manual edit.
      const source: PrioritySource = item.ownerSource ?? 'manual';
      let lastUpdated: number | null = null;
      try {
        const lu = await rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT);
        const parsed = lu ? parseInt(String(lu), 10) : NaN;
        if (!isNaN(parsed)) lastUpdated = parsed;
      } catch {
        /* leave null — setCardPriority stamps now */
      }

      report.candidates++;
      report.orphanPropertyRemIds.push(item.propertyRemId);

      if (report.samples.length < SAMPLE_CAP) {
        let currentValue: number | null = null;
        try {
          const { getCardPriority } = await import('./card_priority');
          currentValue = (await getCardPriority(plugin, rem))?.priority ?? null;
        } catch {
          /* diagnostic only */
        }
        report.samples.push({
          remId: item.ownerRemId,
          text: (await safeRemTextToString(plugin, rem.text)).slice(0, 120),
          storedValue,
          currentValue,
          source,
          lastUpdated,
          orphanPropertyRemId: item.propertyRemId,
          orphanSlotId: item.slotId,
        });
      }

      if (dryRun) continue;

      await setCardPriority(plugin, rem, storedValue, source, true);

      // Restore the original timestamp, but only when it is plausibly a
      // millisecond value. Some Rems carry a lastUpdated of `2025` — the year —
      // which parses to Jan 1970 and would make the card look older than the
      // knowledge base. Faithfully restoring a broken value has no upside.
      if (lastUpdated !== null && lastUpdated > 1_000_000_000_000) {
        try {
          await rem.setPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT, [String(lastUpdated)]);
        } catch { /* non-fatal — the priority itself is what matters */ }
      }

      // Verify through the API that was broken. A write that does not read back
      // means the repair does not work on this build and we must stop.
      //
      // Read the EFFECTIVE value, not the visible slot: after the hidden-slot
      // migration setCardPriority writes the hidden slot only, and checking the
      // visible one would report every successful repair as a failed write and
      // abort the run after five of them.
      const check = await getRawCardPriorityString(rem).catch(() => null);
      if (check != null && String(check).trim() === String(storedValue)) {
        report.repaired++;
      } else {
        report.failedVerification++;
        if (report.failedVerification >= 5) {
          stopped = true;
          notes.push(
            'ABORTED: 5 writes did not read back. The repair mechanism is not working ' +
            'on this build — nothing further was attempted.'
          );
          break;
        }
      }
    } catch (e: any) {
      report.errors.push({ remId: item.ownerRemId, error: String(e?.message ?? e) });
    }

    onProgress?.(i + 1, work.length);
  }

  if (dryRun) {
    notes.unshift('DRY RUN — nothing was written.');
  }
  if (!includeDerivable && report.skippedDerivable > 0) {
    notes.push(
      `${report.skippedDerivable} detached propert(ies) had a derivable source ` +
      "('inherited'/'default') and were skipped; the plugin recomputes those from the " +
      'ancestor cascade. Re-run with includeDerivable to restore them anyway.'
    );
  }
  if (report.orphanPropertyRemIds.length > 0) {
    notes.push(
      `${report.orphanPropertyRemIds.length} orphaned property Rem(s) remain on their Rems ` +
      'and will show as a stray "Unnamed — N" row. They are listed in orphanPropertyRemIds; ' +
      'clean them only via the staged deletion test.'
    );
  }

  report.durationMs = Date.now() - started;
  logRepair(report);
  return report;
}

// ── Deletion staging ────────────────────────────────────────────────────────

export interface DeletionProbe {
  orphanPropertyRemId: string;
  ownerRemId: string | null;
  ownerText: string | null;
  /** Value the orphan was holding, captured before deletion so it can be restored by hand. */
  storedValue: string | null;
  /** The owner's CardPriority source, read only when the raw value is empty. */
  ownerSource: string | null;
  /**
   * The priority the app actually resolves for the owner (getCardPriority),
   * either side of the deletion. For a derivable orphan the raw property reads
   * empty both times, so this is the only check with any meaning: it follows the
   * ancestor cascade exactly as the rest of the plugin does.
   */
  resolvedBefore: number | null;
  resolvedAfter: number | null;
  ownerChildCountBefore: number | null;
  ownerChildCountAfter: number | null;
  /** The owner's CardPriority value read through the API, before and after. */
  apiValueBefore: string | null;
  apiValueAfter: string | null;
  deleted: boolean;
  error?: string;
  verdict: string;
}

/**
 * Deletes a SMALL, explicitly capped set of orphaned property Rems and records
 * the owning Rem's state either side of each deletion.
 *
 * This exists so the bulk cleanup is never the first time a deletion is tried.
 * The question it answers is narrow: does removing the mis-pointed property Rem
 * leave the repaired priority intact, or does RemNote treat the two properties as
 * one and take the good value with it?
 *
 * Run it only on Rems already repaired — the value must exist in its new, correct
 * property before the old one is removed, or the deletion is destructive.
 */
export async function testDeleteOrphanProperties(
  plugin: RNPlugin,
  orphanPropertyRemIds: string[],
  limit = 3,
  onProgress?: (done: number, total: number) => void
): Promise<DeletionProbe[]> {
  const probes: DeletionProbe[] = [];
  const targets = orphanPropertyRemIds.slice(0, limit);
  let processed = 0;

  for (const id of targets) {
    // Abort the whole run the moment one deletion disturbs a value. At bulk
    // scale, continuing past the first DANGER would turn a single recoverable
    // mistake into hundreds.
    if (probes.some((p) => p.verdict.startsWith('DANGER'))) {
      probes.push({
        orphanPropertyRemId: id,
        ownerRemId: null, ownerText: null, storedValue: null, ownerSource: null,
        resolvedBefore: null, resolvedAfter: null,
        ownerChildCountBefore: null, ownerChildCountAfter: null,
        apiValueBefore: null, apiValueAfter: null, deleted: false,
        verdict: 'ABORTED — a previous deletion reported DANGER; nothing further was attempted.',
      });
      break;
    }
    onProgress?.(++processed, targets.length);
    const probe: DeletionProbe = {
      orphanPropertyRemId: id,
      ownerRemId: null,
      ownerText: null,
      storedValue: null,
      ownerSource: null,
      resolvedBefore: null,
      resolvedAfter: null,
      ownerChildCountBefore: null,
      ownerChildCountAfter: null,
      apiValueBefore: null,
      apiValueAfter: null,
      deleted: false,
      verdict: '',
    };

    try {
      const orphan = await plugin.rem.findOne(id);
      if (!orphan) {
        probe.verdict = 'Property Rem not found — already gone?';
        probes.push(probe);
        continue;
      }

      probe.storedValue = await readRawText(plugin, (orphan as any).backText);

      const owner = await orphan.getParentRem().catch(() => undefined);
      if (!owner) {
        probe.verdict = 'No parent Rem — refusing to delete something unattached.';
        probes.push(probe);
        continue;
      }
      probe.ownerRemId = owner._id;
      probe.ownerText = (await safeRemTextToString(plugin, owner.text)).slice(0, 120);
      probe.ownerChildCountBefore = ((await owner.getChildrenRem().catch(() => [])) || []).length;
      // Effective value (hidden slot first, then the pre-migration visible one).
      // Reading the visible slot alone would make this gate refuse every orphan on
      // a migrated knowledge base, where no owner has a visible value any more.
      probe.apiValueBefore = (await getRawCardPriorityString(owner).catch(() => null)) || null;

      // Refuse unless the owner already has a readable priority in its own slot.
      //
      // An earlier version also accepted a derivable source ('inherited'/'default')
      // on the theory that such a value is recomputed on demand and the orphan
      // therefore holds nothing unique. That was WRONG: setCardPriority writes
      // priority, source and lastUpdated together, so an inherited value is
      // MATERIALISED into the Rem's own slot like any other. An empty slot with a
      // surviving source is damage, and the orphan holds the only copy of that
      // materialised value — deleting it forces every later read to walk the
      // ancestor chain instead (see the ancestor-walk cost this plugin already
      // fights) and leaves lastUpdated reporting 0.
      //
      // So the rule is simply: repair first, then delete. No exceptions by source.
      const src = await owner.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT).catch(() => null);
      probe.ownerSource = (src as string) ?? null;
      const hasReadableValue =
        probe.apiValueBefore != null && String(probe.apiValueBefore).trim() !== '';
      if (!hasReadableValue) {
        probe.verdict =
          `REFUSED: the owner's priority slot is empty (source "${probe.ownerSource ?? 'unknown'}"), ` +
          'so this orphan holds the only materialised copy. Run the repair with ' +
          'includeDerivable first, then delete.';
        probes.push(probe);
        continue;
      }

      // The effective priority BEFORE — what the app shows the user. For a
      // derivable orphan this comes from the ancestor cascade, not the property.
      probe.resolvedBefore = (await getCardPriority(plugin, owner).catch(() => null))?.priority ?? null;

      await orphan.remove();
      probe.deleted = true;

      probe.ownerChildCountAfter = ((await owner.getChildrenRem().catch(() => [])) || []).length;
      probe.apiValueAfter = (await getRawCardPriorityString(owner).catch(() => null)) || null;
      probe.resolvedAfter = (await getCardPriority(plugin, owner).catch(() => null))?.priority ?? null;

      // The test is "did anything CHANGE", not "is there a value". An earlier
      // version required apiValueAfter to be non-null, which reported every
      // derivable orphan as DANGER with the self-refuting message "changed from
      // null to null" — those read empty either side by definition.
      const rawUnchanged = probe.apiValueBefore === probe.apiValueAfter;
      const resolvedUnchanged = probe.resolvedBefore === probe.resolvedAfter;

      if (rawUnchanged && resolvedUnchanged) {
        probe.verdict =
          `OK — orphan removed (children ${probe.ownerChildCountBefore} → ` +
          `${probe.ownerChildCountAfter}); the priority the app resolves is unchanged ` +
          `(${probe.resolvedBefore ?? 'none'}).`;
      } else if (!rawUnchanged) {
        probe.verdict =
          `DANGER: the stored priority changed from ${probe.apiValueBefore} to ` +
          `${probe.apiValueAfter}. Deleting the orphan disturbed the good property. ` +
          `DO NOT run a bulk cleanup. Restore by setting this Rem's priority to ${probe.storedValue}.`;
      } else {
        probe.verdict =
          `DANGER: the RESOLVED priority changed from ${probe.resolvedBefore} to ` +
          `${probe.resolvedAfter} even though the stored property did not. The orphan was ` +
          `contributing to inheritance. DO NOT run a bulk cleanup.`;
      }
    } catch (e: any) {
      probe.error = String(e?.message ?? e);
      probe.verdict = `Threw: ${probe.error}`;
    }

    probes.push(probe);
  }

  const deleted = probes.filter((p) => p.deleted).length;
  const danger = probes.filter((p) => p.verdict.startsWith('DANGER')).length;
  const refused = probes.filter((p) => p.verdict.startsWith('REFUSED')).length;
  console.log('\n========== ORPHAN DELETION ==========');
  console.log(
    `deleted: ${deleted}   OK: ${deleted - danger}   DANGER: ${danger}   refused: ${refused}` +
    `   (of ${probes.length} attempted)`
  );
  if (danger > 0) console.log('*** STOP — a deletion disturbed a value. Do not continue. ***');
  // Cap the table: a bulk run produces hundreds of identical OK rows, and the
  // summary above is what matters. Anything abnormal is printed in full below.
  console.table(
    probes.slice(0, 20).map((p) => ({
      orphan: p.orphanPropertyRemId,
      owner: p.ownerRemId ?? '(none)',
      held: p.storedValue ?? '',
      'children before': p.ownerChildCountBefore ?? '',
      'children after': p.ownerChildCountAfter ?? '',
      'stored before': p.apiValueBefore ?? '(empty)',
      'stored after': p.apiValueAfter ?? '(empty)',
      'RESOLVED before': p.resolvedBefore ?? '(none)',
      'RESOLVED after': p.resolvedAfter ?? '(none)',
      deleted: p.deleted,
    }))
  );
  for (const p of probes) {
    if (p.verdict.startsWith('OK') && probes.length > 20) continue;
    console.log(`${p.orphanPropertyRemId}: ${p.verdict}`);
  }
  console.log('==========================================\n');

  return probes;
}

function logRepair(report: RepairReport): void {
  console.log('\n========== CARDPRIORITY REPAIR ==========');
  console.log(report.dryRun ? 'DRY RUN — nothing written.' : 'LIVE RUN');
  console.table([{
    scanned: report.scanned,
    candidates: report.candidates,
    'skipped (derivable)': report.skippedDerivable,
    repaired: report.repaired,
    'failed verification': report.failedVerification,
    errors: report.errors.length,
    seconds: (report.durationMs / 1000).toFixed(1),
  }]);
  if (report.samples.length) {
    console.log('\nSample of what is being restored (storedValue is the recovered value,');
    console.log('currentValue is the wrong one the app is using now):');
    console.table(report.samples.map((s) => ({
      rem: s.text.slice(0, 50),
      remId: s.remId,
      restore: s.storedValue,
      'currently': s.currentValue ?? '(none)',
      source: s.source,
      orphan: s.orphanPropertyRemId,
    })));
  }
  if (report.errors.length) console.table(report.errors.slice(0, 20));
  for (const n of report.notes) console.log(`NOTE: ${n}`);
  console.log('=========================================\n');
}
