/**
 * Deleting card records that no longer correspond to anything in their Rem.
 *
 * A Rem can hold cloze card records whose cloze ids are absent from its text —
 * the `markup-removed` state in findings/CARD_STATE_REFERENCE.md. They keep their whole
 * repetition history, they can never be practised again, and RemNote's own UI
 * shows them under the Rem while reporting "Cards in Document 0".
 *
 * DELETION IS THE POINT HERE, so the bar is set deliberately high and the flow
 * is split in two: `analyzeOrphanCards` decides and explains, `deleteCards`
 * only executes a list the caller has already been shown. A card qualifies only
 * when ALL of these hold:
 *
 *  - it is a cloze card with a cloze id,
 *  - that cloze id is NOT among the ids in the Rem's current text,
 *  - it has no `nextRepetitionTime` (RemNote will never surface it anyway).
 *
 * Forward/backward records get their own, SEPARATE list, because the rule that
 * clears them is different: a Rem with no back side cannot generate a card in
 * either direction, whatever its practice direction says. That list is never
 * merged into the cloze one — the caller has to opt into it — because when the
 * Rem DOES have a back side, an unscheduled forward/backward record is fully
 * explained by a disabled direction and must be left alone.
 *
 * Everything else is reported with a reason and untouched.
 *
 * Card deletion is not undoable through this API. `analyzeOrphanCards` therefore
 * returns the full repetition history of every candidate, so the caller can hand
 * the user a backup file BEFORE anything is removed.
 */

import { QueueInteractionScore, RNPlugin } from '@remnote/plugin-sdk';
import { collectClozeIds } from './card_analytics_export';
import { SuppressionLease } from './operation_suppression';
import { safeRemTextToString } from './pdfUtils';

/** Why a card on the Rem was NOT selected for deletion. */
export type KeepReason =
  | 'markup-present'
  | 'scheduled'
  | 'direction-explainable'
  | 'no-cloze-id';

export const KEEP_REASON_LABELS: Record<KeepReason, string> = {
  'markup-present': 'Its cloze is still in the Rem’s text',
  scheduled: 'It has a nextRepetitionTime — RemNote still schedules it',
  'direction-explainable':
    'Forward/backward card on a Rem that HAS a back side — a disabled direction explains it',
  'no-cloze-id': 'Cloze card with no readable cloze id',
};

export interface OrphanCardAnalysis {
  remId: string;
  remText: string;
  /** Cloze ids currently in the Rem's text. */
  remClozeIds: string[];
  totalCards: number;
  /** Cards the Rem currently surfaces, for context. */
  surfacedCards: number;
  /** Does the Rem still have a back side? Decides the forward/backward list. */
  hasBackText: boolean;
  /** Cloze ids selected for deletion — every one meets all three conditions. */
  deletable: string[];
  /**
   * Forward/backward records on a Rem with NO back side, unscheduled. RemNote
   * cannot generate either direction without one, so these correspond to
   * nothing — but they are opt-in, never folded into `deletable`.
   */
  deletableDirectionless: string[];
  /** Everything not selected, with the reason it was kept. */
  kept: Array<{ cardId: string; type: string; reason: KeepReason }>;
  keptByReason: Record<KeepReason, number>;
  /** Full records of the deletable cards — the backup, taken before deleting. */
  backup: Array<{
    cardId: string;
    remId: string;
    clozeId: string | null;
    createdAt: number | null;
    nextRepetitionTime: number | null;
    repetitionHistory: unknown[];
  }>;
}

