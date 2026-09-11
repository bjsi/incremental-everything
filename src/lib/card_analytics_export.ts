/**
 * Per-card export for the Card Priority × Memory Analytics tab.
 *
 * The table shows aggregates; this turns the same population into one CSV row
 * per card so a bucket's %New / Due discrepancy can be traced to individual
 * cards. Rows come straight from `computeCardAnalyticsBreakdown`'s `onRow`
 * sink, so the New / Due / Stale predicates and the bucketing are the table's,
 * not a re-implementation.
 *
 * On top of the raw rows it adds:
 *  - per-Rem rollups (how many of the Rem's cards are unscheduled / due),
 *  - a diagnosis summary (the New × schedule-state matrix, overall and per
 *    bucket), which is what answers "why is this bucket 2% New but 0 due?",
 *  - lazily resolved Rem context (text, paused-document flag, and the
 *    `rem.getCards()` count) for a capped set of the most interesting Rems —
 *    the expensive part, so it only runs for cards that are New-but-not-due.
 */

import { RNPlugin, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { CardAnalyticsRow } from './card_analytics';
import { safeRemTextToString } from './pdfUtils';
import { powerupCode as INCREMENTAL_POWERUP_CODE } from './consts';

/**
 * Collect every cloze id present in a Rem's rich text. Cloze markup is carried
 * on rich-text elements as `cId` (plus `blocks` for image clozes, `clozeOrder`
 * and `latexClozes`), so the ids here are exactly the clozes the Rem currently
 * defines. Comparing them against a card's `type.clozeId` answers the one
 * question `rem.getCards()` cannot: is this card's markup still in the text?
 */
export function collectClozeIds(richText: any): Set<string> {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) ids.add(v);
  };
  const visit = (node: any, depth: number) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.cId)) node.cId.forEach(add);
    else add(node.cId);
    if (Array.isArray(node.clozeOrder)) {
      for (const c of node.clozeOrder) {
        if (typeof c === 'string') add(c);
        else visit(c, depth + 1);
      }
    }
    if (Array.isArray(node.latexClozes)) node.latexClozes.forEach(add);
    if (Array.isArray(node.blocks)) visit(node.blocks, depth + 1);
    if (Array.isArray(node.text)) visit(node.text, depth + 1);
  };
  visit(richText, 0);
  return ids;
}

/**
 * The visible text inside each cloze in a rich text. Cloze markup lives on the
 * text elements themselves (`cId`), so the cloze's own words are that element's
 * `text`. Used to show a Rem's clozes when the user is deciding whether to
 * re-enable it — the front/back pair alone often doesn't say what was clozed.
 */
export function collectClozeTexts(richText: any): string[] {
  const out: string[] = [];
  const visit = (node: any, depth: number) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const hasCloze = typeof node.cId === 'string' || Array.isArray(node.cId);
    if (hasCloze && typeof node.text === 'string' && node.text.trim()) {
      out.push(node.text.trim());
    }
    if (Array.isArray(node.blocks)) visit(node.blocks, depth + 1);
    if (Array.isArray(node.text)) visit(node.text, depth + 1);
  };
  visit(richText, 0);
  return out;
}

/**
 * The cloze id a card record was generated from, or `null` for a forward /
 * backward card.
 *
 * Cloze cards carry their id in `card.type.clozeId`; direction cards report a
 * plain string type. Stringified because the field arrives as a number while
 * `collectClozeIds` reads the text markup as strings — comparing the two raw
 * silently never matches.
 */
export function clozeIdOfCard(card: any): string | null {
  const t = card?.type;
  if (t && typeof t === 'object' && 'clozeId' in t) return String(t.clozeId);
  return null;
}

/**
 * Which of a Rem's clozes are switched off — derived, because the flag itself
 * is unreadable.
 *
 * RemNote stores disabled clozes in the Rem document's `dci` field: an array of
 * cloze ids, written per cloze by "Enable this card" in the queue and en masse
 * by the `/Disable All Cloze Cards` command. There is no separate "all clozes
 * off" state — Disable All simply fills `dci` with every cloze id in the text —
 * and `isClozeIdEnabled(id)` is just `!dci.includes(id)`.
 *
 * `dci` never reaches a plugin. The SDK's Rem serializer copies a fixed field
 * list (`_id`, `parent`, `children`, `type`, `text`, `backText`, timestamps) and
 * drops the rest, the host's rem bridge exposes no cloze accessor, and its
 * `getCards` handler is hardcoded to `includeDisabled: false`. So the state is
 * reconstructed from the two things that DO cross the bridge: the card table
 * still holds a record for a disabled cloze, and `rem.getCards()` omits it.
 *
 * A cloze counts as disabled only when its id is still in the text AND owns a
 * card record AND that record is absent from `getCards()`. The markup test
 * keeps an edited-away cloze out; requiring a record keeps out a cloze whose
 * card was never generated. Rem-wide causes (practice off, a disabling
 * ancestor, a paused deck) suppress every card at once and must be ruled out by
 * the caller BEFORE reading this — they would otherwise make every cloze on the
 * Rem look individually switched off.
 */
export function derivedDisabledClozeIds(
  textClozeIds: Iterable<string>,
  cardRecords: any[],
  surfacedCards: any[],
): string[] {
  const inText = new Set(textClozeIds);
  const surfacedIds = new Set(surfacedCards.map((c: any) => c?._id));
  const disabled = new Set<string>();
  for (const card of cardRecords) {
    const clozeId = clozeIdOfCard(card);
    if (!clozeId || !inText.has(clozeId)) continue;
    if (surfacedIds.has(card?._id)) continue;
    disabled.add(clozeId);
  }
  return Array.from(disabled);
}

/**
 * Does the Rem still define the markup this card was generated from?
 *
 * - cloze card: its cloze id must still appear in the Rem's text.
 * - forward / backward card: the Rem must still have a back side.
 *
 * `null` means we cannot tell (unknown card type, or context not resolved).
 * This is the signal that separates a card the user switched off ONE AT A TIME
 * in the queue — markup intact, card simply not surfaced — from a card whose
 * cloze or descriptor was edited away.
 */
export function markupStillPresent(
  ctx: Pick<RemContext, 'clozeIds' | 'hasBackText'>,
  cardType: string,
  clozeId: string | null,
): boolean | null {
  if (cardType === 'cloze') {
    if (!clozeId) return null;
    return ctx.clozeIds.includes(clozeId);
  }
  if (cardType === 'forward' || cardType === 'backward') return ctx.hasBackText;
  return null;
}

