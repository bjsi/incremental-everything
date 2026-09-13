import {
  BuiltInPowerupCodes,
  RemId,
  RemType,
  RichTextInterface,
  RNPlugin,
  RICH_TEXT_ELEMENT_TYPE,
  RICH_TEXT_FORMATTING,
} from '@remnote/plugin-sdk';
import { SuppressionLease } from './operation_suppression';
import { safeRemTextToString } from './pdfUtils';

/**
 * Finding — and deleting — the blank Rems left behind by an Anki import.
 *
 * Anki's "Extra"/"Back Extra" fields are HTML, and a paragraph break in HTML is
 * a structural element, not a character. An importer that maps that field onto
 * RemNote's Extra Card Detail powerup therefore turns every `<br>`/`</p>` into
 * its own child Rem, and the ones carrying no text land in the knowledge base as
 * Rems that hold literally nothing. They are invisible in the outline (an empty
 * bullet among the green ECD ones), but the queue has to name every item it
 * shows, so each one surfaces as "Unnamed" while reviewing.
 *
 * There is no way to find them from RemNote's own UI: search indexes text, and
 * these have none. This module walks the ECD powerup's membership instead, which
 * is the one list that is guaranteed to contain them.
 *
 * DELETION IS THE POINT HERE, so the bar for calling a Rem empty is set
 * deliberately high — see `classifyCandidate`. A Rem is a delete candidate only
 * when it has no text, no back text, no children, no other tag, nothing
 * referencing it, no flashcards, no sources and no aliases. Anything short of
 * that is reported as a skip with its reason rather than quietly deleted.
 */

/** What to walk: one Rem's subtree, or every ECD Rem in the knowledge base. */
export type EmptyEcdScope = { kind: 'rem'; remId: RemId } | { kind: 'kb' };

/**
 * Why a blank-looking Rem was kept.
 *
 * Every one of these is a way that deleting the Rem would destroy something the
 * blankness of its own text does not account for. They are reported as counts so
 * a run that deletes fewer Rems than expected can be explained rather than
 * guessed at.
 */
export type SkipReason =
  | 'isPortal'
  | 'isTable'
  | 'isTyped'
  | 'isStructural'
  | 'hasOtherPowerup'
  | 'hasChildren'
  | 'hasOtherTags'
  | 'isReferenced'
  | 'hasCards'
  | 'hasSources'
  | 'hasAliases'
  | 'unverified';

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  isPortal: 'are portals (no text of their own, but they display other Rems)',
  isTable: 'are tables, or a row or cell belonging to one',
  isTyped: 'are Concepts or Descriptors, not plain Rems',
  isStructural: 'are slots, powerup properties or documents',
  hasOtherPowerup:
    'carry another RemNote powerup (divider, embed, search portal, code block, uploaded file…)',
  hasChildren: 'have children (deleting would take the children too)',
  hasOtherTags: 'carry another tag or powerup besides Extra Card Detail',
  isReferenced: 'are referenced from somewhere else',
  hasCards: 'have flashcards of their own',
  hasSources: 'have a source attached',
  hasAliases: 'have an alias',
  unverified: 'could not be checked — a read failed (see the console)',
};

/** One delete candidate, with just enough context for the preview list. */
export interface EmptyEcdCandidate {
  remId: RemId;
  /** Where the blank sat. Recorded for the backup, so a deletion is traceable. */
  parentId: RemId | null;
  /** The parent Rem's text, so the user can see WHERE the blank sits. */
  parentText: string;
}

export interface EmptyEcdScanResult {
  /** Rems walked in the scope. */
  scanned: number;
  /** Of those, the ones whose own text and back text are blank. */
  blank: number;
  /** Of the blank ones, those carrying the Extra Card Detail powerup. */
  blankEcd: number;
  /** Blank Rems that passed every safety check — the deletion list. */
  candidates: EmptyEcdCandidate[];
  /** Blank-looking Rems that were kept, by reason. */
  skipped: Record<SkipReason, number>;
  /** A handful of candidates with parent context, for the confirmation dialog. */
  preview: EmptyEcdCandidate[];
  elapsedMs: number;
}

