// lib/updated_at_probe.ts
//
// Two probes that together decide whether the card-priority cache can be
// persisted across sessions instead of rebuilt from scratch on every launch.
//
// THE PROBLEM BEING SOLVED
//
// Phase 1 of loadCardPriorityCache reads three powerup slots for every tagged
// rem — on a 45k-rem library that is ~135,000 IPC round-trips, and measurement
// showed the bridge is a fixed-rate pipe at roughly 1,800-2,000 calls/s no
// matter how the calls are scheduled (a sliding-window rewrite of the batch
// loop moved throughput by ~5%, i.e. nothing). So the only way to make the
// build faster is to make fewer calls, and the biggest available cut is not
// making most of them at all: `storage.setLocal` persists unsynced across
// sessions, and this cache is a derived per-device index that never needs to
// sync. A warm start could then re-read slots ONLY for rems that changed.
//
// THE UNKNOWN
//
// That plan needs a change signal that costs nothing. `RemObject.updatedAt` is
// a plain field already present in the payload `taggedRem()` returns, so
// comparing it against a stored snapshot is free. But does it actually move
// when a powerup SLOT VALUE changes?
//
// There is concrete reason to doubt it for one slot in particular. Per
// lib/powerup_slot_compat.ts, the post-overhaul split is:
//
//   VISIBLE slot values still live in a CHILD rem of the tagged rem.
//   HIDDEN  slot values live on the tagged rem itself.
//
// CardPriority registers `priority` as VISIBLE (PropertyLocation.BELOW) and
// both `prioritySource` and `lastUpdated` as HIDDEN. So writing a priority may
// bump only the property child's `updatedAt`, leaving the parent — the rem
// `taggedRem()` hands us — looking untouched. That would be a silent
// correctness hole: a warm start would serve a stale priority forever.
//
// Working in the other direction: setCardPriority writes all three slots in one
// Promise.all, so every real priority write also writes two HIDDEN slots. If
// hidden writes do bump the parent, the parent's `updatedAt` is reliable for
// every write the PLUGIN makes, even if the visible write alone would not have
// moved it.
//
// THE CASE THAT DECIDES IT
//
// That last escape hatch does not cover a user editing the Priority property by
// hand in the editor. `priority` is a VISIBLE slot, so it renders as an editable
// property row; typing a new number there changes a child rem's text and calls
// nothing in this plugin. No hidden slot is written, so the parent rem's
// `updatedAt` gets no help from prioritySource or lastUpdated. If a lone visible
// write does not move it, a warm start would serve that hand-edited priority
// stale indefinitely — a silent wrong answer, which is worse than a slow build.
//
// So the isolated visible-slot row is not an academic control. It IS the
// manual-edit case, and it is the row the design lives or dies on.
//
// probeUpdatedAtSensitivity() measures each slot in isolation and then the
// combination. snapshotRemTimes() + compareRemTimes() cover the same question
// with a REAL editor edit in between, since setPowerupProperty on the parent is
// only the closest available stand-in for typing into the property row.

import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
  SOURCE_SLOT,
  LAST_UPDATED_SLOT,
} from './card_priority/types';

/** How long to wait before re-reading, when the first read shows no movement. */
const RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SlotWriteProbe {
  /** Human label for the row, e.g. "priority (VISIBLE)". */
  label: string;
  slotCode: string;
  hidden: boolean;
  /** What we wrote. Always different from the value already there — an
   *  unchanged write may be a no-op and would read as a false negative. */
  wrote: string;
  previous: string;
  remUpdatedAtBefore: number;
  remUpdatedAtAfter: number;
  remLocalUpdatedAtBefore: number;
  remLocalUpdatedAtAfter: number;
  /** The reading that matters: did the TAGGED rem's updatedAt move? */
  moved: boolean;
  localMoved: boolean;
  /** True when the first read showed nothing and the retry did. Indicates the
   *  field is eventually-consistent, which a warm start would have to tolerate. */
  neededRetry: boolean;
  /** For visible slots: did the property CHILD rem move instead? null when no
   *  property child resolves (expected for hidden slots post-overhaul). */
  propertyChildId: string | null;
  propertyChildMoved: boolean | null;
  error?: string;
}