/**
 * Is this card's practice direction currently enabled on the Rem?
 *
 * Only meaningful for forward / backward cards — cloze cards are independent of
 * the practice direction and are governed per card.
 *
 * Measured: disabling a DIRECTION card in the queue does not just hide that
 * card, it rewrites the Rem's practice direction ('both' → 'forward' when the
 * backward card is switched off). So unlike a disabled cloze, a disabled
 * direction DOES leave a Rem-level trace — and the way back is
 * `setPracticeDirection`, not a per-card action.
 */
export function directionEnabled(
  practiceDirection: RemContext['practiceDirection'],
  cardType: string,
): boolean | null {
  if (cardType !== 'forward' && cardType !== 'backward') return null;
  if (practiceDirection === null) return null;
  if (practiceDirection === 'both') return true;
  return practiceDirection === cardType;
}

/** Extra per-Rem context, resolved only for the capped anomaly set. */
export interface RemContext {
  text: string;
  /**
   * `rem.getEnablePractice()` — RemNote's own answer to "does this Rem generate
   * flashcards for the queue?". This is the per-Rem "Enable Cards" toggle in the
   * flashcard menu, and the signal that distinguishes a card the user switched
   * off from one the Rem genuinely no longer produces.
   */
  enablePractice: boolean | null;
  /** `rem.getPracticeDirection()` — the Rem's enabled practice directions. */
  practiceDirection: 'forward' | 'backward' | 'none' | 'both' | null;
  /** The Rem itself carries the built-in Disable Cards powerup. */
  disableCardsOwn: boolean;
  /** An ancestor carries Disable Cards, which suppresses the whole subtree. */
  disableCardsAncestor: boolean;
  /** Nearest such ancestor — the Rem to untag to re-enable the subtree. */
  disablingAncestorId: string | null;
  /** Cloze ids the Rem's text currently defines. */
  clozeIds: string[];
  /** Whether the Rem still has a back side (what a forward/backward card needs). */
  hasBackText: boolean;
  /** Rendered back side, for showing the Rem as `front → back`. */
  backText: string;
  /** The visible words inside each cloze the Rem currently defines. */
  clozeTexts: string[];
  /** The Rem is itself a table. */
  isTableOwn: boolean;
  /** The Rem is a row or cell inside a table. */
  inTable: boolean;
  /** Cards this Rem reports through `rem.getCards()`. A value BELOW the number
   *  of cards `card.getAll()` returned for the same Rem means at least one
   *  practice direction is disabled — RemNote drops disabled directions from
   *  `rem.getCards()` while `card.getAll()` still returns them. */
  cardsViaGetCards: number | null;
  /** True when an ancestor carries the Deck powerup with Status = "Paused". */
  inPausedDocument: boolean;
  /** True when the Rem itself is missing (deleted / not resolvable). */
  missing: boolean;
}

/**
 * Why an unscheduled card is unscheduled.
 *
 * Important: `rem.getCards()` returning 0 does NOT mean the card record is
 * junk. RemNote drops DISABLED cards from `rem.getCards()` while `card.getAll()`
 * still returns them, so a card the user deliberately switched off looks
 * identical to one whose Rem no longer produces it. Only `getEnablePractice()`,
 * the practice direction and the ancestor tag can tell those apart, which is
 * why `no-cards-generated` is the last resort here, not the first guess.
 */
export type UnscheduledCause =
  | 'paused-document'
  | 'cards-disabled-ancestor'
  | 'cards-disabled-rem'
  | 'cards-disabled-table'
  | 'direction-disabled'
  | 'card-disabled-individually'
  | 'markup-removed'
  | 'not-surfaced-unknown'
  | 'rem-missing'
  | 'unresolved';

/**
 * Column headers for the bucket × cause matrix. Distinct within 13 characters —
 * truncating the slugs collided `cards-disabled-rem` with `cards-disabled-ancestor`.
 */
export const UNSCHEDULED_CAUSE_SHORT: Record<UnscheduledCause, string> = {
  'paused-document': 'paused-deck',
  'cards-disabled-ancestor': 'off-ancestor',
  'cards-disabled-rem': 'off-rem',
  'cards-disabled-table': 'table',
  'direction-disabled': 'dir-off',
  'card-disabled-individually': 'off-card',
  'markup-removed': 'markup-gone',
  'not-surfaced-unknown': 'unknown',
  'rem-missing': 'rem-missing',
  unresolved: 'unresolved',
};

export const UNSCHEDULED_CAUSE_LABELS: Record<UnscheduledCause, string> = {
  'paused-document': 'Inside a paused deck',
  'cards-disabled-ancestor': 'Disabled by an ancestor’s “Disable Descendant Cards”',
  'cards-disabled-rem': 'Cards switched off on the Rem itself — worth investigating',
  'cards-disabled-table':
    'Part of a table — RemNote ships table rows and cells with cards off',
  'direction-disabled': 'This direction is switched off on the Rem',
  'card-disabled-individually': 'Switched off card by card (markup still present)',
  'markup-removed': 'The cloze / back side this card came from is gone',
  'not-surfaced-unknown': 'Not surfaced — cause undetermined',
  'rem-missing': 'Owning Rem not found',
  unresolved: 'Not resolved (outside the Rem-context cap)',
};

/**
 * What the USER can do about each cause — and, where nothing this plugin owns
 * can do it, who can.
 *
 * The distinction matters most for `card-disabled-individually`. That cause is
 * RemNote's `dci` list (see `derivedDisabledClozeIds`), which no plugin can
 * write: the rem bridge has no cloze accessor and no generic document write, so
 * `setEnablePractice` / `setPracticeDirection` — the only enablement levers a
 * plugin has — leave it untouched. RemNote's own "Enable Cards" command has the
 * same blind spot: it writes `forget: false` and nothing else, so a Rem whose
 * clozes are all disabled stays cardless after it. The way back is RemNote's
 * own `/Enable All Cloze Cards`, or clicking a greyed cloze and choosing
 * "Enable this card".
 */
export const UNSCHEDULED_CAUSE_REMEDY: Record<UnscheduledCause, string> = {
  'paused-document': 'Set the deck\u2019s Study Priority to something other than Paused.',
  'cards-disabled-ancestor':
    'Remove \u201cDisable Descendant Cards\u201d from the ancestor that carries it.',
  'cards-disabled-rem':
    'Switch cards back on for the Rem \u2014 the Card Enablement Audit does this in bulk.',
  'cards-disabled-table':
    'Table rows ship with cards off. Enable them per Rem only if you meant the table to be practised.',
  'direction-disabled':
    'Set the practice direction on the Rem \u2014 the Card Enablement Audit does this in bulk.',
  'card-disabled-individually':
    'Only RemNote can undo this: run /Enable All Cloze Cards on the Rem, or click the greyed cloze and choose \u201cEnable this card\u201d. No plugin can write the disabled-cloze list.',
  'markup-removed': 'Nothing to re-enable \u2014 the cloze or back side is gone. Delete the card record or restore the markup.',
  'not-surfaced-unknown': 'Cause undetermined. Run the single-Rem enablement probe on one of these Rems.',
  'rem-missing': 'The owning Rem is gone; the card record is an orphan.',
  unresolved: 'Outside the Rem-context cap \u2014 narrow the scope and recompute.',
};

