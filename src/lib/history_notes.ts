import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { powerupCode, repHistorySlotCode, allIncrementalRemKey } from './consts';
import { IncrementalRem, IncrementalRep } from './incremental_rem/types';
import { tryParseJson } from './utils';
import {
  getActivePdfForIncRem,
  getIncrementalPageRange,
  getIncrementalReadingPosition,
  getPageHistory,
  safeRemTextToString,
} from './pdfUtils';

/**
 * User notes and machine context attached to history entries (IncrementalRep.notes /
 * IncrementalRep.context).
 *
 * Size guards: the History slot is a JSON powerup property on the rem, and oversized
 * rems fail to sync ("too large to sync"). Notes are capped and context strings
 * truncated at write time.
 */
export const MAX_NOTE_LENGTH = 500;
const MAX_BOOKMARK_LENGTH = 120;
const MAX_PDF_NAME_LENGTH = 80;

export type RepContext = NonNullable<IncrementalRep['context']>;

// ---------------------------------------------------------------------------
// Pending-note handoff (session storage — the codebase's cross-iframe channel)
// ---------------------------------------------------------------------------
//
// The history entry for the review in progress does not exist until the review
// ends (queue "Next", editor timer end), when the scheduler appends it. A note
// typed mid-review is therefore parked under a per-rem session key and consumed
// by the write funnel (updateReviewRemData) or the dismiss path, whichever ends
// the review.

const pendingNoteKey = (remId: string) => `pending-review-note-${remId}`;

/** Trim + cap a user note; returns undefined when effectively empty. */
export function sanitizeNote(note: string | undefined | null): string | undefined {
  const trimmed = (note || '').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_NOTE_LENGTH);
}

/** Park (or clear, when empty) the note typed for the review in progress. */
export async function setPendingReviewNote(
  plugin: RNPlugin,
  remId: string,
  note: string | undefined | null
): Promise<void> {
  await plugin.storage.setSession(pendingNoteKey(remId), sanitizeNote(note) ?? null);
}

/** Read the parked note without clearing it (for UI prefill). */
export async function getPendingReviewNote(
  plugin: RNPlugin,
  remId: string
): Promise<string | undefined> {
  const note = await plugin.storage.getSession<string | null>(pendingNoteKey(remId));
  return sanitizeNote(note);
}

/** Read AND clear the parked note — called once by whichever flow ends the review. */
export async function consumePendingReviewNote(
  plugin: RNPlugin,
  remId: string
): Promise<string | undefined> {
  const note = await getPendingReviewNote(plugin, remId);
  if (note !== undefined) {
    await plugin.storage.setSession(pendingNoteKey(remId), null);
  }
  return note;
}

// ---------------------------------------------------------------------------
// Machine context snapshots
// ---------------------------------------------------------------------------

/**
 * Snapshot the reading-session state for a history entry: active PDF, current
 * page, page range, and the last bookmark text. Unlike the live synced-storage
 * keys these values come from, the snapshot is persisted inside the rem's
 * History slot, so it survives synced-storage loss and records the historical
 * trajectory (page at EACH rep, not just now).
 *
 * Returns undefined when there is nothing meaningful to record (non-PDF/HTML
 * rems, or a PDF with no saved position/range/bookmark). Never throws.
 */
