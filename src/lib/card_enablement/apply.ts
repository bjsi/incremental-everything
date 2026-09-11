// lib/card_enablement/apply.ts
//
// The write half of the card-enablement audit: turning practice or a practice
// direction back on across a selection, and being able to take it back.
//
// THREE THINGS MAKE THIS DIFFERENT FROM AN ORDINARY BULK EDIT
//
// 1. It CREATES CARDS. A Rem whose direction was 'none' before any card was
//    made owns no card records at all; giving it a direction makes them, with
//    zero repetitions and a due date of now. Re-enabling three hundred imported
//    Anki rows therefore drops several hundred brand-new cards into the queue at
//    once, at whatever priority they inherit. `cardPriority` in the options
//    exists so they can be placed deliberately instead.
//
// 2. There is no transaction and no undo stack in the SDK. So every run records
//    the prior (enablePractice, practiceDirection) of every Rem it touches
//    BEFORE touching it, and `undoEnablement` replays that snapshot. The same
//    bar the empty-ECD cleanup and the orphan-card deletion already hold to.
//
// 3. The writes are sequential. These are bridge round-trips against a listener
//    that is watching for Rem changes; firing them in parallel is how the
//    ancestor-walk storms happened. Sequential, with a suppression lease held
//    across the run and renewed as it goes, so a popup closed mid-flight cannot
//    leave the GlobalRemChanged listener suppressed for the rest of the session.

import { RNPlugin } from '@remnote/plugin-sdk';
import { SuppressionLease } from '../operation_suppression';
import { setCardPriority } from '../card_priority';
import { updateCardPriorityCache } from '../card_priority/cache';
import { EnablementRow, PracticeDirection } from './scan';

export type EnablementAction =
  | { kind: 'set-direction'; direction: PracticeDirection }
  | { kind: 'set-practice'; enabled: boolean };

export function describeAction(action: EnablementAction): string {
  return action.kind === 'set-direction'
    ? `set flashcard direction to “${action.direction}”`
    : action.enabled
      ? 'switch cards ON'
      : 'switch cards OFF';
}

export interface SnapshotRow {
  remId: string;
  text: string;
  enablePractice: boolean;
  practiceDirection: PracticeDirection | null;
  /** Cards surfaced before the write — the baseline for "how many appeared". */
  surfacedBefore: number;
}

export interface EnablementSnapshot {
  takenAt: number;
  anchorId: string;
  anchorText: string;
  action: EnablementAction;
  rows: SnapshotRow[];
}

export interface ApplyOptions {
  /**
   * Stamp this card priority on every Rem the run enables, so the cards it
   * creates enter the queue where the user chose rather than at the default.
   * Null skips the write entirely.
   */
  cardPriority?: number | null;
}

export interface ApplyResult {
  changed: number;
  failed: Array<{ remId: string; text: string; error: string }>;
  /** Cards that exist after the run but did not before, across all touched Rems. */
  cardsCreated: number;
  snapshot: EnablementSnapshot;
}

export interface ApplyProgress {
  phase: 'snapshot' | 'writing' | 'counting' | 'priority' | 'done';
  done: number;
  total: number;
}

/**
 * Apply one action to `rows`.
 *
 * `rows` is what the user was shown and selected — this never re-derives the
 * population. A selection the user reviewed is exactly what gets written, which
 * is the same rule the empty-ECD deletion follows.
 */