/**
 * Classify one unscheduled card, most actionable cause first. `remCardsInPopulation`
 * is how many cards `card.getAll()` returned for the Rem; `cardsViaGetCards` is how
 * many the Rem still surfaces.
 */
export function classifyUnscheduled(
  ctx: RemContext | undefined,
  card: Pick<CardAnalyticsRow, 'cardType' | 'clozeId'> & { inPausedDeck?: boolean },
): UnscheduledCause {
  // The paused-deck scan is authoritative and covers cards the per-Rem ancestor
  // walk never reaches, so it is checked before anything else — including before
  // the `ctx` guard, since a paused card needs no Rem context to be explained.
  if (card.inPausedDeck) return 'paused-document';
  if (!ctx) return 'unresolved';
  if (ctx.missing) return 'rem-missing';
  // Rem-wide suppressions next: they explain every card on the Rem at once.
  if (ctx.inPausedDocument) return 'paused-document';
  if (ctx.disableCardsAncestor) return 'cards-disabled-ancestor';
  if (ctx.disableCardsOwn || ctx.enablePractice === false) {
    // A table's rows and cells come with cards switched off out of the box, so
    // they are not a decision anyone made and are not worth investigating.
    // Split them out, or they drown the Rems that WERE switched off on purpose.
    return ctx.isTableOwn || ctx.inTable ? 'cards-disabled-table' : 'cards-disabled-rem';
  }
  // Forward / backward cards are governed by the Rem's practice direction, and
  // switching one off in the queue rewrites that direction. Cloze cards are NOT
  // affected by it, so this test is scoped to direction cards only.
  if (directionEnabled(ctx.practiceDirection, card.cardType) === false) {
    return 'direction-disabled';
  }
  // Rem is enabled and this card's direction (if any) is on, so this is about
  // THIS card. Its markup decides: still in the text ⇒ the user switched this
  // one card off in the queue; gone ⇒ the Rem no longer produces it. Card counts
  // cannot separate these — a Rem whose cards were all individually disabled
  // reports zero from getCards(), exactly like a Rem whose markup was deleted.
  const present = markupStillPresent(ctx, card.cardType, card.clozeId);
  if (present === true) return 'card-disabled-individually';
  if (present === false) return 'markup-removed';
  return 'not-surfaced-unknown';
}

export interface ExportSummary {
  totalCards: number;
  /** Cards counted as New by the table (no gradeable rep in the effective history). */
  newCards: number;
  /** Cards whose nextRepetitionTime has passed, INCLUDING suppressed ones. */
  dueCards: number;
  /** Due cards RemNote would actually serve — paused decks excluded. */
  dueServable: number;
  /** Due-by-date cards inside a paused deck: real due dates, never served. */
  duePaused: number;
  /** The interesting cell: New but NOT due — invisible to the queue and to the PRD. */
  newNotDue: number;
  /** Of `newNotDue`, how many have no `nextRepetitionTime` at all. */
  newUnscheduled: number;
  /** Of `newNotDue`, how many are scheduled into the future. */
  newScheduledAhead: number;
  /** Non-new cards with no `nextRepetitionTime` — practised once, now parked. */
  reviewedUnscheduled: number;
  /** New-but-not-due cards whose history is non-empty (skipped / reset, never graded). */
  newWithSomeHistory: number;
  /** Every unscheduled card (New or reviewed) — the queue can reach none of them. */
  unscheduledTotal: number;
  /** Cards suppressed by a paused deck. They keep a real nextRepetitionTime, so
   *  they are NOT part of `unscheduledTotal` unless they are also unscheduled. */
  pausedTotal: number;
  /** False when no paused-deck scan was applied — paused counts then mean
   *  "not looked at", not "none". */
  pausedScanApplied: boolean;
  /** Unscheduled cards by cause, most common first. Requires resolved Rem context. */
  causes: Array<{ cause: UnscheduledCause; label: string; cards: number; newCards: number }>;
  /** Per-bucket version of the same matrix, in table order. */
  perBucket: Array<{
    bucket: string;
    cards: number;
    newCards: number;
    dueCards: number;
    newNotDue: number;
    newUnscheduled: number;
    newScheduledAhead: number;
    /** Due cards this bucket would actually serve. */
    dueServable: number;
    /** Due-by-date cards suppressed by a paused deck. */
    duePaused: number;
    /** Cards in this bucket inside a paused deck, due or not. */
    paused: number;
    /** Unscheduled cards in this bucket by cause — which lever applies where. */
    causeCounts: Partial<Record<UnscheduledCause, number>>;
  }>;
}

/** Rollup of one Rem's cards inside the analysed population. */
interface RemRollup {
  cards: number;
  unscheduled: number;
  due: number;
  newCards: number;
}

function rollupByRem(rows: CardAnalyticsRow[]): Map<string, RemRollup> {
  const map = new Map<string, RemRollup>();
  for (const r of rows) {
    let e = map.get(r.remId);
    if (!e) {
      e = { cards: 0, unscheduled: 0, due: 0, newCards: 0 };
      map.set(r.remId, e);
    }
    e.cards++;
    if (r.scheduleState === 'unscheduled') e.unscheduled++;
    if (r.isDue) e.due++;
    if (r.isNew) e.newCards++;
  }
  return map;
}