export async function buildRepContext(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<RepContext | undefined> {
  try {
    const pdfRem = await getActivePdfForIncRem(plugin, rem);
    if (!pdfRem) return undefined;

    const [page, range, pageHistory] = await Promise.all([
      getIncrementalReadingPosition(plugin, rem._id, pdfRem._id),
      getIncrementalPageRange(plugin, rem._id, pdfRem._id),
      getPageHistory(plugin, rem._id, pdfRem._id),
    ]);

    // Last bookmark: most recent page-history entry carrying a highlightId.
    let bookmark: string | undefined;
    for (let i = pageHistory.length - 1; i >= 0; i--) {
      const highlightId = pageHistory[i].highlightId;
      if (highlightId) {
        const highlightRem = await plugin.rem.findOne(highlightId);
        if (highlightRem) {
          const text = await safeRemTextToString(plugin, highlightRem.text);
          if (text && text !== 'Untitled') {
            bookmark = text.slice(0, MAX_BOOKMARK_LENGTH);
          }
        }
        break;
      }
    }

    const context: RepContext = {};
    if (typeof page === 'number' && page > 0) context.page = page;
    if (range) {
      context.rangeStart = range.start;
      if (range.end > 0) context.rangeEnd = range.end;
    }
    if (bookmark) context.bookmark = bookmark;

    // pdfName alone carries no session info — only include it when it labels
    // an actual position/range/bookmark snapshot.
    if (Object.keys(context).length === 0) return undefined;
    context.pdfName = (await safeRemTextToString(plugin, pdfRem.text)).slice(0, MAX_PDF_NAME_LENGTH);

    return context;
  } catch (e) {
    console.warn('[history_notes] buildRepContext failed (skipping snapshot):', e);
    return undefined;
  }
}

/**
 * Stamp a pending user note (if any) and a machine context snapshot onto a
 * just-built history entry, in place. Shared by the review funnel and the
 * event writers (reschedule, executeRepetition, dismiss).
 */
export async function stampNoteAndContext(
  plugin: RNPlugin,
  rem: PluginRem,
  entry: IncrementalRep,
  explicitNote?: string
): Promise<void> {
  // Always consume the parked note (even when an explicit one wins) so it can't
  // leak onto a later, unrelated entry for the same rem in this session.
  const pending = await consumePendingReviewNote(plugin, rem._id);
  const note = sanitizeNote(explicitNote) ?? pending;
  if (note) entry.notes = note;
  const context = await buildRepContext(plugin, rem);
  if (context) entry.context = context;
}

// ---------------------------------------------------------------------------
// After-the-fact amendment
// ---------------------------------------------------------------------------

/**
 * Append a user note to the LAST entry of an active IncRem's history — for
 * flows where the repetition was already recorded before the user finished
 * typing (e.g. editor review timer after a queue handoff: the rep is written
 * on handoff, the note on "End Review").
 *
 * Appends with a newline when the entry already has a note. Also patches the
 * session IncRem cache so dashboards see the amended history.
 *
 * @returns true when a note was written, false otherwise (no history / empty note).
 */
export async function appendNoteToLastHistoryEntry(
  plugin: RNPlugin,
  remId: string,
  note: string | undefined | null
): Promise<boolean> {
  const sanitized = sanitizeNote(note);
  if (!sanitized) return false;

  const rem = await plugin.rem.findOne(remId);
  if (!rem || !(await rem.hasPowerup(powerupCode))) return false;

  const historyRaw = await rem.getPowerupProperty(powerupCode, repHistorySlotCode);
  const history: IncrementalRep[] = tryParseJson(historyRaw) || [];
  if (history.length === 0) return false;

  const lastEntry = history[history.length - 1];
  lastEntry.notes = sanitizeNote(
    lastEntry.notes ? `${lastEntry.notes}\n${sanitized}` : sanitized
  );

  await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(history)]);

  // Keep the session IncRem cache consistent (same pattern as updateIncrementalRemCache,
  // inlined here to avoid an import cycle with incremental_rem/index).
  try {
    const allRems: IncrementalRem[] = (await plugin.storage.getSession(allIncrementalRemKey)) || [];
    const cached = allRems.find((r) => r.remId === remId);
    if (cached) {
      const updated = allRems
        .filter((r) => r.remId !== remId)
        .concat({ ...cached, history });
      await plugin.storage.setSession(allIncrementalRemKey, updated);
    }
  } catch (e) {
    console.warn('[history_notes] cache patch after note append failed:', e);
  }

  return true;
}
