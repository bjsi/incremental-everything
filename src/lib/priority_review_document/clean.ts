import { RNPlugin, PluginRem, RemId, RichTextInterface } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import { IncrementalRem } from '../incremental_rem';
import { allIncrementalRemKey, priorityGraphPowerupCode, priorityQueuePowerupCode } from '../consts';
import { readChildren, readChildrenWithCounts } from './children';

/**
 * Cleaning a Priority Review Document of entries that are no longer due.
 *
 * A PRD is a snapshot: it is built from what was due at the moment it was
 * created, and every entry is a child Rem whose text is a single Rem reference,
 * tagged INC or FC. Nothing updates those entries afterwards, so once the
 * referenced Rem has been reviewed the entry stays behind and keeps feeding the
 * document's queue — which, under RemNote's current gathering rules, is what
 * lets an old document crowd out the priorities you actually want.
 *
 * The scan is read-only and answers one question per entry: does the referenced
 * Rem still have anything due today?
 *   - FC  → the Rem's OWN cards.
 *   - INC → the Rem is in the IncRem cache and its next repetition has arrived.
 * Descendants are deliberately not consulted: the builder never selected a Rem
 * for its descendants' cards, so cleaning must not keep one for them either.
 *
 * The threshold is the END OF TODAY, not `now` as in the builder's `dueCards`
 * count. The builder is choosing what to serve at this instant; this is deciding
 * what to throw away, and those are not the same question. A card answered Again
 * an hour ago sits in a learning step ten minutes out — not due by `now`, but
 * coming back in this very session, and deleting its entry would take it out of
 * the document that is meant to bring it back. For INC entries the two
 * thresholds coincide: `nextRepDate` is a Daily Document date at midnight, so
 * anything at or before today is already ≤ now.
 *
 * Two whole-KB reads (`card.getAll()` and the IncRem session cache) answer
 * every entry in every document, so the per-entry cost is a map lookup rather
 * than a round trip.
 *
 * A document that cleaning would leave with nothing due is finished, and the
 * cleaner offers to delete it outright — including one that already holds
 * nothing at all. That is only ever offered when the document carries none of
 * your own writing: an entry kept for the notes under it, or a bullet you added
 * to the document, blocks it, since `remove()` takes descendants with it.
 */

/** Name of the plain tag createPriorityReviewDocument puts on every PRD. */
export const PRD_TAG_NAME = 'Priority Review Queue';
/** Names of the plain tags it puts on each entry. */
export const INC_TAG_NAME = 'INC';
export const FC_TAG_NAME = 'FC';

export type PortalKind = 'inc' | 'fc';

export type EntryStatus =
  /** Referenced Rem still has something due — the entry stays. */
  | 'due'
  /** Reviewed since the document was built — the entry is removable. */
  | 'stale'
  /**
   * Still due, but a card that would give its answer away was reviewed
   * recently (see cooling.ts) — the entry is removable; a refill brings the
   * Rem back once its window has run out.
   */
  | 'cooling'
  /** The referenced Rem no longer exists — the entry is removable. */
  | 'missing'
  /** Cannot be judged (see {@link PrdScanResult.incCacheUnavailable}) — kept. */
  | 'unknown';

/** Why an entry that is no longer due is kept anyway. */
export type KeepReason = 'has-children' | 'edited-text';

export const KEEP_REASON_LABELS: Record<KeepReason, string> = {
  'has-children': 'have notes written under them',
  'edited-text': 'have text of your own next to the reference',
};

export interface PrdEntry {
  /** The child Rem inside the review document — this is what gets deleted. */
  entryRemId: RemId;
  /** The Rem it references, or null when the text holds no reference. */
  targetRemId: RemId | null;
  targetName: string;
  kind: PortalKind;
  status: EntryStatus;
  /** Set when the entry is no longer due but is being kept anyway. */
  keepReason?: KeepReason;
}

/** Why a document that holds nothing due cannot simply be deleted. */
export type UndeletableReason = 'kept-entries' | 'inc-with-notes' | 'your-notes' | 'persistent';