export interface UpdatedAtProbeReport {
  remId: RemId;
  ok: boolean;
  /** Set when the probe could not run at all. */
  error?: string;
  probes: SlotWriteProbe[];
  restored: boolean;
  restoreError?: string;
  /** Read back after restoring, so a failed restore is visible rather than silent. */
  restoredValues?: { priority: string; source: string; lastUpdated: string };
  verdict: string;
}

async function readRemTimes(
  plugin: RNPlugin,
  remId: RemId
): Promise<{ updatedAt: number; localUpdatedAt: number } | null> {
  // Re-fetch rather than reusing a held reference: RemObject is a snapshot taken
  // when it was fetched, so a stale handle would report the pre-write time and
  // every probe would read as "did not move".
  const fresh = await plugin.rem.findOne(remId);
  if (!fresh) return null;
  return { updatedAt: fresh.updatedAt, localUpdatedAt: fresh.localUpdatedAt };
}

/**
 * Writes one slot in isolation and reports whether the tagged rem's `updatedAt`
 * moved as a result.
 *
 * Deliberately uses raw setPowerupProperty rather than setCardPriority: the
 * latter writes all three slots AND runs syncPriorityBand, whose band-tag writes
 * would themselves touch the rem and make every row read as "moved".
 */
async function probeOneSlot(
  plugin: RNPlugin,
  remId: RemId,
  slotCode: string,
  hidden: boolean,
  previous: string,
  nextValue: string
): Promise<SlotWriteProbe> {
  const label = `${slotCode} (${hidden ? 'HIDDEN' : 'VISIBLE'})`;
  const probe: SlotWriteProbe = {
    label,
    slotCode,
    hidden,
    wrote: nextValue,
    previous,
    remUpdatedAtBefore: 0,
    remUpdatedAtAfter: 0,
    remLocalUpdatedAtBefore: 0,
    remLocalUpdatedAtAfter: 0,
    moved: false,
    localMoved: false,
    neededRetry: false,
    propertyChildId: null,
    propertyChildMoved: null,
  };

  try {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) {
      probe.error = 'rem not found';
      return probe;
    }

    const before = await readRemTimes(plugin, remId);
    if (!before) {
      probe.error = 'could not read rem times';
      return probe;
    }
    probe.remUpdatedAtBefore = before.updatedAt;
    probe.remLocalUpdatedAtBefore = before.localUpdatedAt;

    // Capture the property child (if this slot materialises one) so a negative
    // result on the parent can be attributed rather than just reported.
    let childBefore: number | null = null;
    try {
      const childRem = await rem.getPowerupPropertyAsRem(CARD_PRIORITY_CODE, slotCode);
      if (childRem) {
        probe.propertyChildId = childRem._id;
        childBefore = childRem.updatedAt;
      }
    } catch {
      // getPowerupPropertyAsRem throws for hidden slots on current builds — that
      // is itself the expected answer, not an error worth surfacing.
    }

    await rem.setPowerupProperty(CARD_PRIORITY_CODE, slotCode, [nextValue]);

    let after = await readRemTimes(plugin, remId);
    if (after && after.updatedAt === before.updatedAt) {
      // Give an eventually-consistent write a chance before calling it a miss.
      await sleep(RETRY_DELAY_MS);
      const retry = await readRemTimes(plugin, remId);
      if (retry && retry.updatedAt !== before.updatedAt) {
        probe.neededRetry = true;
        after = retry;
      } else if (retry) {
        after = retry;
      }
    }

    if (after) {
      probe.remUpdatedAtAfter = after.updatedAt;
      probe.remLocalUpdatedAtAfter = after.localUpdatedAt;
      probe.moved = after.updatedAt !== before.updatedAt;
      probe.localMoved = after.localUpdatedAt !== before.localUpdatedAt;
    }

    if (probe.propertyChildId && childBefore !== null) {
      const childAfter = await plugin.rem.findOne(probe.propertyChildId);
      probe.propertyChildMoved = childAfter ? childAfter.updatedAt !== childBefore : null;
    }
  } catch (err) {
    probe.error = String(err);
  }

  return probe;
}