export async function applyEnablement(
  plugin: RNPlugin,
  anchorId: string,
  anchorText: string,
  rows: EnablementRow[],
  action: EnablementAction,
  opts: ApplyOptions = {},
  onProgress?: (p: ApplyProgress) => void,
): Promise<ApplyResult> {
  const snapshot: EnablementSnapshot = {
    takenAt: Date.now(),
    anchorId,
    anchorText,
    action,
    rows: rows.map((r) => ({
      remId: r.remId,
      text: r.text,
      enablePractice: r.enablePractice,
      practiceDirection: r.practiceDirection,
      surfacedBefore: r.surfaced,
    })),
  };

  onProgress?.({ phase: 'snapshot', done: 0, total: rows.length });

  const lease = new SuppressionLease(plugin);
  await lease.start();

  const failed: ApplyResult['failed'] = [];
  const touched: string[] = [];
  let changed = 0;

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const rem: any = await plugin.rem.findOne(row.remId);
        if (!rem) throw new Error('Rem not found');
        if (action.kind === 'set-direction') {
          await rem.setPracticeDirection(action.direction);
        } else {
          await rem.setEnablePractice(action.enabled);
        }
        changed++;
        touched.push(row.remId);
      } catch (e: any) {
        failed.push({ remId: row.remId, text: row.text, error: e?.message ?? String(e) });
      }
      await lease.renew();
      onProgress?.({ phase: 'writing', done: i + 1, total: rows.length });
    }

    // How many cards the run actually produced. Read back rather than predicted:
    // whether a direction change revives an old card record or mints a new one
    // is RemNote's decision, not something this module can assume.
    onProgress?.({ phase: 'counting', done: 0, total: touched.length });
    let cardsCreated = 0;
    for (let i = 0; i < touched.length; i++) {
      try {
        const rem: any = await plugin.rem.findOne(touched[i]);
        const after = rem ? ((await rem.getCards().catch(() => [])) || []).length : 0;
        const before = snapshot.rows.find((r) => r.remId === touched[i])?.surfacedBefore ?? 0;
        if (after > before) cardsCreated += after - before;
      } catch {
        /* a Rem that cannot be re-read just does not contribute to the count */
      }
      onProgress?.({ phase: 'counting', done: i + 1, total: touched.length });
    }

    // Priority for the cards this run brought into the queue. Only meaningful
    // when the run enabled something, so it is skipped for a switch-OFF.
    const enabling =
      action.kind === 'set-practice' ? action.enabled : action.direction !== 'none';
    if (typeof opts.cardPriority === 'number' && enabling && touched.length > 0) {
      onProgress?.({ phase: 'priority', done: 0, total: touched.length });
      for (let i = 0; i < touched.length; i++) {
        try {
          const rem: any = await plugin.rem.findOne(touched[i]);
          if (rem) {
            await setCardPriority(plugin, rem, opts.cardPriority, 'manual', false, {
              event: 'enablement',
            });
            await updateCardPriorityCache(plugin, touched[i]);
          }
        } catch (e) {
          console.error('[CardEnablement] card priority write failed for', touched[i], e);
        }
        await lease.renew();
        onProgress?.({ phase: 'priority', done: i + 1, total: touched.length });
      }

      // Inheritance cascades from each modified Rem, not from the anchor: the
      // population is scattered across the KB and is not a subtree, so a cascade
      // rooted at the anchor would never reach it. Same reasoning as the batch
      // card-priority panel.
      await plugin.storage.setSession('pendingInheritanceCascade', touched);
      onProgress?.({ phase: 'done', done: touched.length, total: touched.length });
      return { changed, failed, cardsCreated, snapshot };
    }

    onProgress?.({ phase: 'done', done: rows.length, total: rows.length });
    return { changed, failed, cardsCreated, snapshot };
  } finally {
    // Not released when a cascade was handed off — the tracker clears the flag
    // itself once it finishes, exactly as the batch card-priority panel expects.
    const handedOff =
      typeof opts.cardPriority === 'number' &&
      touched.length > 0 &&
      (action.kind === 'set-practice' ? action.enabled : action.direction !== 'none');
    if (!handedOff) await lease.release();
  }
}

/** Put every Rem in `snapshot` back to the state it was recorded in. */
export async function undoEnablement(
  plugin: RNPlugin,
  snapshot: EnablementSnapshot,
  onProgress?: (done: number, total: number) => void,
): Promise<{ restored: number; failed: string[] }> {
  const lease = new SuppressionLease(plugin);
  await lease.start();
  const failed: string[] = [];
  let restored = 0;

  try {
    for (let i = 0; i < snapshot.rows.length; i++) {
      const row = snapshot.rows[i];
      try {
        const rem: any = await plugin.rem.findOne(row.remId);
        if (!rem) throw new Error('Rem not found');
        // Both switches are restored regardless of which one the run wrote: the
        // action may have changed the other as a side effect (setting a
        // direction on a Rem with practice off is not guaranteed to leave the
        // Enable-Cards flag alone), and writing a value back to what it already
        // was is a no-op.
        if (row.practiceDirection) await rem.setPracticeDirection(row.practiceDirection);
        await rem.setEnablePractice(row.enablePractice);
        restored++;
      } catch (e) {
        console.error('[CardEnablement] undo failed for', row.remId, e);
        failed.push(row.remId);
      }
      await lease.renew();
      onProgress?.(i + 1, snapshot.rows.length);
    }
  } finally {
    await lease.release();
  }

  return { restored, failed };
}

/** Download the snapshot as JSON, so a run stays recoverable after the session. */
export function downloadSnapshot(snapshot: EnablementSnapshot): boolean {
  try {
    const stamp = new Date(snapshot.takenAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `card-enablement-${snapshot.anchorId}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch (e) {
    console.error('[CardEnablement] snapshot download blocked', e);
    return false;
  }
}