export interface EmptyEcdDeleteResult {
  deleted: number;
  failed: number;
  elapsedMs: number;
}

/** Progress callback: a human-readable line, plus counts once a phase starts. */
export type EmptyEcdProgress = (message: string, done?: number, total?: number) => void;

/**
 * How many candidates get parent context for the confirmation dialog.
 *
 * Resolving a parent is two round trips, so this is capped rather than done for
 * the whole list: the dialog only ever shows a sample, and on a large import the
 * list is in the thousands.
 */
const PREVIEW_SIZE = 8;

/** Progress cadence for the delete phase, where every step is a round trip. */
const PROGRESS_EVERY = 50;

/**
 * How often the blank-filter walk yields to the event loop.
 *
 * Without a yield the popup's progress line never repaints and the scan looks
 * hung. High on purpose: `setTimeout(0)` is clamped to ~4ms and far worse in a
 * throttled hidden frame, while the work between yields is sub-microsecond per
 * Rem. Same reasoning, and same value, as lib/image_scan.ts.
 */
const YIELD_EVERY = 5000;

/**
 * How many verification reads are kept in flight.
 *
 * Unlike tag WRITES — measured in lib/image_scan.ts to be strictly serialized by
 * RemNote, so overlapping them buys nothing — reads go through a bridge measured
 * at ~1,800-2,000 calls/s. Five reads per candidate would be minutes if issued
 * one at a time and is seconds when overlapped.
 */
const READ_CONCURRENCY = 16;

/**
 * Zero-width characters that `trim()` leaves alone.
 *
 * `String.prototype.trim` strips Unicode whitespace, which already covers the
 * `&nbsp;` (U+00A0) that HTML-to-Rem conversion produces in bulk. It does not
 * strip the zero-width joiners and space that also survive that conversion —
 * they are formatting characters, not whitespace — and a Rem holding only those
 * is exactly as empty on screen as one holding nothing.
 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

const isBlankString = (s: string): boolean => s.replace(ZERO_WIDTH, '').trim() === '';

/**
 * Formatting keys that a blank text run may carry and still count as blank.
 *
 * Bold on nothing is nothing. The keys deliberately left OUT are the ones that
 * carry meaning independent of the characters they wrap — a cloze id, a link
 * target, a comment — because a Rem holding one of those is not empty even when
 * it renders as empty, and deleting it would lose the thing it points at.
 */
const COSMETIC_FORMATTING = new Set<string>([
  RICH_TEXT_FORMATTING.BOLD,
  RICH_TEXT_FORMATTING.ITALIC,
  RICH_TEXT_FORMATTING.UNDERLINE,
  RICH_TEXT_FORMATTING.STRIKETHROUGH,
  RICH_TEXT_FORMATTING.SUBSCRIPT,
  RICH_TEXT_FORMATTING.SUPERSCRIPT,
  RICH_TEXT_FORMATTING.HIGHLIGHT,
  RICH_TEXT_FORMATTING.TEXT_COLOR,
  RICH_TEXT_FORMATTING.INLINE_CODE,
  RICH_TEXT_FORMATTING.QUOTE,
]);

/**
 * True when a rich text array renders as nothing at all.
 *
 * Plain strings are blank when they trim away. Element objects are blank only
 * when they are TEXT elements (`i: 'm'`) whose own text trims away and which
 * carry nothing but cosmetic formatting — EVERY other element type (a Rem
 * reference `q`, an image `i`, audio `a`, a drawing `r`, LaTeX `x`, an
 * annotation `n`, a plugin element `p`, an icon) is content by its mere
 * presence, and its presence is the whole reason this predicate cannot just
 * compare a string to `''`.
 */
