import { RNPlugin, PluginRem, Card, RepetitionStatusInterface } from '@remnote/plugin-sdk';
import { IncrementalRep, repCountsForStats } from './incremental_rem/types';
import {
  powerupCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  dismissedDateSlotCode,
  preservedHistoryPowerupCode,
} from './consts';
import {
  FLASHCARD_RESPONSE_TIME_LIMIT_SETTING,
  DEFAULT_RESPONSE_TIME_LIMIT_SEC,
} from './authoritative_aggregates';
import { getIncrementalRemFromRem } from './incremental_rem';
import { getDismissedHistoryFromRem } from './dismissed';
import { safeRemTextToString } from './pdfUtils';
import { getDailyDocReferenceForDate } from './utils';

const TOMBSTONE_TEXT = '🪦 Preserved history — content removed';

/**
 * A pre-computed plan for 'Preserve history & remove'. Built by
 * {@link planPreserveHistoryAndRemove} (read-only) so the command can show an
 * accurate confirmation BEFORE any destructive action, then executed by
 * {@link executePreserveHistoryAndRemove}.
 */
export interface PreserveHistoryPlan {
  target: PluginRem;
  /** Every descendant of the target (the whole subtree below it). */
  descendantCount: number;
  /** Cards in the subtree (target + descendants) that will be removed. */
  cards: Card[];
  /** All preservable reps across the subtree, chronological. Empty ⇒ hard delete. */
  merged: IncrementalRep[];
  /** Sum of reviewTimeSeconds across `merged`. */
  totalReviewSeconds: number;
  /** Count of rems OUTSIDE the subtree that reference something inside it. */
  externalRefCount: number;
}

/**
 * Convert one flashcard repetition into an IncrementalRep tagged 'importedRep'.
 * Returns null for reps with no meaningful response time (absent/zero) — those
 * are TOO_EARLY / viewed events that don't represent study time and would only
 * add noise. reviewTime is capped the same way the Study Dashboard caps flashcard
 * time, so preserved totals match what the card would have contributed live.
 */
function convertCardRep(
  rep: RepetitionStatusInterface,
  capMs: number,
  flashcardName: string
): IncrementalRep | null {
  if (!rep.responseTime) return null;
  const cappedMs = Math.min(rep.responseTime, capMs);
  return {
    date: rep.date,
    scheduled: rep.scheduled ?? rep.date,
    // Whole seconds, matching every other reviewTimeSeconds in the system
    // (IncRem reps use dayjs.diff(..., 'second')). Fractional seconds here leaked
    // into the Study Dashboard totals as e.g. "2m 14.7729999…s".
    reviewTimeSeconds: Math.round(cappedMs / 1000),
    eventType: 'importedRep',
    context: {
      flashcardName,
      flashcardScore: rep.score,
    },
  };
}

/** The cloze id of a cloze card, or undefined for forward/backward cards. */
function getCardClozeId(card: Card): string | undefined {
  const t = card.type as unknown;
  return t && typeof t === 'object' && 'clozeId' in t
    ? (t as { clozeId: string }).clozeId
    : undefined;
}

/**
 * Render a card's owning-rem text for display as `context.flashcardName`. For a
 * cloze card, the clozed span (rich-text elements whose `cId` matches this card's
 * cloze id) is wrapped in `{{…}}` so multiple clozes on the same rem are
 * distinguishable — e.g. "flashcard {{inside}} that rem" vs "flashcard inside
 * that {{rem}}". Forward/backward cards (no cloze id) render as plain text.
 *
 * `segments` is the rem's rich text pre-rendered once per element (text + cId),
 * so this stays cheap when a rem owns several cards.
 */
function renderCardName(
  segments: { text: string; cId?: string }[],
  clozeId: string | undefined
): string {
  if (!clozeId) return segments.map((s) => s.text).join('');
  let out = '';
  let inCloze = false;
  for (const s of segments) {
    const match = s.cId === clozeId;
    if (match && !inCloze) {
      out += '{{';
      inCloze = true;
    } else if (!match && inCloze) {
      out += '}}';
      inCloze = false;
    }
    out += s.text;
  }
  if (inCloze) out += '}}';
  return out;
}

/**
 * Read-only: gather everything the command needs to (a) preview and (b) execute,
 * without mutating anything. Collects preservable history from flashcards,
 * Incremental powerups and Dismissed powerups across the target's whole subtree.
 */