export const UNDELETABLE_REASON_LABELS: Record<UndeletableReason, string> = {
  'kept-entries': 'holds entries kept for your notes',
  'inc-with-notes': 'holds incremental entries with writing of your own under them',
  'your-notes': 'holds bullets of your own',
  persistent: 'is a Priority Queue document, kept and refilled rather than deleted',
};

export interface PrdDocReport {
  docRemId: RemId;
  docName: string;
  createdAt: number;
  /** A persistent Priority Queue document: never deleted, never stamped. */
  persistent: boolean;
  /** Entries (reference-bearing children) found in the document. */
  totalEntries: number;
  /** The plugin's own children: the metadata block and the distribution graph. */
  generatedChildren: number;
  /** Non-entry children that are yours — bullets you added to the document. */
  userChildren: number;
  /** Entries whose target is still due. */
  dueEntries: PrdEntry[];
  /**
   * Due entries that are flashcards. This, not `dueEntries.length`, is what
   * decides whether the document still has a job — see {@link PrdDocReport.deletable}.
   */
  dueFlashcards: number;
  /**
   * INC entries that would go down with the document: due ones, plus unjudged
   * ones. Surfaced so the confirmation can say what deleting actually costs.
   */
  remainingIncEntries: number;
  /** Entries that will be deleted — reviewed, missing, or cooling. */
  removableEntries: PrdEntry[];
  /** How many of the removable entries are removable because they are cooling. */
  coolingEntries: number;
  /** No longer due, but kept because deleting them would lose something. */
  keptEntries: PrdEntry[];
  /** Entries that could not be judged. */
  unknownEntries: PrdEntry[];
  /**
   * True when cleaning this document would leave no flashcard due in it —
   * including a document that already holds nothing at all — and it carries
   * none of your own content, so the document itself can go.
   *
   * Due INC entries do not keep a document alive. A PRD exists to get
   * flashcards reviewed in priority order, which is the one thing an ordinary
   * queue will not do for you; incremental Rems are injected into every queue
   * by the sorting criteria whether or not a review document points at them. A
   * document down to its incremental entries has nothing left to offer, and
   * keeping it only leaves stale Rem references behind.
   */
  deletable: boolean;
  /**
   * Set when the document would hold nothing due but must be kept anyway.
   * `deletable` is then false.
   */
  undeletableReason?: UndeletableReason;
}

export interface PrdScanResult {
  docs: PrdDocReport[];
  /** Documents carrying the PRD tag. */
  scannedDocs: number;
  totalEntries: number;
  totalRemovable: number;
  totalDue: number;
  totalKept: number;
  /** Documents that hold nothing due and can be deleted outright. */
  totalDeletableDocs: number;
  /**
   * True when the IncRem session cache was empty. INC entries are then reported
   * as `unknown` and never deleted — an unbuilt cache would otherwise look
   * exactly like "every incremental Rem has been reviewed".
   */
  incCacheUnavailable: boolean;
  elapsedMs: number;
}

export interface PrdCleanResult {
  /** Entry Rems removed. Entries inside a deleted document are not counted here. */
  deleted: number;
  failed: number;
  /** Documents removed outright. */
  deletedDocs: { docRemId: RemId; docName: string }[];
  /**
   * INC entries that went down with those documents. They were still due; the
   * document was deleted anyway because no flashcard in it was. The Rems
   * themselves are untouched and keep coming back through the ordinary queue.
   */
  incEntriesDropped: number;
  /** Documents left holding nothing due that were kept, and why. */
  emptiedDocs: { docRemId: RemId; docName: string; reason: UndeletableReason | 'not-requested' }[];
}

export interface PrdScanOptions {
  /** Only these documents; every tagged document when absent. */
  docIds?: RemId[];
  /** Rems currently cooling: a due FC entry pointing at one is removable as `cooling`. */
  coolingRemIds?: ReadonlySet<RemId>;
}

export interface PrdCleanOptions {
  /**
   * Delete a document outright once cleaning would leave no flashcard due in
   * it. A document holding writing of your own — a kept entry, notes under a
   * surviving incremental entry, or a bullet you added — is never deleted
   * whatever this says. See {@link PrdDocReport.deletable}.
   */
  deleteEmptiedDocs: boolean;
}