export const isBlankRichText = (text: RichTextInterface | undefined): boolean => {
  if (!text) return true;
  for (const el of text) {
    if (typeof el === 'string') {
      if (!isBlankString(el)) return false;
      continue;
    }
    const e = el as Record<string, unknown>;
    if (e.i !== RICH_TEXT_ELEMENT_TYPE.TEXT) return false;
    if (typeof e.text !== 'string' || !isBlankString(e.text)) return false;
    // Anything beyond `i`, `text` and pure decoration means the run is carrying
    // something — a cloze, a link, a comment — that survives having no visible
    // characters.
    for (const key of Object.keys(e)) {
      if (key === 'i' || key === 'text') continue;
      if (!COSMETIC_FORMATTING.has(key)) return false;
    }
  }
  return true;
};

const now = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/**
 * A minimal RemObject shape, so the scan can read the synchronous snapshot
 * fields without importing the SDK's class (which is not exported as a type
 * usable in this position across the plugin's other modules).
 */
type ScanRem = {
  _id: RemId;
  text?: RichTextInterface;
  backText?: RichTextInterface;
  children?: RemId[];
  /** The Concept/Descriptor/Portal type. Absent on some builds — see structuralSkipReason. */
  type?: RemType;
  hasPowerup: (code: string) => Promise<boolean>;
  getTagRems: () => Promise<{ _id: RemId }[]>;
  remsReferencingThis: () => Promise<unknown[]>;
  getCards: () => Promise<unknown[]>;
  getSources: () => Promise<unknown[]>;
  getAliases: () => Promise<unknown[]>;
  getPortalDirectlyIncludedRem: () => Promise<unknown[]>;
  isSlot: () => Promise<boolean>;
  isPowerupProperty: () => Promise<boolean>;
  isTable: () => Promise<boolean>;
  isDocument: () => Promise<boolean>;
  getParentRem: () => Promise<{ text?: RichTextInterface } | undefined>;
  remove: () => Promise<void>;
};

/**
 * The free half of the test: readable off the snapshot, no round trips.
 * A Rem renders as nothing when neither its text nor its back text has content.
 *
 * NOTE THAT BLANK TEXT IS NOT THE SAME AS EMPTY. A Rem can hold no text and
 * still carry meaning that lives somewhere other than its rich text — see
 * `structuralSkipReason`, which is what stops this from being a delete
 * predicate on its own.
 */
const isBlankRem = (rem: ScanRem): boolean =>
  isBlankRichText(rem.text) && isBlankRichText(rem.backText);

/**
 * Rems whose content is not in their text at all.
 *
 * THIS EXISTS BECAUSE OF A REAL NEAR-MISS: a **portal** has no text of its own —
 * it is a window onto other Rems — so a blank-text test called one "completely
 * empty and safe to delete" when deleting it would have destroyed a portal the
 * user had placed under a flashcard. A portal's contents are NOT its `children`
 * either (they hang off the portal mechanism), so the children check missed it
 * too. Nothing in the rich text says "portal"; the signal is `rem.type`.
 *
 * Hence the rule: only a Rem of the DEFAULT type is ever a candidate. Concepts
 * and Descriptors are skipped as well — a typed Rem with no text is someone's
 * unfinished structure, not import debris, and the cost of being wrong here is
 * asymmetric.
 *
 * `type` is read off the snapshot, so this is free. It is also, empirically, not
 * always populated: the Rems in the first knowledge base probed reported
 * `undefined`, which must read as DEFAULT rather than as "unknown, skip it" —
 * otherwise the command would find nothing at all.
 */
const structuralSkipReason = (rem: ScanRem): SkipReason | null => {
  if (rem.type == null) return null;
  if (rem.type === RemType.PORTAL) return 'isPortal';
  if (rem.type !== RemType.DEFAULT_TYPE) return 'isTyped';
  return null;
};

/**
 * The paid half: five reads that each rule out a way deleting the Rem would
 * lose something. Issued together because they are independent and reads
 * overlap freely; the whole set costs roughly one round trip of wall clock.
 */