/**
 * WRITES to the given rem. Every slot is restored in the `finally`, and the
 * restored values are read back so a failed restore is reported rather than
 * silently left behind.
 *
 * GlobalRemChanged is suppressed for the duration via `plugin_operation_active`
 * — without it the probe's own writes trigger the inheritance cascade and
 * autoAssignCardPriority, whose follow-up writes would touch the rem again and
 * make every row read as "moved" regardless of the slot under test.
 */
export async function probeUpdatedAtSensitivity(
  plugin: RNPlugin,
  remId: RemId
): Promise<UpdatedAtProbeReport> {
  const report: UpdatedAtProbeReport = {
    remId,
    ok: false,
    probes: [],
    restored: false,
    verdict: '',
  };

  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    report.error = 'Rem not found.';
    report.verdict = 'Could not run.';
    return report;
  }

  if (!(await rem.hasPowerup(CARD_PRIORITY_CODE))) {
    report.error =
      'This rem does not carry the CardPriority powerup. Open the debug widget on a rem ' +
      'that has a card priority — the probe deliberately does not add the powerup, since ' +
      'adding and removing one is a bigger change to the rem than the probe itself.';
    report.verdict = 'Could not run.';
    return report;
  }

  const [origPriority, origSource, origLastUpdated] = await Promise.all([
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT),
  ]);

  await plugin.storage.setSession('plugin_operation_active', true);

  try {
    // Each written value must DIFFER from what is already stored. An identical
    // write may be discarded as a no-op, which would read as "updatedAt did not
    // move" and produce exactly the wrong conclusion.
    const parsedPriority = parseInt(origPriority);
    const tempPriority = String(!isNaN(parsedPriority) && parsedPriority === 42 ? 43 : 42);
    const tempSource = (origSource || '').trim() === 'manual' ? 'default' : 'manual';
    const tempLastUpdated = String(Date.now());

    report.probes.push(
      await probeOneSlot(plugin, remId, PRIORITY_SLOT, false, origPriority, tempPriority)
    );
    report.probes.push(
      await probeOneSlot(plugin, remId, SOURCE_SLOT, true, origSource, tempSource)
    );
    report.probes.push(
      await probeOneSlot(plugin, remId, LAST_UPDATED_SLOT, true, origLastUpdated, tempLastUpdated)
    );

    // Fourth row: all three at once, mirroring setCardPriority's own body. This
    // is the combination that happens in real use, so it is the row the caching
    // design actually depends on.
    const combined: SlotWriteProbe = {
      label: 'all three at once (as setCardPriority writes them)',
      slotCode: `${PRIORITY_SLOT}+${SOURCE_SLOT}+${LAST_UPDATED_SLOT}`,
      hidden: false,
      wrote: `${tempPriority} / ${tempSource} / ${tempLastUpdated}`,
      previous: `${origPriority} / ${origSource} / ${origLastUpdated}`,
      remUpdatedAtBefore: 0,
      remUpdatedAtAfter: 0,
      remLocalUpdatedAtBefore: 0,
      remLocalUpdatedAtAfter: 0,
      moved: false,
      localMoved: false,
      neededRetry: false,
      propertyChildId: null,
      propertyChildMoved: null,
    };
    try {
      const before = await readRemTimes(plugin, remId);
      if (before) {
        combined.remUpdatedAtBefore = before.updatedAt;
        combined.remLocalUpdatedAtBefore = before.localUpdatedAt;
        const target = await plugin.rem.findOne(remId);
        if (target) {
          const p = String(parseInt(tempPriority) === 42 ? 44 : 45);
          const s = tempSource === 'manual' ? 'inherited' : 'manual';
          const l = String(Date.now() + 1);
          combined.wrote = `${p} / ${s} / ${l}`;
          await Promise.all([
            target.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, [p]),
            target.setPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT, [s]),
            target.setPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT, [l]),
          ]);
        }
        let after = await readRemTimes(plugin, remId);
        if (after && after.updatedAt === before.updatedAt) {
          await sleep(RETRY_DELAY_MS);
          const retry = await readRemTimes(plugin, remId);
          if (retry) {
            combined.neededRetry = retry.updatedAt !== before.updatedAt;
            after = retry;
          }
        }
        if (after) {
          combined.remUpdatedAtAfter = after.updatedAt;
          combined.remLocalUpdatedAtAfter = after.localUpdatedAt;
          combined.moved = after.updatedAt !== before.updatedAt;
          combined.localMoved = after.localUpdatedAt !== before.localUpdatedAt;
        }
      }
    } catch (err) {
      combined.error = String(err);
    }
    report.probes.push(combined);

    report.ok = true;
  } catch (err) {
    report.error = String(err);
  } finally {
    try {
      const target = await plugin.rem.findOne(remId);
      if (target) {
        // An empty array clears the slot, which is the correct restore for a slot
        // that held nothing to begin with.
        await Promise.all([
          target.setPowerupProperty(
            CARD_PRIORITY_CODE,
            PRIORITY_SLOT,
            origPriority ? [origPriority] : []
          ),
          target.setPowerupProperty(
            CARD_PRIORITY_CODE,
            SOURCE_SLOT,
            origSource ? [origSource] : []
          ),
          target.setPowerupProperty(
            CARD_PRIORITY_CODE,
            LAST_UPDATED_SLOT,
            origLastUpdated ? [origLastUpdated] : []
          ),
        ]);
        const [p, s, l] = await Promise.all([
          target.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT),
          target.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT),
          target.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT),
        ]);
        report.restoredValues = { priority: p, source: s, lastUpdated: l };
        report.restored =
          p === origPriority && s === origSource && l === origLastUpdated;
      }
    } catch (err) {
      report.restoreError = String(err);
    }
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  report.verdict = buildVerdict(report);
  return report;
}