/**
 * Local, allocation-only rendering of a Rem's text — no round trip.
 *
 * Entry targets are ordinary Rems whose text is overwhelmingly plain, and the
 * label is only ever read by a human scanning the preview, so the accuracy of
 * `plugin.richText.toString()` is not worth one IPC call per entry across
 * potentially thousands of them.
 */
function flattenRichText(text: RichTextInterface | undefined): string {
  if (!Array.isArray(text)) return '';
  return text
    .map((el) => {
      if (typeof el === 'string') return el;
      if (el && typeof el === 'object') {
        if ('text' in el && typeof (el as any).text === 'string') return (el as any).text;
        if ((el as any).i === 'q') return '↪';
      }
      return '';
    })
    .join('')
    .trim();
}

/**
 * Same as {@link flattenRichText} but with Rem references resolved to their own
 * text. Used for document titles only: a PRD title is
 * `Priority Review - [scope ref] - timestamp`, so the reference is the one part
 * that tells two review documents apart, and a "↪" there would make the whole
 * list read as the same document repeated. One extra lookup per document.
 */
async function flattenTitle(
  plugin: RNPlugin,
  text: RichTextInterface | undefined
): Promise<string> {
  const refs = remRefIds(text);
  if (refs.length === 0) return flattenRichText(text);
  const resolved = (await plugin.rem.findMany(refs)) || [];
  const nameById = new Map<RemId, string>(
    resolved.map((r) => [r._id, flattenRichText(r.text) || 'Untitled'])
  );
  if (!Array.isArray(text)) return '';
  return text
    .map((el) => {
      if (typeof el === 'string') return el;
      if (el && typeof el === 'object') {
        if ((el as any).i === 'q') return nameById.get((el as any)._id as RemId) ?? '↪';
        if ('text' in el && typeof (el as any).text === 'string') return (el as any).text;
      }
      return '';
    })
    .join('')
    .trim();
}

/** The Rem references (`{ i: 'q', _id }`) carried by a rich text value. */
function remRefIds(text: RichTextInterface | undefined): RemId[] {
  if (!Array.isArray(text)) return [];
  const ids: RemId[] = [];
  for (const el of text) {
    if (el && typeof el === 'object' && (el as any).i === 'q' && (el as any)._id) {
      ids.push((el as any)._id as RemId);
    }
  }
  return ids;
}

/**
 * True when the child's text holds anything beyond the single Rem reference the
 * builder wrote. Whitespace does not count; a second reference does.
 */
function hasTextOfItsOwn(text: RichTextInterface | undefined): boolean {
  if (!Array.isArray(text)) return false;
  let refs = 0;
  for (const el of text) {
    if (typeof el === 'string') {
      if (el.trim().length > 0) return true;
      continue;
    }
    if (el && typeof el === 'object') {
      if ((el as any).i === 'q') {
        refs++;
        continue;
      }
      // Any other rich-text element (bold run, image, cloze, latex…) is content.
      return true;
    }
  }
  return refs > 1;
}

/**
 * True for the two children createPriorityReviewDocument writes itself: the
 * metadata code block and the priority-distribution graph. Telling them apart
 * from bullets you added is what lets an exhausted document be deleted without
 * ever risking your own writing — the text checks answer for every document the
 * plugin has built, and the powerup read is the fallback for a renamed one.
 */
async function isGeneratedChild(child: PluginRem): Promise<boolean> {
  const text = flattenRichText(child.text);
  if (text.startsWith('Scope: ')) return true;
  if (text === 'Priority Distribution Graph') return true;
  try {
    return await child.hasPowerup(priorityGraphPowerupCode);
  } catch {
    return false;
  }
}

/** An empty bullet with nothing under it — no content, so nothing to lose. */
function isEmptyBullet(child: PluginRem, childCount: number): boolean {
  return flattenRichText(child.text).length === 0 && childCount === 0;
}

/** Rem IDs that own at least one card due at any point up to the end of today. */
async function buildDueCardRemIds(plugin: RNPlugin): Promise<Set<RemId>> {
  const cutoff = dayjs().endOf('day').valueOf();
  const allCards = (await plugin.card.getAll()) || [];
  const due = new Set<RemId>();
  for (const card of allCards) {
    // `?? Infinity` mirrors getCardPriority: a disabled direction has a null
    // nextRepetitionTime and must not read as due.
    if ((card.nextRepetitionTime ?? Infinity) <= cutoff) due.add(card.remId);
  }
  return due;
}

