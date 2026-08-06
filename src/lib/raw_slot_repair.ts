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
import { setCardPriority } from './card_priority';
import { getPowerupSlotByCodeSafe } from './powerup_slot_compat';
import { safeRemTextToString } from './pdfUtils';
import { refIdsIn, readRawText } from './raw_slot_dump';
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
  samples: RepairCandidate[];
  notes: string[];
}

const BATCH_SIZE = 50;
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

  const registeredSlot = await getPowerupSlotByCodeSafe(plugin, CARD_PRIORITY_CODE, PRIORITY_SLOT);
  const registeredId = registeredSlot?._id ?? null;
  if (!registeredId) {
    throw new Error(
      'Could not resolve the registered CardPriority priority slot — refusing to run. ' +
      'Without it, a healthy property is indistinguishable from a detached one.'
    );
  }

  // Every slot Rem on the CardPriority definition, so a detached property can be
  // recognised by referencing one of them that is NOT the registered slot.
  const powerup = await plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE);
  const slotChildren = ((await powerup?.getChildrenRem().catch(() => [])) || []) as PluginRem[];
  const knownSlotIds = new Set<string>();
  for (const c of slotChildren) {
    if (await c.isPowerupSlot().catch(() => false)) knownSlotIds.add(c._id);
  }

  const rems = ((await powerup?.taggedRem().catch(() => [])) || []) as PluginRem[];

  // setCardPriority refuses 'inherited'/'default' writes while flashcard
  // prioritisation is off (mayWriteCardPrioritySource). Without this check the
  // write would silently no-op, the verification below would fail, and after five
  // of those the run would abort claiming the repair mechanism is broken — when
  // in fact it is a setting. Fail loudly and early instead.
  if (includeDerivable && !(await getIESetting(plugin, enableFlashcardPrioritisationId))) {
    throw new Error(
      "includeDerivable was requested but flashcard prioritisation is OFF, so " +
      "'inherited'/'default' writes are refused by design. Enable the setting, or " +
      'run without includeDerivable (the default) to repair only manual/incremental values.'
    );
  }

  const report: RepairReport = {
    exportedAt: new Date().toISOString(),
    dryRun,
    durationMs: 0,
    scanned: rems.length,
    candidates: 0,
    skippedDerivable: 0,
    repaired: 0,
    failedVerification: 0,
    errors: [],
    orphanPropertyRemIds: [],
    samples: [],
    notes,
  };

  let stopped = false;

  for (let i = 0; i < rems.length && !stopped; i += BATCH_SIZE) {
    const batch = rems.slice(i, i + BATCH_SIZE);

    // Sequential within a batch: each repair is a multi-property write plus a
    // band sync, and firing 50 of those concurrently saturates the IPC bridge.
    for (const rem of batch) {
      if (limit !== undefined && report.repaired >= limit) {
        stopped = true;
        notes.push(`Stopped after reaching the limit of ${limit} repair(s).`);
        break;
      }

      try {
        const children = ((await rem.getChildrenRem().catch(() => [])) || []) as PluginRem[];

        let linked = false;
        let orphan: PluginRem | null = null;
        let orphanSlotId: string | null = null;
        for (const child of children) {
          const refs = refIdsIn(child.text);
          if (!refs.length) continue;
          if (refs.includes(registeredId)) {
            linked = true;
            break;
          }
          const hit = refs.find((id) => knownSlotIds.has(id));
          if (hit && !orphan) {
            orphan = child;
            orphanSlotId = hit;
          }
        }
        // A healthy property wins outright — never touch a Rem that already reads.
        if (linked || !orphan || !orphanSlotId) continue;

        const raw = (await readRawText(plugin, (orphan as any).backText)).trim();
        if (!/^\d{1,3}$/.test(raw)) continue;
        const storedValue = Math.min(100, Math.max(0, parseInt(raw, 10)));

        // prioritySource / lastUpdated are hidden slots — they survived the
        // migration, so the original provenance can be restored rather than
        // every repaired card being stamped as a fresh manual edit.
        let source: PrioritySource = 'manual';
        let lastUpdated: number | null = null;
        try {
          const s = await rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT);
          if (s === 'manual' || s === 'inherited' || s === 'default' || s === 'incremental') {
            source = s;
          }
          const lu = await rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT);
          const parsed = lu ? parseInt(String(lu), 10) : NaN;
          if (!isNaN(parsed)) lastUpdated = parsed;
        } catch {
          /* fall back to 'manual', the conservative choice: it is never suppressed
             by mayWriteCardPrioritySource and never silently dropped. */
        }

        if (!includeDerivable && (source === 'inherited' || source === 'default')) {
          report.skippedDerivable++;
          continue;
        }

        report.candidates++;

        // What the app is using right now, for the record. ONLY for the handful
        // of rows that get sampled: getCardPriority walks the ancestor chain, and
        // firing that for thousands of candidates saturates the IPC bridge for no
        // benefit — the repair itself does not depend on this value.
        let currentValue: number | null = null;
        if (report.samples.length < SAMPLE_CAP) {
          try {
            const { getCardPriority } = await import('./card_priority');
            const info = await getCardPriority(plugin, rem);
            currentValue = info?.priority ?? null;
          } catch {
            /* diagnostic only */
          }
        }

        const candidate: RepairCandidate = {
          remId: rem._id,
          text: (await safeRemTextToString(plugin, rem.text)).slice(0, 120),
          storedValue,
          currentValue,
          source,
          lastUpdated,
          orphanPropertyRemId: orphan._id,
          orphanSlotId,
        };
        if (report.samples.length < SAMPLE_CAP) report.samples.push(candidate);
        report.orphanPropertyRemIds.push(orphan._id);

        if (dryRun) continue;

        await setCardPriority(plugin, rem, storedValue, source, true);

        // Restore the original timestamp: setCardPriority stamps Date.now(), but
        // this is a repair, not an edit, and lastUpdated is how inheritance and
        // the analytics decide precedence.
        if (lastUpdated !== null) {
          try {
            await rem.setPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT, [String(lastUpdated)]);
          } catch { /* non-fatal — the priority itself is what matters */ }
        }

        // Verify through the API that was broken. A write that does not read back
        // means the repair does not work on this build and we must stop.
        const check = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null);
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
        report.errors.push({ remId: rem._id, error: String(e?.message ?? e) });
      }
    }

    onProgress?.(Math.min(i + BATCH_SIZE, rems.length), rems.length);
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
  limit = 3
): Promise<DeletionProbe[]> {
  const probes: DeletionProbe[] = [];

  for (const id of orphanPropertyRemIds.slice(0, limit)) {
    const probe: DeletionProbe = {
      orphanPropertyRemId: id,
      ownerRemId: null,
      ownerText: null,
      storedValue: null,
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
      probe.apiValueBefore =
        (await owner.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null)) ?? null;

      // Refuse if the good value is not in place — deleting would then be the only
      // copy going away.
      if (probe.apiValueBefore == null || String(probe.apiValueBefore).trim() === '') {
        probe.verdict =
          'REFUSED: the owner has no readable CardPriority value, so this orphan may hold ' +
          'the only copy. Repair the Rem first, then delete.';
        probes.push(probe);
        continue;
      }

      await orphan.remove();
      probe.deleted = true;

      probe.ownerChildCountAfter = ((await owner.getChildrenRem().catch(() => [])) || []).length;
      probe.apiValueAfter =
        (await owner.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null)) ?? null;

      if (probe.apiValueAfter != null && probe.apiValueAfter === probe.apiValueBefore) {
        probe.verdict = 'OK — orphan removed, the repaired priority still reads correctly.';
      } else {
        probe.verdict =
          `DANGER: the API value changed from ${probe.apiValueBefore} to ${probe.apiValueAfter}. ` +
          'Deleting the orphan disturbed the good property. DO NOT run a bulk cleanup. ' +
          `Restore by setting this Rem's priority back to ${probe.storedValue}.`;
      }
    } catch (e: any) {
      probe.error = String(e?.message ?? e);
      probe.verdict = `Threw: ${probe.error}`;
    }

    probes.push(probe);
  }

  console.log('\n========== ORPHAN DELETION TEST ==========');
  console.table(
    probes.map((p) => ({
      orphan: p.orphanPropertyRemId,
      owner: p.ownerRemId ?? '(none)',
      held: p.storedValue ?? '',
      'children before': p.ownerChildCountBefore ?? '',
      'children after': p.ownerChildCountAfter ?? '',
      'API before': p.apiValueBefore ?? '(empty)',
      'API after': p.apiValueAfter ?? '(empty)',
      deleted: p.deleted,
    }))
  );
  for (const p of probes) console.log(`${p.orphanPropertyRemId}: ${p.verdict}`);
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