/**
 * Every built-in powerup EXCEPT Extra Card Detail.
 *
 * This list exists because of a gap that only became visible once it was
 * established that `getTagRems()` does not surface built-in powerups: a Rem
 * carrying `EmbedWebsite`, `SearchPortal`, `Divider`, `TableOfContent`,
 * `UploadedFile`, `Code` or `Callout` renders real content while holding NO
 * TEXT, and none of the other checks here would have noticed. The tag check
 * catches user tags and plugin powerups; nothing caught the built-ins.
 *
 * Swept in full rather than from a curated shortlist. Deciding which built-ins
 * "matter" is exactly the kind of judgement that produced the portal near-miss,
 * and asking every code costs ~90s once against an irreversible delete.
 */
const OTHER_BUILTIN_POWERUP_CODES: string[] = Object.values(BuiltInPowerupCodes).filter(
  (code) => code !== BuiltInPowerupCodes.ExtraCardDetail
);

const classifyRemotely = async (
  rem: ScanRem,
  ecdPowerupId: RemId | null
): Promise<{ reason: SkipReason | null; parentId: RemId | null }> => {
  const [
    tags,
    referencing,
    cards,
    sources,
    aliases,
    portalContents,
    isSlot,
    isProperty,
    isTable,
    isDocument,
    otherPowerups,
    parent,
  ] = await Promise.all([
    rem.getTagRems(),
    rem.remsReferencingThis(),
    rem.getCards(),
    rem.getSources(),
    rem.getAliases(),
    rem.getPortalDirectlyIncludedRem().catch(() => []),
    rem.isSlot().catch(() => false),
    rem.isPowerupProperty().catch(() => false),
    rem.isTable().catch(() => false),
    rem.isDocument().catch(() => false),
    Promise.all(OTHER_BUILTIN_POWERUP_CODES.map((code) => rem.hasPowerup(code).catch(() => false))),
    rem.getParentRem().catch(() => undefined),
  ]);

  const parentId = (parent as { _id?: RemId } | undefined)?._id ?? null;

  // Belt and braces on top of the free `type` test. A portal that displays
  // anything is never deletable, and this catches one whose type field did not
  // say so — the near-miss that motivated the check was invisible to every
  // other signal here.
  if (portalContents.length > 0) return { reason: 'isPortal', parentId };
  // Tables are portal-backed (their filter is a SearchPortalQuery), so most are
  // caught above — but asked directly, because a table row or cell that is not
  // itself typed as a portal would otherwise fall through.
  if (isTable) return { reason: 'isTable', parentId };
  if (isSlot || isProperty || isDocument) return { reason: 'isStructural', parentId };
  if (otherPowerups.some(Boolean)) return { reason: 'hasOtherPowerup', parentId };

  // Extra Card Detail is expected and is the reason the Rem is a candidate at
  // all; anything else — another powerup, a user tag — is a mark somebody put
  // there on purpose. Note that built-in powerups do NOT appear here (measured:
  // ECD Rems return an empty list), so this catches user tags and *plugin*
  // powerups; built-ins are covered by the type test and the checks above.
  if (tags.some((t: { _id: RemId }) => t._id !== ecdPowerupId))
    return { reason: 'hasOtherTags', parentId };
  if (referencing.length > 0) return { reason: 'isReferenced', parentId };
  if (cards.length > 0) return { reason: 'hasCards', parentId };
  if (sources.length > 0) return { reason: 'hasSources', parentId };
  if (aliases.length > 0) return { reason: 'hasAliases', parentId };
  return { reason: null, parentId };
};

/** Runs `task` over `items` with a bounded number in flight. */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker)
  );
}

const emptySkips = (): Record<SkipReason, number> => ({
  isPortal: 0,
  isTable: 0,
  isTyped: 0,
  isStructural: 0,
  hasOtherPowerup: 0,
  hasChildren: 0,
  hasOtherTags: 0,
  isReferenced: 0,
  hasCards: 0,
  hasSources: 0,
  hasAliases: 0,
  unverified: 0,
});