/** Rem IDs whose IncRem next-repetition date has arrived (by the end of today). */
async function buildDueIncRemIds(
  plugin: RNPlugin
): Promise<{ due: Set<RemId>; all: Set<RemId>; available: boolean }> {
  const cutoff = dayjs().endOf('day').valueOf();
  const allIncRems =
    (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
  if (allIncRems.length === 0) {
    return { due: new Set<RemId>(), all: new Set<RemId>(), available: false };
  }
  const due = new Set<RemId>();
  const all = new Set<RemId>();
  for (const inc of allIncRems) {
    all.add(inc.remId);
    if (inc.nextRepDate <= cutoff) due.add(inc.remId);
  }
  return { due, all, available: true };
}

/** The Rems carrying a plain tag of the given name, as an ID set. */
async function taggedIdSet(plugin: RNPlugin, tagName: string): Promise<Set<RemId>> {
  const tag = await plugin.rem.findByName([tagName], null);
  if (!tag) return new Set<RemId>();
  const tagged = (await tag.taggedRem()) || [];
  return new Set(tagged.map((r) => r._id));
}

/**
 * Read-only pass over every Priority Review Document in the knowledge base.
 * Writes nothing; the caller decides what to delete from the result.
 */
export async function scanPriorityReviewDocuments(
  plugin: RNPlugin,
  onProgress?: (message: string) => void,
  options: PrdScanOptions = {}
): Promise<PrdScanResult> {
  const startedAt = Date.now();
  const empty: PrdScanResult = {
    docs: [],
    scannedDocs: 0,
    totalEntries: 0,
    totalRemovable: 0,
    totalDue: 0,
    totalKept: 0,
    totalDeletableDocs: 0,
    incCacheUnavailable: false,
    elapsedMs: 0,
  };

  onProgress?.('Finding review documents…');
  const prdTag = await plugin.rem.findByName([PRD_TAG_NAME], null);
  if (!prdTag) {
    return { ...empty, elapsedMs: Date.now() - startedAt };
  }
  let docs = (await prdTag.taggedRem()) || [];
  if (options.docIds) {
    const wanted = new Set(options.docIds);
    docs = docs.filter((d) => wanted.has(d._id));
  }
  if (docs.length === 0) {
    return { ...empty, elapsedMs: Date.now() - startedAt };
  }

  onProgress?.('Reading due state for the whole knowledge base…');
  const [dueCardRemIds, incState, incTagged, fcTagged] = await Promise.all([
    buildDueCardRemIds(plugin),
    buildDueIncRemIds(plugin),
    taggedIdSet(plugin, INC_TAG_NAME),
    taggedIdSet(plugin, FC_TAG_NAME),
  ]);

  const reports: PrdDocReport[] = [];
  let docIndex = 0;

  for (const doc of docs) {
    docIndex++;
    const docName = (await flattenTitle(plugin, doc.text)) || 'Untitled review document';
    onProgress?.(`Document ${docIndex} of ${docs.length}: ${docName.slice(0, 60)}`);

    // Never the lazy `children` field: for a document not opened this session
    // it is empty (see children.ts). One getDescendants call gives the entries
    // and how many children each holds — the "notes written under it" checks
    // below must never mistake an unloaded list for an empty one.
    const { children, childCounts } = await readChildrenWithCounts(plugin, doc);
    const countOf = (rem: PluginRem) => childCounts.get(rem._id) ?? 0;

    // One lookup for every target in this document, instead of one per entry.
    const targetIds = new Set<RemId>();
    for (const child of children) {
      for (const id of remRefIds(child.text)) targetIds.add(id);
    }
    const targets = targetIds.size ? (await plugin.rem.findMany([...targetIds])) || [] : [];
    const targetById = new Map<RemId, PluginRem>(targets.map((r) => [r._id, r]));

    let persistent = false;
    try {
      persistent = await doc.hasPowerup(priorityQueuePowerupCode);
    } catch {
      persistent = false;
    }

    const report: PrdDocReport = {
      docRemId: doc._id,
      docName,
      createdAt: doc.createdAt,
      persistent,
      totalEntries: 0,
      generatedChildren: 0,
      userChildren: 0,
      dueEntries: [],
      dueFlashcards: 0,
      remainingIncEntries: 0,
      removableEntries: [],
      coolingEntries: 0,
      keptEntries: [],
      unknownEntries: [],
      deletable: false,
    };

    /** Set when an INC entry that would survive cleaning has notes under it. */
    let incEntryHoldsNotes = false;

    for (const child of children) {
      const refs = remRefIds(child.text);
      if (refs.length === 0) {
        // Not an entry. Which of these it is decides whether the document can
        // ever be deleted, so the plugin's own two children are told apart from
        // anything you added.
        if (await isGeneratedChild(child)) report.generatedChildren++;
        else if (isEmptyBullet(child, countOf(child))) report.generatedChildren++;
        else report.userChildren++;
        continue;
      }
      report.totalEntries++;

      const targetRemId = refs[0];
      const target = targetById.get(targetRemId);
      // The tag is what the builder recorded; inference only covers an entry
      // whose tag was removed, and then the target itself decides — being an
      // IncRem at all, due or not, is what makes an entry an INC entry.
      const kind: PortalKind = incTagged.has(child._id)
        ? 'inc'
        : fcTagged.has(child._id)
          ? 'fc'
          : incState.all.has(targetRemId)
            ? 'inc'
            : 'fc';

      const entry: PrdEntry = {
        entryRemId: child._id,
        targetRemId,
        targetName: target ? flattenRichText(target.text) || 'Untitled' : '(deleted Rem)',
        kind,
        status: 'due',
      };

      if (!target) {
        entry.status = 'missing';
      } else if (kind === 'inc') {
        if (!incState.available) entry.status = 'unknown';
        else entry.status = incState.due.has(targetRemId) ? 'due' : 'stale';
      } else if (!dueCardRemIds.has(targetRemId)) {
        entry.status = 'stale';
      } else if (options.coolingRemIds?.has(targetRemId)) {
        entry.status = 'cooling';
      }

      // A surviving entry no longer guarantees the document survives, so this is
      // the point where the notes check has to happen for due and unjudged INC
      // entries too: `remove()` on the document takes their descendants with it,
      // and nothing else downstream looks at them.
      const carriesWritingOfYourOwn = () =>
        countOf(child) > 0 || hasTextOfItsOwn(child.text);

      if (entry.status === 'due') {
        report.dueEntries.push(entry);
        if (kind === 'fc') {
          report.dueFlashcards++;
        } else {
          report.remainingIncEntries++;
          if (carriesWritingOfYourOwn()) incEntryHoldsNotes = true;
        }
        continue;
      }
      if (entry.status === 'unknown') {
        // Only INC entries are ever left unjudged — a flashcard is read straight
        // off the card data, which is always there.
        report.unknownEntries.push(entry);
        report.remainingIncEntries++;
        if (carriesWritingOfYourOwn()) incEntryHoldsNotes = true;
        continue;
      }

      // Removable in principle — unless deleting it would take something of
      // yours with it. `remove()` deletes descendants too, so a note written
      // under an entry is not recoverable from a re-run.
      if (countOf(child) > 0) {
        entry.keepReason = 'has-children';
        report.keptEntries.push(entry);
      } else if (hasTextOfItsOwn(child.text)) {
        entry.keepReason = 'edited-text';
        report.keptEntries.push(entry);
      } else {
        report.removableEntries.push(entry);
        if (entry.status === 'cooling') report.coolingEntries++;
      }
    }

    // Deletable = cleaning it would leave no flashcard due, and nothing of yours
    // is in it. What blocks deletion is your own writing, in any of the three
    // places it can be: an entry kept for its notes, notes under an incremental
    // entry that is staying, or a bullet you added to the document itself.
    //
    // Due incremental entries do not block, and neither do unjudged ones — both
    // are INC, and an INC entry is not a reason for a review document to exist
    // (see {@link PrdDocReport.deletable}). That also means an empty IncRem
    // cache no longer suppresses document deletion: the flashcard half of the
    // decision is read from card data, which is never unavailable.
    //
    // A document that already holds no entries at all lands here too, which is
    // the point — those are finished snapshots with nothing left in them.
    if (persistent) {
      // Kept by design: it is emptied and refilled, never thrown away.
      report.undeletableReason = 'persistent';
    } else if (report.dueFlashcards === 0) {
      if (report.keptEntries.length > 0) {
        report.undeletableReason = 'kept-entries';
      } else if (incEntryHoldsNotes) {
        report.undeletableReason = 'inc-with-notes';
      } else if (report.userChildren > 0) {
        report.undeletableReason = 'your-notes';
      } else {
        report.deletable = true;
      }
    }

    reports.push(report);
  }

  // Most recent first: that is the document you are most likely reviewing from.
  reports.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const result: PrdScanResult = {
    docs: reports,
    scannedDocs: reports.length,
    totalEntries: reports.reduce((n, d) => n + d.totalEntries, 0),
    totalRemovable: reports.reduce((n, d) => n + d.removableEntries.length, 0),
    totalDue: reports.reduce((n, d) => n + d.dueEntries.length, 0),
    totalKept: reports.reduce((n, d) => n + d.keptEntries.length, 0),
    totalDeletableDocs: reports.filter((d) => d.deletable).length,
    incCacheUnavailable: !incState.available,
    elapsedMs: Date.now() - startedAt,
  };

  logScan(result);
  return result;
}

const reportsDueFlashcards = (r: PrdScanResult) =>
  r.docs.reduce((n, d) => n + d.dueFlashcards, 0);

/** Full per-document breakdown in the console — the diagnostic half of this command. */
function logScan(result: PrdScanResult) {
  console.log(
    `[PRD Clean] Scanned ${result.scannedDocs} review documents, ${result.totalEntries} entries, ` +
      `in ${(result.elapsedMs / 1000).toFixed(1)}s — ` +
      `${result.totalDue} still due (${reportsDueFlashcards(result)} of them flashcards), ` +
      `${result.totalRemovable} removable, ${result.totalKept} kept, ` +
      `${result.totalDeletableDocs} documents exhausted.`
  );
  if (result.incCacheUnavailable) {
    console.warn(
      '[PRD Clean] The IncRem cache is empty, so INC entries could not be judged and were left alone.'
    );
  }
  for (const doc of result.docs) {
    console.groupCollapsed(
      `[PRD Clean] ${doc.docName} — ${doc.dueFlashcards} due FC / ${doc.remainingIncEntries} remaining INC / ` +
        `${doc.removableEntries.length} removable / ${doc.totalEntries} entries` +
        (doc.deletable
          ? ` — EXHAUSTED, the document itself can go${
              doc.remainingIncEntries ? ' (its remaining entries are all incremental)' : ''
            }`
          : doc.undeletableReason
            ? ` — no flashcards due, but it ${UNDELETABLE_REASON_LABELS[doc.undeletableReason]}`
            : '')
    );
    const row = (e: PrdEntry) => ({
      status: e.status,
      kind: e.kind.toUpperCase(),
      name: e.targetName,
      target: e.targetRemId,
      entry: e.entryRemId,
      kept: e.keepReason ?? '',
    });
    console.table([
      ...doc.removableEntries.map(row),
      ...doc.keptEntries.map(row),
      ...doc.unknownEntries.map(row),
      ...doc.dueEntries.map(row),
    ]);
    console.groupEnd();
  }
}

/**
 * Deletes the removable entries of the given documents, and the documents that
 * cleaning leaves with nothing due, stamping what was removed onto the metadata
 * block of the ones that survive.
 *
 * Takes the reports produced by {@link scanPriorityReviewDocuments} — already
 * filtered to the documents the user ticked — and re-reads each Rem by ID rather
 * than trusting an object captured during the scan.
 */
export async function cleanPriorityReviewDocuments(
  plugin: RNPlugin,
  docs: PrdDocReport[],
  options: PrdCleanOptions,
  onProgress?: (message: string) => void
): Promise<PrdCleanResult> {
  const result: PrdCleanResult = {
    deleted: 0,
    failed: 0,
    deletedDocs: [],
    incEntriesDropped: 0,
    emptiedDocs: [],
  };
  const total = docs
    .filter((d) => !(options.deleteEmptiedDocs && d.deletable))
    .reduce((n, d) => n + d.removableEntries.length, 0);

  for (const doc of docs) {
    // Removing the document removes its entries with it, so a document on its
    // way out is never walked entry by entry — one call instead of N.
    if (options.deleteEmptiedDocs && doc.deletable) {
      try {
        const docRem = await plugin.rem.findOne(doc.docRemId);
        if (docRem) await docRem.remove();
        result.deletedDocs.push({ docRemId: doc.docRemId, docName: doc.docName });
        result.incEntriesDropped += doc.remainingIncEntries;
      } catch (e) {
        console.error(`[PRD Clean] Could not delete document ${doc.docRemId}:`, e);
        result.failed++;
      }
      onProgress?.(`Deleted ${result.deletedDocs.length} exhausted document(s)…`);
      continue;
    }

    let deletedHere = 0;
    for (const entry of doc.removableEntries) {
      try {
        const rem = await plugin.rem.findOne(entry.entryRemId);
        // Already gone is a success, not a failure — the entry is not there.
        if (rem) await rem.remove();
        deletedHere++;
        result.deleted++;
      } catch (e) {
        console.error(`[PRD Clean] Could not delete entry ${entry.entryRemId}:`, e);
        result.failed++;
      }
      onProgress?.(`Removed ${result.deleted} of ${total}…`);
    }

    // A Priority Queue document rewrites its own status block on refresh.
    if (!doc.persistent) await stampMetadata(plugin, doc, deletedHere);

    // Same predicate as `deletable`, so a document that qualified but was kept
    // is reported with the reason it was kept for.
    if (doc.dueFlashcards === 0 && !doc.persistent) {
      result.emptiedDocs.push({
        docRemId: doc.docRemId,
        docName: doc.docName,
        reason: doc.undeletableReason ?? 'not-requested',
      });
    }
  }

  console.log(
    `[PRD Clean] Removed ${result.deleted} entries across ${docs.length} documents` +
      (result.deletedDocs.length
        ? `, deleted ${result.deletedDocs.length} exhausted documents` +
          (result.incEntriesDropped
            ? ` (dropping ${result.incEntriesDropped} still-due INC entries with them)`
            : '')
        : '') +
      (result.failed ? ` (${result.failed} failed)` : '') +
      (result.emptiedDocs.length
        ? `. ${result.emptiedDocs.length} document(s) hold no due flashcards and were kept.`
        : '.')
  );
  return result;
}

/**
 * Appends a cleaning line to the document's metadata code block, so the counts
 * printed at creation time are not left contradicting the document's contents.
 * Best-effort: a document whose block was edited away is still cleaned.
 */
async function stampMetadata(plugin: RNPlugin, doc: PrdDocReport, removed: number) {
  if (removed === 0) return;
  try {
    const docRem = await plugin.rem.findOne(doc.docRemId);
    const children = docRem ? await readChildren(plugin, docRem) : [];
    const metadata = children.find((c) => flattenRichText(c.text).startsWith('Scope: '));
    if (!metadata) return;

    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const dueIncRems = doc.dueEntries.length - doc.dueFlashcards;
    // Unjudged INC entries are kept, so they are part of what the document still
    // holds — but calling them "due" would be a guess (see incCacheUnavailable).
    const unchecked = doc.unknownEntries.length;

    const stamp =
      `\nCleaned ${new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}: removed ${plural(removed, 'reviewed entry', 'reviewed entries')}, ` +
      `${plural(doc.dueFlashcards, 'flashcard', 'flashcards')} and ` +
      `${plural(dueIncRems, 'Incremental Rem', 'Incremental Rems')} still due` +
      (unchecked ? `, ${plural(unchecked, 'Incremental Rem', 'Incremental Rems')} not checked` : '');

    await metadata.setText([flattenRichText(metadata.text) + stamp]);
  } catch (e) {
    console.warn(`[PRD Clean] Could not stamp metadata on ${doc.docRemId}:`, e);
  }
}