function buildVerdict(report: UpdatedAtProbeReport): string {
  if (!report.ok) return 'Probe did not complete.';

  const byCode = new Map(report.probes.map((p) => [p.slotCode, p]));
  const visible = byCode.get(PRIORITY_SLOT);
  const hiddenSource = byCode.get(SOURCE_SLOT);
  const hiddenUpdated = byCode.get(LAST_UPDATED_SLOT);
  const combined = report.probes[report.probes.length - 1];
  const anyHiddenMoved = Boolean(hiddenSource?.moved || hiddenUpdated?.moved);

  // Three outcomes, and the middle one is the trap: a scheme that works for
  // every write the plugin makes and silently fails only on hand edits would
  // look correct in testing and be wrong in production.
  if (visible?.moved) {
    return (
      'FULLY VIABLE: a lone write to the visible priority slot moves rem.updatedAt, so hand ' +
      'edits in the editor are caught too. The signal does not depend on the hidden slots, ' +
      'which also means dropping the lastUpdated write later would not weaken it.'
    );
  }

  if (combined?.moved || anyHiddenMoved) {
    return (
      'PARTIALLY VIABLE — NOT SAFE ON ITS OWN: rem.updatedAt moves when the hidden slots are ' +
      'written, i.e. for every write setCardPriority makes, but a lone visible-slot write does ' +
      'NOT move it. That is exactly what a user hand-editing the Priority property row does, so ' +
      'a warm start keyed only on updatedAt would serve hand-edited priorities stale and silently. ' +
      'Needs a second signal for that case (e.g. recording dirty remIds from the GlobalRemChanged ' +
      'listener as edits happen) before it can be built. ' +
      (visible?.propertyChildMoved
        ? 'The property CHILD rem did move on the visible write — but reading it costs the per-rem round-trip the scheme exists to avoid.'
        : 'The property child did not move either.')
    );
  }

  return (
    'NOT VIABLE: a real priority write left rem.updatedAt unchanged, so a warm start keyed on ' +
    'it would serve stale priorities across the board. ' +
    (visible?.propertyChildMoved
      ? 'The property CHILD rem moved instead — an invalidation key would have to read the child, which costs the round-trip this was meant to avoid.'
      : 'No property child moved either; another change signal is needed.')
  );
}