export async function analyzeOrphanCards(
  plugin: RNPlugin,
  remId: string,
): Promise<OrphanCardAnalysis | null> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const [allCards, surfaced, remText] = await Promise.all([
    plugin.card.getAll(),
    rem.getCards().catch(() => [] as any[]),
    safeRemTextToString(plugin, rem.text),
  ]);

  const remClozeIds = collectClozeIds(rem.text);
  const owned = ((allCards || []) as any[]).filter((c: any) => c.remId === remId);

  const hasBackText = Array.isArray((rem as any).backText) && (rem as any).backText.length > 0;

  const deletable: string[] = [];
  const deletableDirectionless: string[] = [];
  const kept: OrphanCardAnalysis['kept'] = [];
  const keptByReason: Record<KeepReason, number> = {
    'markup-present': 0,
    scheduled: 0,
    'direction-explainable': 0,
    'no-cloze-id': 0,
  };
  const backup: OrphanCardAnalysis['backup'] = [];

  for (const c of owned) {
    const isCloze = c.type && typeof c.type === 'object' && 'clozeId' in c.type;
    const clozeId = isCloze ? String(c.type.clozeId) : null;
    const type = isCloze ? `cloze:${clozeId}` : String(c.type);

    const reject = (reason: KeepReason) => {
      kept.push({ cardId: c._id, type, reason });
      keptByReason[reason]++;
    };

    if (!isCloze) {
      // A back side means RemNote could still generate this direction, so a
      // disabled direction explains the record and it is not ours to remove.
      const scheduled = c.nextRepetitionTime !== null && c.nextRepetitionTime !== undefined;
      if (hasBackText || scheduled) {
        reject('direction-explainable');
        continue;
      }
      deletableDirectionless.push(c._id);
      backup.push({
        cardId: c._id,
        remId,
        clozeId: null,
        createdAt: c.createdAt ?? null,
        nextRepetitionTime: c.nextRepetitionTime ?? null,
        repetitionHistory: c.repetitionHistory ?? [],
      });
      continue;
    }
    if (!clozeId) {
      reject('no-cloze-id');
      continue;
    }
    if (remClozeIds.has(clozeId)) {
      reject('markup-present');
      continue;
    }
    if (c.nextRepetitionTime !== null && c.nextRepetitionTime !== undefined) {
      reject('scheduled');
      continue;
    }

    deletable.push(c._id);
    backup.push({
      cardId: c._id,
      remId,
      clozeId,
      createdAt: c.createdAt ?? null,
      nextRepetitionTime: c.nextRepetitionTime ?? null,
      repetitionHistory: c.repetitionHistory ?? [],
    });
  }

  return {
    remId,
    remText,
    remClozeIds: Array.from(remClozeIds),
    totalCards: owned.length,
    surfacedCards: surfaced.length,
    hasBackText,
    deletable,
    deletableDirectionless,
    kept,
    keptByReason,
    backup,
  };
}

export interface DeleteCardsResult {
  deleted: number;
  failed: number;
  elapsedMs: number;
}

/**
 * Delete a list of card ids. Sequential: reads overlap fine on the plugin
 * bridge, writes do not. Held under a renewable suppression lease so the
 * plugin's own change listeners don't chase thousands of pointless updates —
 * renewable rather than a bare flag because a popup the user closes never
 * reaches the `finally`.
 */