export function summarizeRows(
  rows: CardAnalyticsRow[],
  context?: Map<string, RemContext>,
  pausedScanApplied = false,
): ExportSummary {
  const rollups = rollupByRem(rows);
  const causeCounts = new Map<UnscheduledCause, { cards: number; newCards: number }>();
  const perBucketMap = new Map<string, ExportSummary['perBucket'][number]>();
  const summary: ExportSummary = {
    totalCards: rows.length,
    newCards: 0,
    dueCards: 0,
    dueServable: 0,
    duePaused: 0,
    newNotDue: 0,
    newUnscheduled: 0,
    newScheduledAhead: 0,
    reviewedUnscheduled: 0,
    newWithSomeHistory: 0,
    unscheduledTotal: 0,
    pausedTotal: 0,
    pausedScanApplied,
    causes: [],
    perBucket: [],
  };

  for (const r of rows) {
    let b = perBucketMap.get(r.bucket);
    if (!b) {
      b = {
        bucket: r.bucket,
        cards: 0,
        newCards: 0,
        dueCards: 0,
        newNotDue: 0,
        newUnscheduled: 0,
        newScheduledAhead: 0,
        dueServable: 0,
        duePaused: 0,
        paused: 0,
        causeCounts: {},
      };
      perBucketMap.set(r.bucket, b);
    }
    b.cards++;
    if (r.isNew) {
      summary.newCards++;
      b.newCards++;
    }
    if (r.isDue) {
      summary.dueCards++;
      b.dueCards++;
      if (r.inPausedDeck) {
        summary.duePaused++;
        b.duePaused++;
      } else {
        summary.dueServable++;
        b.dueServable++;
      }
    }
    if (r.isNew && !r.isDue) {
      summary.newNotDue++;
      b.newNotDue++;
      if (r.scheduleState === 'unscheduled') {
        summary.newUnscheduled++;
        b.newUnscheduled++;
      } else {
        summary.newScheduledAhead++;
        b.newScheduledAhead++;
      }
      if (r.historyEntries > 0) summary.newWithSomeHistory++;
    }
    if (!r.isNew && r.scheduleState === 'unscheduled') summary.reviewedUnscheduled++;

    if (r.inPausedDeck) {
      summary.pausedTotal++;
      b.paused++;
    }

    // A paused card is suppressed whether or not it also lacks a next time, so
    // it belongs in the cause breakdown either way.
    if (r.scheduleState === 'unscheduled' || r.inPausedDeck) {
      if (r.scheduleState === 'unscheduled') summary.unscheduledTotal++;
      const cause = classifyUnscheduled(context?.get(r.remId), r);
      const entry = causeCounts.get(cause) ?? { cards: 0, newCards: 0 };
      entry.cards++;
      if (r.isNew) entry.newCards++;
      causeCounts.set(cause, entry);
      b.causeCounts[cause] = (b.causeCounts[cause] ?? 0) + 1;
    }
  }

  summary.causes = Array.from(causeCounts.entries())
    .map(([cause, v]) => ({ cause, label: UNSCHEDULED_CAUSE_LABELS[cause], ...v }))
    .sort((a, b) => b.cards - a.cards);

  // Numeric bucket order ("0-10%" … "90-100%") rather than insertion order.
  summary.perBucket = Array.from(perBucketMap.values()).sort(
    (a, b) => parseInt(a.bucket, 10) - parseInt(b.bucket, 10),
  );
  return summary;
}

interface AncestorFacts {
  /** Nearest Deck ancestor has Status = "Paused". */
  paused: boolean;
  /** Some ancestor carries the Disable Cards powerup ("Disable Descendant Cards"). */
  disableCards: boolean;
  /** Id of the nearest ancestor carrying it — what the user has to go and untag. */
  disablingAncestorId: string | null;
  /** An ancestor is a table: this Rem is a row or a cell inside one. */
  inTable: boolean;
}

/**
 * Walks the ancestor chain once, collecting both facts that can silence a
 * Rem's cards from above: a paused Deck, and an inherited "Disable Descendant
 * Cards" tag. `card.getAll()` returns cards in both states, so the walk is the
 * only way to see them.
 *
 * Results are memoized per ancestor, since siblings share chains and a few
 * thousand un-memoized walks saturate the plugin IPC bridge. The memo stores,
 * for each node, the facts of the chain *from that node upward* — so the walk
 * collects each node's own flags first and then folds top-down. Folding matters:
 * a tag found near the leaf must not be attributed to the ancestors above it,
 * and a cache hit higher up must not erase a tag already found below it.
 */
async function ancestorFacts(rem: any, cache: Map<string, AncestorFacts>): Promise<AncestorFacts> {
  const chain: Array<{
    id: string;
    ownDisable: boolean;
    ownDeckPaused: boolean | null;
    ownIsTable: boolean;
  }> = [];
  let cursor = await rem.getParentRem();
  let hops = 0;
  let base: AncestorFacts = {
    paused: false,
    disableCards: false,
    disablingAncestorId: null,
    inTable: false,
  };

  while (cursor && hops < 64) {
    const cached = cache.get(cursor._id);
    if (cached) {
      base = cached;
      break;
    }
    const [ownDisable, isDeck, ownIsTable] = await Promise.all([
      cursor.hasPowerup(BuiltInPowerupCodes.DisableCards),
      cursor.hasPowerup(BuiltInPowerupCodes.Deck),
      // A table's rows and cells are Rems under the table Rem, and RemNote
      // ships them with cards switched off. Without this, every cell in every
      // table lands in the same bucket as a card the user deliberately disabled.
      cursor.isTable().catch(() => false),
    ]);
    let ownDeckPaused: boolean | null = null;
    if (isDeck) {
      const status = await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
      ownDeckPaused = status === 'Paused';
    }
    chain.push({ id: cursor._id, ownDisable: !!ownDisable, ownDeckPaused, ownIsTable: !!ownIsTable });
    cursor = await cursor.getParentRem();
    hops++;
  }

  // Fold from the top of the walked chain back down, memoizing each node.
  let acc = base;
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    acc = {
      disableCards: acc.disableCards || node.ownDisable,
      // Nearest Deck wins — a paused sub-deck under an active one is paused,
      // and an active sub-deck under a paused one is not.
      paused: node.ownDeckPaused !== null ? node.ownDeckPaused : acc.paused,
      disablingAncestorId: node.ownDisable ? node.id : acc.disablingAncestorId,
      inTable: acc.inTable || node.ownIsTable,
    };
    cache.set(node.id, acc);
  }
  return acc;
}

/**
 * Resolve Rem context for every Rem that owns at least one UNSCHEDULED card —
 * the cards with no `nextRepetitionTime`, whatever their New/reviewed status.
 * Those are precisely the cards the queue and the Priority Review Document can
 * never surface, so they are the ones worth the IPC cost. Most important
 * (lowest priority number) first, capped at `maxRems`.
 */