export interface RemTimesSnapshot {
  remId: RemId;
  updatedAt: number;
  localUpdatedAt: number;
  priority: string;
  source: string;
  lastUpdated: string;
  takenAt: number;
}

/**
 * The hand-edit baseline lives in SESSION STORAGE, not React state.
 *
 * The debug widget is a popup: making the hand edit requires closing it, which
 * unmounts the component and takes any useState with it, so on reopening there
 * was nothing to compare against and the Compare button stayed disabled. Session
 * storage is plugin-wide and survives the popup's teardown, which is exactly the
 * span this test needs to bridge.
 */
export const HAND_EDIT_BASELINE_KEY = 'debug_hand_edit_baseline';

export async function saveHandEditBaseline(
  plugin: RNPlugin,
  snapshot: RemTimesSnapshot | null
): Promise<void> {
  await plugin.storage.setSession(HAND_EDIT_BASELINE_KEY, snapshot);
}

export async function loadHandEditBaseline(
  plugin: RNPlugin
): Promise<RemTimesSnapshot | null> {
  return (await plugin.storage.getSession<RemTimesSnapshot>(HAND_EDIT_BASELINE_KEY)) ?? null;
}

/**
 * Read-only snapshot of the fields a warm-start invalidation would key on.
 *
 * Pairs with compareRemTimes() to test the manual-edit case for real: snapshot,
 * then hand-edit the Priority property row in the editor, then compare. No
 * simulation — setPowerupProperty on the parent is the closest stand-in the
 * probe above can manage, and it may well not behave like typing into the child.
 */
export async function snapshotRemTimes(
  plugin: RNPlugin,
  remId: RemId
): Promise<RemTimesSnapshot | null> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;
  const [priority, source, lastUpdated] = await Promise.all([
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT),
  ]);
  return {
    remId,
    updatedAt: rem.updatedAt,
    localUpdatedAt: rem.localUpdatedAt,
    priority,
    source,
    lastUpdated,
    takenAt: Date.now(),
  };
}

export interface RemTimesComparison {
  before: RemTimesSnapshot;
  after: RemTimesSnapshot;
  updatedAtMoved: boolean;
  localUpdatedAtMoved: boolean;
  priorityChanged: boolean;
  sourceChanged: boolean;
  lastUpdatedChanged: boolean;
  verdict: string;
}

export async function compareRemTimes(
  plugin: RNPlugin,
  before: RemTimesSnapshot
): Promise<RemTimesComparison | null> {
  const after = await snapshotRemTimes(plugin, before.remId);
  if (!after) return null;

  const priorityChanged = after.priority !== before.priority;
  const updatedAtMoved = after.updatedAt !== before.updatedAt;
  const lastUpdatedChanged = after.lastUpdated !== before.lastUpdated;

  let verdict: string;
  if (!priorityChanged) {
    verdict =
      'The priority value did not change between the two snapshots, so this run proves nothing. ' +
      'Edit the Priority property row in the editor before comparing.';
  } else if (updatedAtMoved) {
    verdict =
      'CAUGHT: the priority changed by hand and rem.updatedAt moved with it. A warm start keyed ' +
      'on updatedAt would notice this edit.' +
      (lastUpdatedChanged
        ? ' Note the lastUpdated slot also changed, so something did route through setCardPriority — ' +
          're-test with a pure editor edit to be sure updatedAt moved on its own.'
        : ' The lastUpdated slot did not change, confirming this was a pure editor edit.');
  } else {
    verdict =
      'MISSED: the priority changed by hand and rem.updatedAt did NOT move. A warm start keyed ' +
      'on updatedAt would serve the old priority indefinitely. This is the failure mode that ' +
      'rules out the simple version of the persisted-cache design.';
  }

  return {
    before,
    after,
    updatedAtMoved,
    localUpdatedAtMoved: after.localUpdatedAt !== before.localUpdatedAt,
    priorityChanged,
    sourceChanged: after.source !== before.source,
    lastUpdatedChanged,
    verdict,
  };
}