export async function planPreserveHistoryAndRemove(
  plugin: RNPlugin,
  target: PluginRem
): Promise<PreserveHistoryPlan> {
  const descendants = await target.getDescendants();
  const subtree = [target, ...descendants];
  const subtreeIds = new Set(subtree.map((r) => r._id));

  // Cards in the subtree (single getAll, filtered by rem id — same pattern as the cache).
  const allCards = (await plugin.card.getAll()) || [];
  const cards = allCards.filter((c) => subtreeIds.has(c.remId));

  const capMs =
    ((await plugin.settings.getSetting<number>(FLASHCARD_RESPONSE_TIME_LIMIT_SETTING)) ||
      DEFAULT_RESPONSE_TIME_LIMIT_SEC) * 1000;

  const merged: IncrementalRep[] = [];

  // 1. Flashcard reps → importedRep. The display name is cloze-aware, so build
  //    it per-card. Pre-render each owning rem's rich-text elements once (text +
  //    cId) and cache, so a rem with several cards resolves cheaply.
  const remById = new Map(subtree.map((r) => [r._id, r]));
  const segmentsByRemId = new Map<string, { text: string; cId?: string }[]>();
  const getSegments = async (remId: string) => {
    const cached = segmentsByRemId.get(remId);
    if (cached) return cached;
    const rem = remById.get(remId);
    const rt = rem?.text;
    const segs = Array.isArray(rt)
      ? await Promise.all(
          rt.map(async (el) => ({
            text: await plugin.richText.toString([el as any]),
            cId: el && typeof el === 'object' ? (el as any).cId : undefined,
          }))
        )
      : [];
    segmentsByRemId.set(remId, segs);
    return segs;
  };

  for (const c of cards) {
    const segs = await getSegments(c.remId);
    const name = segs.length ? renderCardName(segs, getCardClozeId(c)) : 'flashcard';
    for (const rep of c.repetitionHistory || []) {
      const conv = convertCardRep(rep, capMs, name);
      if (conv) merged.push(conv);
    }
  }

  // 2. Incremental + Dismissed histories across the subtree (real reps only —
  //    skip lifecycle markers so we don't duplicate them; one fresh marker is
  //    stamped at write time).
  for (const r of subtree) {
    const inc = await getIncrementalRemFromRem(plugin, r);
    for (const rep of inc?.history || []) {
      if (repCountsForStats(rep.eventType)) merged.push(rep);
    }
    const dis = await getDismissedHistoryFromRem(plugin, r);
    for (const rep of dis?.history || []) {
      if (repCountsForStats(rep.eventType)) merged.push(rep);
    }
  }

  merged.sort((a, b) => a.date - b.date);

  const totalReviewSeconds = merged.reduce((s, r) => s + (r.reviewTimeSeconds || 0), 0);

  // External references: rems outside the subtree that reference something inside
  // it. Internal→internal refs vanish with the deletion, so they don't "break".
  const externalReferrers = new Set<string>();
  for (const r of subtree) {
    const refs = (await r.remsReferencingThis()) || [];
    for (const ref of refs) {
      if (!subtreeIds.has(ref._id)) externalReferrers.add(ref._id);
    }
  }

  return {
    target,
    descendantCount: descendants.length,
    cards,
    merged,
    totalReviewSeconds,
    externalRefCount: externalReferrers.size,
  };
}

/**
 * Destructive: execute a plan produced by {@link planPreserveHistoryAndRemove}.
 *
 * - If there is no preservable history, the target and its whole subtree are
 *   fully deleted (native Cmd+Opt+Shift+Backspace behaviour).
 * - Otherwise: the consolidated history is written onto the target's Dismissed
 *   powerup, the target's own cards + all descendants are removed, the target's
 *   content is scrubbed to a tombstone, and it is tagged with the Preserved
 *   History powerup (which the always-on CSS hides in editor and queue).
 */
export async function executePreserveHistoryAndRemove(
  plugin: RNPlugin,
  plan: PreserveHistoryPlan
): Promise<void> {
  const { target, cards, merged } = plan;

  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    const originalName = await safeRemTextToString(plugin, target.text);

    // No preservable history → behave exactly like a native delete.
    if (merged.length === 0) {
      await target.remove();
      return;
    }

    // Overwrite the Dismissed history slot with the full consolidated set plus a
    // fresh 'dismissed' marker (merged already contains the target's own prior
    // dismissed reps, so we must overwrite rather than append-merge).
    const dismissedMarker: IncrementalRep = {
      date: Date.now(),
      scheduled: Date.now(),
      eventType: 'dismissed',
      notes: `Preserved from removed content: ${originalName}`,
    };
    const finalHistory = [...merged, dismissedMarker];

    if (!(await target.hasPowerup(dismissedPowerupCode))) {
      await target.addPowerup(dismissedPowerupCode);
      const dateRef = await getDailyDocReferenceForDate(plugin, new Date());
      if (dateRef) {
        await target.setPowerupProperty(dismissedPowerupCode, dismissedDateSlotCode, dateRef);
      }
    }
    await target.setPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode, [
      JSON.stringify(finalHistory),
    ]);

    // No longer part of the incremental schedule.
    if (await target.hasPowerup(powerupCode)) {
      await target.removePowerup(powerupCode);
    }

    // A card-less tombstone should not keep a CardPriority tag — it owns no
    // flashcards to prioritise and is no longer an inheritance anchor. Plain
    // removePowerup is enough (the heavy removeCardPriorityFromRem walks children
    // this rem no longer has, and toggles plugin_operation_active itself).
    if (await target.hasPowerup('cardPriority')) {
      await target.removePowerup('cardPriority');
    }

    // Remove the subtree's flashcards (the target's own cards must go explicitly;
    // descendants' cards would vanish with their rems, but removing here is cheap
    // and keeps the count exact).
    for (const c of cards) {
      try {
        await c.remove();
      } catch (e) {
        console.error(`[PreserveHistory] Failed to remove card ${c._id}:`, e);
      }
    }

    // Delete descendants (re-fetch: removing a rem cascades to its own subtree).
    for (const d of await target.getDescendants()) {
      try {
        await d.remove();
      } catch (e) {
        console.error(`[PreserveHistory] Failed to remove descendant ${d._id}:`, e);
      }
    }

    // Scrub content + mark as a hidden tombstone. Only clear the back side when
    // one actually exists — a cloze / plain rem has no back text, and setBackText
    // rejects `undefined`/empty at runtime ("backText parameter: Required"). Guard
    // on the existing backText and keep it best-effort so it never stops the
    // powerup from landing.
    await target.setText([TOMBSTONE_TEXT]);
    if (target.backText && target.backText.length > 0) {
      try {
        await target.setBackText([]);
      } catch (e) {
        console.warn('[PreserveHistory] Could not clear back text:', e);
      }
    }
    await target.addPowerup(preservedHistoryPowerupCode);
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}