export async function deleteCards(
  plugin: RNPlugin,
  cardIds: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<DeleteCardsResult> {
  const t0 = Date.now();
  const result: DeleteCardsResult = { deleted: 0, failed: 0, elapsedMs: 0 };

  const lease = new SuppressionLease(plugin);
  await lease.start();
  try {
    for (let i = 0; i < cardIds.length; i++) {
      try {
        const card = await plugin.card.findOne(cardIds[i]);
        // Already gone — a re-run over a stale list. The desired end state is
        // what is already true, so this is not a failure.
        if (!card) continue;
        await card.remove();
        result.deleted++;
      } catch (e) {
        result.failed++;
        console.error('[OrphanCardCleanup] delete failed for', cardIds[i], e);
      }
      if ((i + 1) % 50 === 0) {
        onProgress?.(i + 1, cardIds.length);
        await lease.renew();
      }
    }
  } finally {
    await lease.release();
  }

  result.elapsedMs = Date.now() - t0;
  onProgress?.(cardIds.length, cardIds.length);
  console.log(
    `[OrphanCardCleanup] deleted ${result.deleted}, failed ${result.failed} · ` +
      `${(result.elapsedMs / 1000).toFixed(1)}s`,
  );
  return result;
}


// --- KB-wide sweep: cloze cards whose markup is gone ----------------------
//
// The per-Rem tool above is for one known Rem. This one sweeps the whole KB for
// the same `markup-removed` state, and splits the result by how much history is
// at stake — because that is the whole decision:
//
//   · GRADED    — real practice happened. A reworded Rem or a cloze split into
//                 several loses its markup but keeps history worth preserving.
//                 Never offered for deletion.
//   · TOUCHED   — history entries exist but none is a grade (skips, resets,
//                 views). "Times practiced 6 / Last practiced Never" in
//                 RemNote's UI. Offered separately, opt-in.
//   · UNTOUCHED — no history entries at all. Nothing is lost.
//
// Only cloze cards with no `nextRepetitionTime` can be in this state, and that
// filter runs before any Rem is read, which is what keeps the sweep affordable:
// a few hundred Rem reads instead of one per card-owning Rem in the KB.

function isGradeable(score: QueueInteractionScore): boolean {
  return (
    score === QueueInteractionScore.AGAIN ||
    score === QueueInteractionScore.HARD ||
    score === QueueInteractionScore.GOOD ||
    score === QueueInteractionScore.EASY
  );
}

export interface MarkupGoneCard {
  cardId: string;
  remId: string;
  clozeId: string;
  remText: string;
  historyEntries: number;
  gradedReps: number;
  createdAt: number | null;
  repetitionHistory: unknown[];
}

export interface MarkupGoneScan {
  /** Cloze cards with no next time — everything that could possibly qualify. */
  candidates: number;
  /** Rems actually read (one per distinct owner of a candidate). */
  remsRead: number;
  /** Markup gone, no history entries at all — safe to delete. */
  untouched: MarkupGoneCard[];
  /** Markup gone, has entries but was never graded — opt-in. */
  touched: MarkupGoneCard[];
  /** Markup gone but really practised. Reported only; never deletable here. */
  gradedCount: number;
  gradedReps: number;
  /** Candidates whose Rem still holds their cloze — not markup-gone at all. */
  markupPresent: number;
  /** Candidates whose Rem could not be read. */
  remUnreadable: number;
  elapsedMs: number;
}

export async function scanMarkupGoneCards(
  plugin: RNPlugin,
  onProgress?: (done: number, total: number, phase: string) => void,
): Promise<MarkupGoneScan> {
  const t0 = Date.now();
  onProgress?.(0, 0, 'Loading cards…');
  const allCards = (await plugin.card.getAll()) || [];

  // Cheap filter first: only an unscheduled CLOZE card can be markup-gone.
  const candidates = (allCards as any[]).filter(
    (c) =>
      (c.nextRepetitionTime === null || c.nextRepetitionTime === undefined) &&
      c.type &&
      typeof c.type === 'object' &&
      'clozeId' in c.type,
  );

  const scan: MarkupGoneScan = {
    candidates: candidates.length,
    remsRead: 0,
    untouched: [],
    touched: [],
    gradedCount: 0,
    gradedReps: 0,
    markupPresent: 0,
    remUnreadable: 0,
    elapsedMs: 0,
  };

  // remId -> { clozeIds, text } | null when the Rem could not be read.
  const remCache = new Map<string, { clozeIds: Set<string>; text: string } | null>();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let info = remCache.get(c.remId);
    if (info === undefined) {
      try {
        const rem = await plugin.rem.findOne(c.remId);
        info = rem
          ? { clozeIds: collectClozeIds(rem.text), text: await safeRemTextToString(plugin, rem.text) }
          : null;
      } catch {
        info = null;
      }
      remCache.set(c.remId, info);
      scan.remsRead++;
    }

    if (!info) {
      scan.remUnreadable++;
      continue;
    }

    const clozeId = String(c.type.clozeId);
    if (info.clozeIds.has(clozeId)) {
      scan.markupPresent++;
      continue;
    }

    const history: any[] = c.repetitionHistory ?? [];
    const gradedReps = history.filter((h) => isGradeable(h?.score)).length;
    if (gradedReps > 0) {
      scan.gradedCount++;
      scan.gradedReps += gradedReps;
      continue;
    }

    const record: MarkupGoneCard = {
      cardId: c._id,
      remId: c.remId,
      clozeId,
      remText: info.text,
      historyEntries: history.length,
      gradedReps,
      createdAt: c.createdAt ?? null,
      repetitionHistory: history,
    };
    if (history.length === 0) scan.untouched.push(record);
    else scan.touched.push(record);

    if ((i + 1) % 200 === 0) {
      onProgress?.(i + 1, candidates.length, 'Checking cloze markup…');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.(candidates.length, candidates.length, 'Done');
  scan.elapsedMs = Date.now() - t0;
  console.log(
    `[MarkupGoneScan] ${scan.candidates} candidate(s), ${scan.remsRead} rem(s) read · ` +
      `untouched ${scan.untouched.length}, touched ${scan.touched.length}, ` +
      `graded (kept) ${scan.gradedCount} holding ${scan.gradedReps} reps · ` +
      `markup still present ${scan.markupPresent}, unreadable rems ${scan.remUnreadable} · ` +
      `${(scan.elapsedMs / 1000).toFixed(1)}s`,
  );
  return scan;
}