export interface TaggedRemPayloadReport {
  taggedCount: number;
  /** Wall-clock cost of the taggedRem() call itself. */
  elapsedMs: number;
  /** How many carry a usable (non-zero, numeric) updatedAt in the bulk payload. */
  withUpdatedAt: number;
  withLocalUpdatedAt: number;
  oldest: number | null;
  newest: number | null;
  /** The money metric: how many rems a warm start would actually have to re-read. */
  changedLastHour: number;
  changedLast24h: number;
  changedLast7d: number;
  changedLast30d: number;
  sample: Array<{ remId: string; updatedAt: number; localUpdatedAt: number; createdAt: number }>;
  verdict: string;
}

/**
 * Read-only. Answers the second half of the question: is `updatedAt` actually
 * populated in the payload `taggedRem()` returns (as opposed to only on rems
 * fetched individually via findOne), and how many rems would a warm start have
 * to re-read?
 *
 * The change buckets are the real output. If only a few hundred of 45k rems
 * changed in the last day, a warm start costs a few hundred round-trips instead
 * of 135,000 — that is the whole value of the scheme, quantified before any of
 * it is built.
 */
export async function probeTaggedRemPayload(plugin: RNPlugin): Promise<TaggedRemPayloadReport> {
  const t0 = Date.now();
  const powerup = await plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE);
  const tagged = (await powerup?.taggedRem()) || [];
  const elapsedMs = Date.now() - t0;

  const now = Date.now();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  let withUpdatedAt = 0;
  let withLocalUpdatedAt = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let changedLastHour = 0;
  let changedLast24h = 0;
  let changedLast7d = 0;
  let changedLast30d = 0;

  for (const rem of tagged) {
    const u = rem.updatedAt;
    if (typeof rem.localUpdatedAt === 'number' && rem.localUpdatedAt > 0) withLocalUpdatedAt++;
    if (typeof u !== 'number' || u <= 0) continue;
    withUpdatedAt++;
    if (oldest === null || u < oldest) oldest = u;
    if (newest === null || u > newest) newest = u;
    const age = now - u;
    if (age <= HOUR) changedLastHour++;
    if (age <= DAY) changedLast24h++;
    if (age <= 7 * DAY) changedLast7d++;
    if (age <= 30 * DAY) changedLast30d++;
  }

  const sample = tagged.slice(0, 5).map((r) => ({
    remId: r._id,
    updatedAt: r.updatedAt,
    localUpdatedAt: r.localUpdatedAt,
    createdAt: r.createdAt,
  }));

  let verdict: string;
  if (tagged.length === 0) {
    verdict = 'No tagged rems — nothing to measure.';
  } else if (withUpdatedAt === 0) {
    verdict =
      'NOT VIABLE: taggedRem() returns rems with no usable updatedAt, so the invalidation key ' +
      'is not free — it would need a per-rem fetch, which is the cost being avoided.';
  } else if (withUpdatedAt < tagged.length) {
    verdict =
      `PARTIAL: ${tagged.length - withUpdatedAt} of ${tagged.length} rems have no usable ` +
      'updatedAt in the bulk payload. Those would have to be treated as always-stale.';
  } else {
    const pct = ((changedLast24h / tagged.length) * 100).toFixed(1);
    verdict =
      `VIABLE: every tagged rem carries updatedAt for free. A warm start ${'≤'}24h old would ` +
      `re-read ${changedLast24h} rems (${pct}%) instead of all ${tagged.length} — ` +
      `roughly ${Math.round((changedLast24h * 3) / 1900)}s of slot reads instead of ` +
      `${Math.round((tagged.length * 3) / 1900)}s.`;
  }

  return {
    taggedCount: tagged.length,
    elapsedMs,
    withUpdatedAt,
    withLocalUpdatedAt,
    oldest,
    newest,
    changedLastHour,
    changedLast24h,
    changedLast7d,
    changedLast30d,
    sample,
    verdict,
  };
}
