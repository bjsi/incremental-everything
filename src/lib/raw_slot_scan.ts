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
import { CARD_PRIORITY_CODE, PRIORITY_SLOT } from './card_priority/types';
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
  danglingPct: number;
  /**
   * Dangling-vs-healthy split by the scheduling interval recorded in the Rem's
   * last history entry — i.e. how far ahead the Daily Document reference was
   * written. If short intervals survive and long ones do not, future-dated daily
   * documents were pruned.
   */
  byInterval: Array<{ bucket: string; ok: number; dangling: number }>;
  samples: ScanSample[];
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
    total: 0, ok: 0, detached: 0, missing: 0, detachedPct: 0,
    orphanTargets: [], samples: [],
  });
  const incremental = mkResult('Incremental', powerupCode, incPriorityId);
  const cardPriority = mkResult('CardPriority', CARD_PRIORITY_CODE, cardPriorityId);
  const nextRepDate: DateScanResult = {
    totalWithProperty: 0, ok: 0, dangling: 0, empty: 0, danglingPct: 0,
    byInterval: [], samples: [],
  };
  let ambiguousBothPowerups = 0;

  const orphanCounts = new Map<string, Map<string, number>>([
    [powerupCode, new Map()],
    [CARD_PRIORITY_CODE, new Map()],
  ]);
  // Daily Document targets repeat across many Rems — resolve each id once.
  const refExistsCache = new Map<string, boolean>();
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

    for (const child of children) {
      const refs = refIdsIn(child.text);
      if (!refs.length) continue;
      if (registeredId && refs.includes(registeredId)) {
        linked = child;
        break;
      }
      // References a slot Rem that exists on one of the two definitions but is
      // NOT the registered priority slot — the detached signature.
      const orphanRef = refs.find((id) => allSlotIds.has(id) && id !== nextRepId);
      if (orphanRef && !detachedChild) {
        detachedChild = child;
        detachedTarget = orphanRef;
      }
    }

    if (linked) {
      const value = await readRawText(plugin, (linked as any).backText);
      if (value.trim() !== '') {
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
        const dateChild = children.find((c) => nextRepId && refIdsIn(c.text).includes(nextRepId));
        if (!dateChild) return;
        nextRepDate.totalWithProperty++;

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
        let intervalDays: number | null = null;
        if (analyzeIntervals) {
          try {
            const raw = await rem.getPowerupProperty(powerupCode, repHistorySlotCode);
            const hist = raw ? JSON.parse(String(raw)) : null;
            if (Array.isArray(hist)) {
              for (let k = hist.length - 1; k >= 0; k--) {
                if (typeof hist[k]?.interval === 'number') {
                  intervalDays = hist[k].interval;
                  break;
                }
              }
            }
          } catch {
            /* unreadable history — bucketed as unknown */
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

  nextRepDate.byInterval = INTERVAL_BUCKETS.map((b) => b.bucket)
    .filter((bucket, idx, arr) => arr.indexOf(bucket) === idx)
    .map((bucket) => ({ bucket, ...(intervalTally.get(bucket) || { ok: 0, dangling: 0 }) }))
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
    'dangling %': `${report.nextRepDate.danglingPct}%`,
  }]);

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

  for (const n of report.notes) console.log(`NOTE: ${n}`);
  console.log('==============================================\n');
}