/**
 * Finds every Rem in the scope that carries Extra Card Detail and is safe to
 * delete. Writes nothing — the caller confirms against these numbers first.
 *
 * MEMBERSHIP IS TESTED PER REM, NOT READ FROM A LIST. The obvious approach —
 * ask the powerup for its members with `taggedRem()` — was tried first and is
 * WRONG: on a knowledge base whose Anki imports hold thousands of Extra Card
 * Detail Rems it returned THREE, while `hasPowerup('x')` on those same Rems
 * returned true. Whatever `taggedRem()` enumerates, it is not the full
 * membership of a built-in powerup. (`getTagRems()` is no substitute either: it
 * came back empty for Rems that demonstrably carry ECD, while returning ids for
 * a Rem carrying plugin powerups — built-in powerups simply do not surface
 * there.) So the scope is walked and each Rem is asked directly.
 *
 * Which makes the ordering of the phases the thing that keeps it affordable: the
 * blank test is free, so it runs first and reduces a 400k-Rem walk to the few
 * thousand Rems worth spending a round trip on.
 */
export async function scanEmptyEcdRems(
  plugin: RNPlugin,
  scope: EmptyEcdScope,
  onProgress?: EmptyEcdProgress
): Promise<EmptyEcdScanResult> {
  const t0 = now();

  // Resolved only to recognise the powerup's own Rem should a build ever list it
  // among a Rem's tags. On the build this was written against it never appears
  // there, so the id is a defensive nicety rather than the mechanism — the
  // mechanism is hasPowerup, below.
  const powerup = await plugin.powerup.getPowerupByCode(BuiltInPowerupCodes.ExtraCardDetail);
  const ecdPowerupId = powerup?._id ?? null;

  // PHASE 0 — the scope. A whole-KB run has to enumerate everything, because a
  // Rem with no text is reachable by no search and, as established above, by no
  // powerup membership list either.
  let scopeRems: ScanRem[];
  if (scope.kind === 'kb') {
    onProgress?.('Enumerating every Rem in the knowledge base…');
    try {
      scopeRems = (await plugin.rem.getAll()) as unknown as ScanRem[];
    } catch (e) {
      console.error('[EmptyECD] plugin.rem.getAll() failed:', e);
      throw new Error(
        'RemNote would not enumerate the knowledge base (plugin.rem.getAll is unavailable in this build). Scan a document instead.'
      );
    }
  } else {
    onProgress?.('Collecting descendants…');
    const root = await plugin.rem.findOne(scope.remId);
    if (!root) throw new Error('The Rem to scan no longer exists.');
    scopeRems = [root, ...(await root.getDescendants())] as unknown as ScanRem[];
  }

  const skipped = emptySkips();

  // Which scanned Rems have children, decided from `parent` — never from the
  // lazy `children` field, which is empty for any document not opened this
  // session (see priority_review_document/children.ts). Complete for both
  // scopes: getAll() is every Rem in the KB, and [root, ...getDescendants()] is
  // every Rem under the root, so a child of any scanned Rem is in the list.
  const remsWithChildren = new Set<string>();
  for (const r of scopeRems as any[]) if (r.parent) remsWithChildren.add(r.parent);

  // PHASE 1 — the free filter. Text and back text come off the snapshot, so
  // this costs nothing and is what makes walking the whole knowledge base
  // viable at all.
  onProgress?.(`Checking ${scopeRems.length} Rems…`, 0, scopeRems.length);
  const blankRems: ScanRem[] = [];
  for (let i = 0; i < scopeRems.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) {
      onProgress?.(`Checking ${i} / ${scopeRems.length} Rems…`, i, scopeRems.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (isBlankRem(scopeRems[i])) blankRems.push(scopeRems[i]);
  }

  // PHASE 2 — the membership test, one read per blank Rem. A blank Rem that is
  // not Extra Card Detail is simply out of scope for this command: plenty of
  // knowledge bases carry empty bullets on purpose, and they are none of its
  // business.
  onProgress?.(`Testing ${blankRems.length} blank Rems for Extra Card Detail…`, 0, blankRems.length);
  const ecdBlanks: ScanRem[] = [];
  let tested = 0;
  await mapWithConcurrency(blankRems, READ_CONCURRENCY, async (rem) => {
    try {
      if (await rem.hasPowerup(BuiltInPowerupCodes.ExtraCardDetail)) ecdBlanks.push(rem);
    } catch (e) {
      // Unreadable means unverified, and unverified is never deleted.
      console.error('[EmptyECD] hasPowerup failed for', rem._id, e);
      skipped.unverified++;
    }
    tested++;
    if (tested % 200 === 0) {
      onProgress?.(
        `Testing ${tested} / ${blankRems.length} blank Rems for Extra Card Detail…`,
        tested,
        blankRems.length
      );
    }
  });

  // PHASE 3 — verification. Only blank ECD Rems get here, and these are
  // precisely the Rems that would otherwise be deleted, so the cost is
  // proportional to what is at stake.
  //
  // The children check is free and sits here rather than in phase 1 so its
  // count means something: "blank ECD Rems that have children", not every
  // non-empty Rem in the knowledge base.
  const candidates: EmptyEcdCandidate[] = [];
  let checked = 0;
  await mapWithConcurrency(ecdBlanks, READ_CONCURRENCY, async (rem) => {
    // Free, and first: a portal has no text by nature, so without this a blank
    // text test hands one straight to the delete list.
    const structural = structuralSkipReason(rem);
    if (structural) {
      skipped[structural]++;
      return;
    }

    // `remove()` deletes descendants too, so a blank Rem holding children is
    // the single most destructive thing this command could get wrong.
    if (remsWithChildren.has(rem._id)) {
      skipped.hasChildren++;
      return;
    }

    let reason: SkipReason | null;
    let parentId: RemId | null = null;
    try {
      ({ reason, parentId } = await classifyRemotely(rem, ecdPowerupId));
    } catch (e) {
      // A read that throws leaves the Rem unverified, and an unverified Rem is
      // never a delete candidate. Reported under its own reason rather than
      // folded into one of the real ones, so a run whose checks are failing does
      // not read as a knowledge base full of tagged Rems.
      console.error('[EmptyECD] verification failed for', rem._id, e);
      reason = 'unverified';
    }
    if (reason) skipped[reason]++;
    else candidates.push({ remId: rem._id, parentId, parentText: '' });

    checked++;
    if (checked % 100 === 0) {
      onProgress?.(`Verifying ${checked} / ${ecdBlanks.length} Rems…`, checked, ecdBlanks.length);
    }
  });

  // PHASE 3 — parent context for a sample, so the confirmation dialog can show
  // WHERE the blanks sit rather than just how many there are.
  const preview = candidates.slice(0, PREVIEW_SIZE);
  if (preview.length > 0) {
    onProgress?.('Building preview…');
    await Promise.all(
      preview.map(async (candidate) => {
        try {
          const rem = await plugin.rem.findOne(candidate.remId);
          const parent = await rem?.getParentRem();
          const text = parent ? await safeRemTextToString(plugin, parent.text) : '';
          candidate.parentText = text.length > 90 ? text.slice(0, 90) + '…' : text;
        } catch {
          candidate.parentText = '';
        }
      })
    );
  }

  const result: EmptyEcdScanResult = {
    scanned: scopeRems.length,
    blank: blankRems.length,
    blankEcd: ecdBlanks.length,
    candidates,
    skipped,
    preview,
    elapsedMs: now() - t0,
  };

  console.log(
    `[EmptyECD] scan: ${result.scanned} Rems walked · ${result.blank} blank · ` +
      `${result.blankEcd} of those are ECD · ${candidates.length} deletable · ` +
      `skips ${JSON.stringify(skipped)} · ${(result.elapsedMs / 1000).toFixed(1)}s`
  );

  onProgress?.(`Checked ${scopeRems.length} Rems.`, scopeRems.length, scopeRems.length);
  return result;
}

/** Local-storage key holding the most recent deletion manifest. */
export const EMPTY_ECD_BACKUP_KEY = 'empty_ecd_last_deletion';

export interface EmptyEcdBackup {
  takenAt: string;
  scope: string;
  rows: Array<{ remId: RemId; parentId: RemId | null }>;
}

/**
 * Records what is about to be deleted, before a single Rem is removed.
 *
 * The deleted Rems are blank, so nothing about their CONTENT is worth saving —
 * what is worth saving is that they existed and where. `parentId` is the whole
 * point: it is what lets someone find the flashcard a blank was removed from if
 * something later looks wrong.
 *
 * This exists because the plugin already holds destructive bulk operations to
 * this standard — the card-priority migration "refuses to start without a full
 * backup" (lib/card_priority/hidden_slot_migration.ts) — and deleting thousands
 * of Rems had no such guard.
 *
 * Local storage, not synced: a manifest of several thousand rows would blow the
 * per-key synced budget, and the file download is the copy that outlives the
 * knowledge base anyway.
 */
export async function saveDeletionBackup(
  plugin: RNPlugin,
  candidates: EmptyEcdCandidate[],
  scope: string
): Promise<EmptyEcdBackup> {
  const backup: EmptyEcdBackup = {
    takenAt: new Date().toISOString(),
    scope,
    rows: candidates.map((c) => ({ remId: c.remId, parentId: c.parentId })),
  };
  await plugin.storage.setLocal(EMPTY_ECD_BACKUP_KEY, backup);
  return backup;
}

/**
 * Deletes the Rems a scan produced.
 *
 * Takes the candidate ids rather than re-deriving them, so the confirmation the
 * user gave applies to exactly the Rems that get removed — a re-scan between
 * the dialog and the delete could otherwise widen the list underneath them.
 *
 * Sequential on purpose. Overlapping plugin WRITES was measured in
 * lib/image_scan.ts to leave throughput unchanged while multiplying per-call
 * latency, because RemNote applies them one at a time regardless.
 *
 * Every deleted id is logged before the call. RemNote's delete is recoverable
 * from the trash, and the log is what makes a specific one findable afterwards.
 */
export async function deleteEmptyEcdRems(
  plugin: RNPlugin,
  remIds: RemId[],
  onProgress?: EmptyEcdProgress
): Promise<EmptyEcdDeleteResult> {
  const t0 = now();
  const result: EmptyEcdDeleteResult = { deleted: 0, failed: 0, elapsedMs: 0 };

  console.log(`[EmptyECD] deleting ${remIds.length} Rems:`, remIds);

  // Every delete fires GlobalRemChanged straight back into this plugin's own
  // listener — a findOne, session reads and a debounced tail per event, all of
  // it pointless for a write made here. A renewable lease rather than a bare
  // `true` because this runs in a popup the user can close, and a torn-down
  // iframe never reaches the `finally`.
  const lease = new SuppressionLease(plugin);
  await lease.start();

  try {
    for (let i = 0; i < remIds.length; i++) {
      const remId = remIds[i];
      try {
        const rem = await plugin.rem.findOne(remId);
        // Gone already — a concurrent edit, or a re-run over a stale list. Not a
        // failure: the desired end state is exactly what is already true.
        if (!rem) continue;
        await rem.remove();
        result.deleted++;
      } catch (e) {
        result.failed++;
        console.error('[EmptyECD] delete failed for', remId, e);
      }

      if ((i + 1) % PROGRESS_EVERY === 0) {
        onProgress?.(`Deleted ${i + 1} / ${remIds.length} Rems…`, i + 1, remIds.length);
        await lease.renew();
      }
    }
  } finally {
    await lease.release();
  }

  result.elapsedMs = now() - t0;
  console.log(
    `[EmptyECD] deleted ${result.deleted}, failed ${result.failed} · ` +
      `${(result.elapsedMs / 1000).toFixed(1)}s`
  );
  onProgress?.(`Deleted ${result.deleted} Rems.`, remIds.length, remIds.length);
  return result;
}