export async function resolveAnomalyRemContext(
  plugin: RNPlugin,
  rows: CardAnalyticsRow[],
  maxRems: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, RemContext>> {
  const byRem = new Map<string, number>(); // remId -> best (lowest) priority
  for (const r of rows) {
    if (r.scheduleState !== 'unscheduled') continue;
    const prev = byRem.get(r.remId);
    if (prev === undefined || r.priority < prev) byRem.set(r.remId, r.priority);
  }
  const targets = Array.from(byRem.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, maxRems)
    .map(([remId]) => remId);

  const missingContext = (): RemContext => ({
    text: '',
    enablePractice: null,
    practiceDirection: null,
    disableCardsOwn: false,
    disableCardsAncestor: false,
    disablingAncestorId: null,
    clozeIds: [],
    hasBackText: false,
    backText: '',
    clozeTexts: [],
    isTableOwn: false,
    inTable: false,
    cardsViaGetCards: null,
    inPausedDocument: false,
    missing: true,
  });

  const out = new Map<string, RemContext>();
  const ancestorCache = new Map<string, AncestorFacts>();
  for (let i = 0; i < targets.length; i++) {
    const remId = targets[i];
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        out.set(remId, missingContext());
      } else {
        const [text, cards, enablePractice, direction, disableOwn, isTableOwn, ancestors] =
          await Promise.all([
          safeRemTextToString(plugin, rem.text),
          rem.getCards().catch(() => null),
          rem.getEnablePractice().catch(() => null),
          rem.getPracticeDirection().catch(() => null),
          rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
          rem.isTable().catch(() => false),
          ancestorFacts(rem, ancestorCache).catch(
            (): AncestorFacts => ({
              paused: false,
              disableCards: false,
              disablingAncestorId: null,
              inTable: false,
            }),
          ),
        ]);
        out.set(remId, {
          text,
          enablePractice: enablePractice as boolean | null,
          practiceDirection: direction as RemContext['practiceDirection'],
          disableCardsOwn: !!disableOwn,
          disableCardsAncestor: ancestors.disableCards,
          disablingAncestorId: ancestors.disablingAncestorId,
          clozeIds: Array.from(collectClozeIds(rem.text)),
          hasBackText: Array.isArray(rem.backText) && rem.backText.length > 0,
          backText:
            Array.isArray(rem.backText) && rem.backText.length > 0
              ? await safeRemTextToString(plugin, rem.backText)
              : '',
          clozeTexts: collectClozeTexts(rem.text),
          isTableOwn: !!isTableOwn,
          inTable: ancestors.inTable,
          cardsViaGetCards: cards ? cards.length : null,
          inPausedDocument: ancestors.paused,
          missing: false,
        });
      }
    } catch {
      out.set(remId, missingContext());
    }
    if (onProgress && (i + 1) % 25 === 0) {
      onProgress(i + 1, targets.length);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (onProgress) onProgress(targets.length, targets.length);
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function iso(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

const CSV_COLUMNS = [
  'cardId',
  'remId',
  'cardType',
  'priority',
  'percentile',
  'bucket',
  'isNew',
  'isDue',
  'isStale',
  'scheduleState',
  'nextRepetitionTime',
  'nextRepetitionTimeMs',
  'createdAt',
  'historyEntries',
  'gradeableRepsLifetime',
  'gradeableRepsEffective',
  'nonGradeableInteractions',
  'hasReset',
  'lastScore',
  'lastInteractionDate',
  'remCardsInPopulation',
  'remCardsUnscheduled',
  'remCardsDue',
  'remCardsNew',
  'remCardsViaGetCards',
  'remEnablePractice',
  'remPracticeDirection',
  'remDisableCardsOwn',
  'remDisableCardsAncestor',
  'remDisablingAncestorId',
  'remInPausedDocument',
  'remIsTable',
  'remInTable',
  'inPausedDeck',
  'clozeId',
  'markupStillPresent',
  'directionEnabled',
  'unscheduledCause',
  'remText',
] as const;

/**
 * Serialize every row, joining in the per-Rem rollups and whatever Rem context
 * was resolved. Context columns stay blank for Rems outside the resolved cap.
 */
export function rowsToCsv(rows: CardAnalyticsRow[], context: Map<string, RemContext>): string {
  const rollups = rollupByRem(rows);
  const lines: string[] = [CSV_COLUMNS.join(',')];

  for (const r of rows) {
    const roll = rollups.get(r.remId)!;
    const ctx = context.get(r.remId);
    const cause =
      r.scheduleState === 'unscheduled' || r.inPausedDeck ? classifyUnscheduled(ctx, r) : '';
    const markup = ctx ? markupStillPresent(ctx, r.cardType, r.clozeId) : null;
    const dirEnabled = ctx ? directionEnabled(ctx.practiceDirection, r.cardType) : null;
    lines.push(
      [
        r.cardId,
        r.remId,
        r.cardType,
        r.priority,
        r.percentile.toFixed(3),
        r.bucket,
        r.isNew,
        r.isDue,
        r.isStale,
        r.scheduleState,
        iso(r.nextRepetitionTime),
        r.nextRepetitionTime ?? '',
        iso(r.createdAt),
        r.historyEntries,
        r.gradeableRepsLifetime,
        r.gradeableRepsEffective,
        r.nonGradeableInteractions,
        r.hasReset,
        r.lastScore ?? '',
        iso(r.lastInteractionDate),
        roll.cards,
        roll.unscheduled,
        roll.due,
        roll.newCards,
        ctx?.cardsViaGetCards ?? '',
        ctx && ctx.enablePractice !== null ? ctx.enablePractice : '',
        ctx?.practiceDirection ?? '',
        ctx && !ctx.missing ? ctx.disableCardsOwn : '',
        ctx && !ctx.missing ? ctx.disableCardsAncestor : '',
        ctx?.disablingAncestorId ?? '',
        ctx ? ctx.inPausedDocument : '',
        ctx && !ctx.missing ? ctx.isTableOwn : '',
        ctx && !ctx.missing ? ctx.inTable : '',
        r.inPausedDeck,
        r.clozeId ?? '',
        markup === null ? '' : markup,
        dirEnabled === null ? '' : dirEnabled,
        cause,
        ctx?.text ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

/** Human-readable diagnosis, mirrored into the console and the download. */
export function summaryToText(summary: ExportSummary, meta: string): string {
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
  const lines = [
    `Card analytics export — ${meta}`,
    ``,
    `Cards analysed:              ${summary.totalCards.toLocaleString()}`,
    `New (no gradeable rep):      ${summary.newCards.toLocaleString()} (${pct(summary.newCards, summary.totalCards)})`,
    `Due — servable:              ${summary.dueServable.toLocaleString()}  ← what the queue can actually show you`,
    `Due — by date, but paused:   ${summary.duePaused.toLocaleString()}  (real due dates inside a paused deck)`,
    `Due — raw total:             ${summary.dueCards.toLocaleString()}`,
    ``,
    `New AND NOT due:             ${summary.newNotDue.toLocaleString()}`,
    `  · no nextRepetitionTime:   ${summary.newUnscheduled.toLocaleString()}  ← unreachable by the queue and the Priority Review Document`,
    `  · scheduled into future:   ${summary.newScheduledAhead.toLocaleString()}`,
    `  · with some history:       ${summary.newWithSomeHistory.toLocaleString()}  (interacted with, never graded: skipped / reset)`,
    ``,
    `Reviewed but unscheduled:    ${summary.reviewedUnscheduled.toLocaleString()}`,
    ``,
    summary.pausedScanApplied
      ? `In a paused deck:            ${summary.pausedTotal.toLocaleString()} (${pct(summary.pausedTotal, summary.totalCards)}) — schedulable, but the queue will not serve them`
      : `In a paused deck:            not scanned this session (run the paused-deck scan; without it these count as due)`,
    ``,
    `All suppressed cards:        ${(summary.unscheduledTotal + summary.pausedTotal).toLocaleString()} — by cause:`,
    ...summary.causes.map(
      (c) =>
        `  · ${c.label.padEnd(52)} ${String(c.cards).padStart(6)}  (${c.newCards.toLocaleString()} of them New)`,
    ),
    ``,
    ...(summary.causes.length > 0
      ? [
          `Suppressed by bucket × cause:`,
          [
            'bucket'.padEnd(12),
            ...summary.causes.map((c) => UNSCHEDULED_CAUSE_SHORT[c.cause].padStart(13)),
          ].join(' '),
          ...summary.perBucket.map((b) =>
            [
              b.bucket.padEnd(12),
              ...summary.causes.map((c) => String(b.causeCounts[c.cause] ?? 0).padStart(13)),
            ].join(' '),
          ),
          [
            'TOTAL'.padEnd(12),
            ...summary.causes.map((c) => String(c.cards).padStart(13)),
          ].join(' '),
          ``,
        ]
      : []),
    `Per bucket ("due" = servable; paused cards are counted under paused, not due):`,
    `bucket        cards     new  paused     due  duePaused  new&notDue  newUnsched  newAhead`,
    ...summary.perBucket.map((b) =>
      [
        b.bucket.padEnd(12),
        String(b.cards).padStart(6),
        String(b.newCards).padStart(7),
        String(b.paused).padStart(7),
        String(b.dueServable).padStart(7),
        String(b.duePaused).padStart(10),
        String(b.newNotDue).padStart(11),
        String(b.newUnscheduled).padStart(11),
        String(b.newScheduledAhead).padStart(9),
      ].join(' '),
    ),
  ];
  return lines.join('\n');
}

/** Trigger a browser download of `content` under `filename`. */
export function downloadText(content: string, filename: string, mime = 'text/csv') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// --- Single-Rem enablement probe ------------------------------------------
//
// The export classifies thousands of cards from a handful of signals; this
// prints every one of those signals for ONE Rem so the classification can be
// checked against what RemNote's own UI says about it. Read-only.

export interface RemEnablementProbe {
  remId: string;
  text: string;
  /** RemNote's own "does this Rem generate flashcards" answer. */
  enablePractice: boolean | null;
  practiceDirection: string | null;
  /** Cards the Rem surfaces — disabled cards are NOT included here. */
  cardsViaGetCards: number;
  /** Card records that exist for this Rem in the card table. */
  cardsViaGetAll: number;
  disableCardsOwn: boolean;
  /** Cloze ids the Rem's text currently defines. */
  clozeIds: string[];
  /**
   * Cloze ids proven to sit in RemNote's `dci` (disabled) list — derived, since
   * the field itself never reaches a plugin. See `derivedDisabledClozeIds`.
   */
  disabledClozeIds: string[];
  /**
   * Every cloze the Rem defines is switched off. This is the state
   * `/Disable All Cloze Cards` leaves behind — it is not a distinct flag, just
   * a full `dci` list, which is why nothing else here distinguishes it.
   */
  allClozesDisabled: boolean;
  /**
   * A Rem-wide cause (practice off, a disabling ancestor, a paused deck, a
   * table) is also suppressing this Rem's cards, so `disabledClozeIds` above
   * cannot be trusted: those causes drop EVERY card from `rem.getCards()`, which
   * makes every cloze look individually switched off. When this is true the list
   * is a lower bound at best — clear the Rem-wide cause and probe again.
   */
  clozeReadingMaskedByRemWideCause: boolean;
  hasBackText: boolean;
  /** The Rem is a table, or sits inside one — tables ship with cards off. */
  isTableOwn: boolean;
  inTable: boolean;
  /** Raw keys on the card object — used to look for undocumented state (e.g. a
   *  surviving `nextTime` next to a nulled `activeNextTime`). */
  rawCardKeys: string[];
  /** Ancestor chain, nearest first, with the flags that silence a subtree. */
  ancestors: Array<{
    remId: string;
    text: string;
    disableCards: boolean;
    deckStatus: string | null;
    isTable: boolean;
  }>;
  cards: Array<{
    cardId: string;
    type: string;
    inGetCards: boolean;
    nextRepetitionTime: string;
    reps: number;
    /** For clozes, the card's cloze id. */
    clozeId: string;
    /** Is this card's markup still in the Rem? The individually-disabled test. */
    markupStillPresent: boolean | null;
    /** For forward/backward cards: is that direction still on? null for clozes. */
    directionEnabled: boolean | null;
    /** What the export would call this card if it were unscheduled. */
    wouldClassifyAs: string;
  }>;
}

export async function probeRemCardEnablement(
  plugin: RNPlugin,
  remId: string,
): Promise<RemEnablementProbe | null> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const [
    text,
    viaGetCards,
    enablePractice,
    practiceDirection,
    disableCardsOwn,
    isTableOwn,
    allCards,
  ] = await Promise.all([
    safeRemTextToString(plugin, rem.text),
    rem.getCards().catch(() => [] as any[]),
    rem.getEnablePractice().catch(() => null),
    rem.getPracticeDirection().catch(() => null),
    rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
    rem.isTable().catch(() => false),
    plugin.card.getAll(),
  ]);

  const surfacedIds = new Set(viaGetCards.map((c: any) => c._id));
  const owned = (allCards || []).filter((c: any) => c.remId === remId);
  const clozeIds = Array.from(collectClozeIds(rem.text));
  const hasBackText = Array.isArray(rem.backText) && rem.backText.length > 0;
  // Reported raw, without ruling out the Rem-wide causes first: this is a
  // diagnostic dump, and seeing "every cloze looks off" NEXT TO a disabling
  // ancestor is exactly the comparison the probe exists to make. The audit's
  // verdict, which has to pick one cause, does gate it.
  const disabledClozeIds = derivedDisabledClozeIds(clozeIds, owned, viaGetCards);

  const ancestors: RemEnablementProbe['ancestors'] = [];
  let cursor = await rem.getParentRem();
  let hops = 0;
  while (cursor && hops < 64) {
    const [disableCards, isDeck, isTable, aText] = await Promise.all([
      cursor.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
      cursor.hasPowerup(BuiltInPowerupCodes.Deck).catch(() => false),
      cursor.isTable().catch(() => false),
      safeRemTextToString(plugin, cursor.text),
    ]);
    let deckStatus: string | null = null;
    if (isDeck) {
      deckStatus =
        ((await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status')) as string) ?? null;
    }
    ancestors.push({
      remId: cursor._id,
      text: aText,
      disableCards: !!disableCards,
      deckStatus,
      isTable: !!isTable,
    });
    cursor = await cursor.getParentRem();
    hops++;
  }

  const probeCtx: RemContext = {
    text,
    enablePractice: enablePractice as boolean | null,
    practiceDirection: practiceDirection as RemContext['practiceDirection'],
    disableCardsOwn: !!disableCardsOwn,
    disableCardsAncestor: ancestors.some((a) => a.disableCards),
    disablingAncestorId: ancestors.find((a) => a.disableCards)?.remId ?? null,
    clozeIds,
    hasBackText,
    backText: '',
    clozeTexts: [],
    isTableOwn,
    inTable: ancestors.some((a) => a.isTable),
    cardsViaGetCards: viaGetCards.length,
    inPausedDocument: ancestors.some((a) => a.deckStatus === 'Paused'),
    missing: false,
  };

  return {
    remId,
    text,
    enablePractice: enablePractice as boolean | null,
    practiceDirection: practiceDirection as string | null,
    cardsViaGetCards: viaGetCards.length,
    cardsViaGetAll: owned.length,
    disableCardsOwn: !!disableCardsOwn,
    clozeIds,
    disabledClozeIds,
    allClozesDisabled: clozeIds.length > 0 && disabledClozeIds.length === clozeIds.length,
    clozeReadingMaskedByRemWideCause:
      enablePractice === false ||
      !!disableCardsOwn ||
      !!isTableOwn ||
      ancestors.some((a) => a.disableCards || a.isTable || a.deckStatus === 'Paused'),
    hasBackText,
    isTableOwn: !!isTableOwn,
    inTable: ancestors.some((a) => a.isTable),
    rawCardKeys: owned.length > 0 ? Object.keys(owned[0]) : [],
    ancestors,
    cards: owned.map((c: any) => {
      const clozeId = clozeIdOfCard(c);
      const cardType = clozeId ? 'cloze' : String(c.type);
      return {
        cardId: c._id,
        type: clozeId ? `cloze:${clozeId}` : cardType,
        inGetCards: surfacedIds.has(c._id),
        nextRepetitionTime: c.nextRepetitionTime
          ? new Date(c.nextRepetitionTime).toISOString()
          : '(null)',
        reps: c.repetitionHistory?.length ?? 0,
        clozeId: clozeId ?? '',
        markupStillPresent: markupStillPresent(probeCtx, cardType, clozeId),
        directionEnabled: directionEnabled(probeCtx.practiceDirection, cardType),
        // A cause only means something for an UNSCHEDULED card. A card with a
        // real nextRepetitionTime is simply scheduled; running the classifier
        // on it would report the cause it WOULD have, which reads as a verdict.
        wouldClassifyAs: c.nextRepetitionTime
          ? '(scheduled — n/a)'
          : classifyUnscheduled(probeCtx, { cardType, clozeId }),
      };
    }),
  };
}


// --- Single-card ownership probe ------------------------------------------
//
// Everything in this file attributes a card to `card.remId`. The SDK documents
// that field as "the Rem this card was generated from", and every per-Rem
// verdict here — the markup check above included — is only valid if that is
// literally true. This probe tests it against the SDK's own resolution,
// `card.getRem()`, for one card. If the two disagree, per-Rem attribution is
// wrong and the causes derived from it cannot be trusted.

export interface CardOwnershipProbe {
  cardId: string;
  /** The raw field this codebase groups by. */
  remIdField: string;
  /** What the SDK itself resolves the card's Rem to. */
  getRemId: string | null;
  /** Do the two agree? False means our attribution is wrong. */
  agrees: boolean;
  cardType: string;
  clozeId: string | null;
  nextRepetitionTime: string;
  reps: number;
  /** Text of the Rem named by `card.remId`. */
  remIdFieldText: string;
  /** Cloze ids in that Rem's text, and whether this card's cloze is among them. */
  remIdFieldClozeIds: string[];
  markupPresentOnRemIdField: boolean | null;
  /** Same, for the Rem `getRem()` returned — only when the two differ. */
  getRemText: string | null;
  getRemClozeIds: string[] | null;
  markupPresentOnGetRem: boolean | null;
  /** Ancestors of the resolved Rem, nearest first. */
  ancestors: Array<{ remId: string; text: string }>;
}

export async function probeCardOwnership(
  plugin: RNPlugin,
  cardId: string,
): Promise<CardOwnershipProbe | null> {
  const card: any = await plugin.card.findOne(cardId);
  if (!card) return null;

  // `card.getRem()` can hand back a Rem object without its methods attached
  // (measured: `getParentRem is not a function`), so it is used only for its
  // `_id` — the identity question this probe exists to answer. Anything that
  // needs behaviour is re-fetched through `plugin.rem.findOne`, which always
  // returns a fully wired RemObject.
  const resolvedRaw: any = await card.getRem().catch(() => null);
  const resolvedId: string | null = resolvedRaw?._id ?? null;
  const resolvedRem: any = resolvedId
    ? await plugin.rem.findOne(resolvedId).catch(() => null)
    : null;
  const fieldRem: any = await plugin.rem.findOne(card.remId).catch(() => null);

  const cardType =
    card.type && typeof card.type === 'object' && 'clozeId' in card.type
      ? 'cloze'
      : String(card.type);
  const clozeId =
    card.type && typeof card.type === 'object' && 'clozeId' in card.type
      ? String(card.type.clozeId)
      : null;

  const fieldClozeIds = fieldRem ? Array.from(collectClozeIds(fieldRem.text)) : [];
  const fieldHasBack = !!(fieldRem && Array.isArray(fieldRem.backText) && fieldRem.backText.length);
  const agrees = resolvedId === card.remId;

  const ancestors: CardOwnershipProbe['ancestors'] = [];
  let cursor =
    resolvedRem && typeof resolvedRem.getParentRem === 'function'
      ? await resolvedRem.getParentRem().catch(() => null)
      : null;
  let hops = 0;
  while (cursor && hops < 24) {
    ancestors.push({ remId: cursor._id, text: await safeRemTextToString(plugin, cursor.text) });
    cursor =
      typeof cursor.getParentRem === 'function'
        ? await cursor.getParentRem().catch(() => null)
        : null;
    hops++;
  }

  let getRemText: string | null = null;
  let getRemClozeIds: string[] | null = null;
  let markupPresentOnGetRem: boolean | null = null;
  if (resolvedRem && !agrees) {
    getRemText = await safeRemTextToString(plugin, resolvedRem.text);
    getRemClozeIds = Array.from(collectClozeIds(resolvedRem.text));
    markupPresentOnGetRem = markupStillPresent(
      {
        clozeIds: getRemClozeIds,
        hasBackText: Array.isArray(resolvedRem.backText) && resolvedRem.backText.length > 0,
      },
      cardType,
      clozeId,
    );
  }

  return {
    cardId,
    remIdField: card.remId,
    getRemId: resolvedId,
    agrees,
    cardType,
    clozeId,
    nextRepetitionTime: card.nextRepetitionTime
      ? new Date(card.nextRepetitionTime).toISOString()
      : '(null)',
    reps: card.repetitionHistory?.length ?? 0,
    remIdFieldText: fieldRem ? await safeRemTextToString(plugin, fieldRem.text) : '(rem not found)',
    remIdFieldClozeIds: fieldClozeIds,
    markupPresentOnRemIdField: fieldRem
      ? markupStillPresent({ clozeIds: fieldClozeIds, hasBackText: fieldHasBack }, cardType, clozeId)
      : null,
    getRemText,
    getRemClozeIds,
    markupPresentOnGetRem,
    ancestors,
  };
}


// --- Suppression report: counts PLUS the Rems behind them ------------------
//
// `summarizeRows` answers "how many, and why". A user who wants to act on a
// cause needs "which Rems" — deduplicated, because one Rem can own several
// suppressed cards and re-enabling is a per-Rem action.

export interface SuppressedRemEntry {
  remId: string;
  /** Rendered front text. */
  text: string;
  /** Rendered back side, or '' — shown as `front → back`. */
  backText: string;
  /** The words inside this Rem's clozes, if any. */
  clozeTexts: string[];
  priority: number;
  bucket: string;
  cause: UnscheduledCause;
  /** How many of this Rem's cards are suppressed for this cause. */
  cards: number;
  /** How many of those have never been graded. */
  newCards: number;
  /** Whether the Rem is a table or sits in one — context for the user. */
  inTable: boolean;
}

export interface SuppressionReport {
  summary: ExportSummary;
  /** One entry per (bucket, cause, Rem). */
  entries: SuppressedRemEntry[];
  computedAt: number;
  pausedScanApplied: boolean;
}

export function buildSuppressionReport(
  rows: CardAnalyticsRow[],
  context: Map<string, RemContext>,
  pausedScanApplied: boolean,
): SuppressionReport {
  const summary = summarizeRows(rows, context, pausedScanApplied);
  const rollups = new Map<string, number>();
  for (const r of rows) rollups.set(r.remId, (rollups.get(r.remId) ?? 0) + 1);

  const byKey = new Map<string, SuppressedRemEntry>();
  for (const r of rows) {
    if (r.scheduleState !== 'unscheduled' && !r.inPausedDeck) continue;
    const ctx = context.get(r.remId);
    const cause = classifyUnscheduled(ctx, r);
    const key = `${r.bucket}|${cause}|${r.remId}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        remId: r.remId,
        text: ctx?.text ?? '(unresolved)',
        backText: ctx?.backText ?? '',
        clozeTexts: ctx?.clozeTexts ?? [],
        priority: r.priority,
        bucket: r.bucket,
        cause,
        cards: 0,
        newCards: 0,
        inTable: !!(ctx && (ctx.isTableOwn || ctx.inTable)),
      };
      byKey.set(key, entry);
    }
    entry.cards++;
    if (r.isNew) entry.newCards++;
  }

  return {
    summary,
    entries: Array.from(byKey.values()).sort((a, b) => a.priority - b.priority),
    computedAt: Date.now(),
    pausedScanApplied,
  };
}

/**
 * Turn practice back on for a set of Rems. Sequential — writes do not overlap
 * on the plugin bridge — and reported per Rem so a partial failure is visible
 * rather than silently folded into a success count.
 */
export async function reEnableRems(
  plugin: RNPlugin,
  remIds: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ enabled: number; failed: string[] }> {
  const failed: string[] = [];
  let enabled = 0;
  for (let i = 0; i < remIds.length; i++) {
    try {
      const rem = await plugin.rem.findOne(remIds[i]);
      if (!rem) {
        failed.push(remIds[i]);
      } else {
        await rem.setEnablePractice(true);
        enabled++;
      }
    } catch (e) {
      console.error('[reEnableRems] failed for', remIds[i], e);
      failed.push(remIds[i]);
    }
    if ((i + 1) % 10 === 0) onProgress?.(i + 1, remIds.length);
  }
  onProgress?.(remIds.length, remIds.length);
  return { enabled, failed };
}


// --- Verified Rems (synced) ----------------------------------------------
//
// Marking a Rem "checked" is a judgement the user makes once and should not
// have to repeat on another device, so it lives in SYNCED storage rather than
// session or local. It stores nothing but Rem ids — a few thousand of them sit
// far inside the per-key limit (see the synced-key budget helpers), and the
// actionable `cards-disabled-rem` set is a couple of hundred.

import { verifiedSuppressedRemsKey } from './consts';

export async function getVerifiedRems(plugin: RNPlugin): Promise<Set<string>> {
  try {
    const stored = await plugin.storage.getSynced<string[]>(verifiedSuppressedRemsKey);
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set();
  }
}

/** Add or remove one Rem from the verified set. Returns the updated set. */
export async function setRemVerified(
  plugin: RNPlugin,
  remId: string,
  verified: boolean,
): Promise<Set<string>> {
  const current = await getVerifiedRems(plugin);
  if (verified) current.add(remId);
  else current.delete(remId);
  await plugin.storage.setSynced(verifiedSuppressedRemsKey, Array.from(current));
  return current;
}

/** Bulk variant — one write for a whole selection. */
export async function setManyRemsVerified(
  plugin: RNPlugin,
  remIds: string[],
  verified: boolean,
): Promise<Set<string>> {
  const current = await getVerifiedRems(plugin);
  for (const id of remIds) {
    if (verified) current.add(id);
    else current.delete(id);
  }
  await plugin.storage.setSynced(verifiedSuppressedRemsKey, Array.from(current));
  return current;
}

/**
 * Is this Rem part of an Incremental Rem — itself, its parent or grandparent?
 *
 * An IncRem that has already been formulated into a card is expected to sit
 * with practice switched off until the user decides it is ready, so those Rems
 * are not oversights and should be visibly distinguishable from the ones that
 * are. Two hops up because the card is often on a child of the IncRem.
 */
export async function isIncRemNearby(plugin: RNPlugin, rem: any): Promise<boolean> {
  try {
    if (await rem.hasPowerup(INCREMENTAL_POWERUP_CODE)) return true;
    const parent = await rem.getParentRem();
    if (!parent) return false;
    if (await parent.hasPowerup(INCREMENTAL_POWERUP_CODE)) return true;
    const grandparent = await parent.getParentRem();
    if (!grandparent) return false;
    return await grandparent.hasPowerup(INCREMENTAL_POWERUP_CODE);
  } catch {
    return false;
  }
}
