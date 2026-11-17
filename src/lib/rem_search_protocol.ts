/**
 * The AI helper's /search answer, and the query-syntax test: pure, so it can be
 * tested outside RemNote. The client is lib/rem_search_client.ts.
 */

export interface HelperSearchHit {
  remId: string;
  /** Set when the Rem matched only through this alias. */
  aliasId?: string;
}

export interface HelperQueryError {
  /** Stable: 'unclosed-quote', 'ambiguous', 'not-found', 'not-yet', 'schema'… */
  kind: string;
  message: string;
  /** Character offset in the query where the problem starts. */
  at?: number;
}

export type HelperSearchResult =
  | { status: 'ok'; hits: HelperSearchHit[]; total: number; ms: number }
  /** The query can't run as written; RemNote's search still can. */
  | { status: 'query-error'; error: HelperQueryError }
  /** The helper answered but refused: no token, or not the one it holds. */
  | { status: 'unpaired' }
  /** No helper, an old helper without /search, or it failed. */
  | { status: 'unavailable' };

/** The helper's JSON → a result. */
export function parseSearchResponse(body: any): HelperSearchResult {
  if (!body || body.ok !== true) return { status: 'unavailable' };
  if (body.queryError && typeof body.queryError === 'object') {
    const e = body.queryError;
    return {
      status: 'query-error',
      error: {
        kind: String(e.kind ?? 'query'),
        message: String(e.message ?? 'The search could not run.'),
        ...(typeof e.at === 'number' ? { at: e.at } : {}),
      },
    };
  }
  if (!Array.isArray(body.results)) return { status: 'unavailable' };
  const hits: HelperSearchHit[] = [];
  for (const r of body.results) {
    if (typeof r?.remId !== 'string' || !r.remId) continue;
    hits.push(typeof r.aliasId === 'string' && r.aliasId ? { remId: r.remId, aliasId: r.aliasId } : { remId: r.remId });
  }
  return {
    status: 'ok',
    hits,
    total: typeof body.total === 'number' ? body.total : hits.length,
    ms: typeof body.ms === 'number' ? body.ms : 0,
  };
}

/** The helper's /search/source answer → Rem ids, or null when it didn't answer one. */
export function parseRemIdsResponse(body: any): string[] | null {
  if (!body || body.ok !== true || body.queryError || !Array.isArray(body.remIds)) return null;
  return body.remIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
}

/** Why a card isn't shown, as the helper's /search/suppression names it. */
export type HelperSuppressionCause =
  | 'paused' | 'ancestor' | 'rem' | 'table' | 'direction' | 'cloze' | 'removed' | 'other' | 'missing';

export interface HelperSuppression {
  /** Card id → its cause, for every card RemNote won't put in a queue. */
  causes: Map<string, HelperSuppressionCause>;
  /** Rems among them that are a table or sit in one. */
  inTable: Set<string>;
}

const SUPPRESSION_CAUSES = new Set(['paused', 'ancestor', 'rem', 'table', 'direction', 'cloze', 'removed', 'other', 'missing']);

/** The helper's /search/suppression answer, or null when it didn't answer one. */
export function parseSuppressionResponse(body: any): HelperSuppression | null {
  if (!body || body.ok !== true || body.queryError || !body.causes || typeof body.causes !== 'object') return null;
  const causes = new Map<string, HelperSuppressionCause>();
  for (const [cardId, cause] of Object.entries(body.causes)) {
    if (typeof cause === 'string' && SUPPRESSION_CAUSES.has(cause)) causes.set(cardId, cause as HelperSuppressionCause);
  }
  const inTable = new Set<string>(Array.isArray(body.inTable) ? body.inTable.filter((x: unknown) => typeof x === 'string') : []);
  return { causes, inTable };
}

/** One row of the Search & Browse table (scripts/rem_browse.py), a Rem or a card. */
export interface BrowseRow {
  remId: string;
  aliasId?: string;
  /** Set in card mode. */
  cardId?: string;
  text: string;
  back: string;
  /** Ancestor names, top first. */
  path: string[];
  type: '' | 'concept' | 'descriptor' | 'portal';
  isDocument: boolean;
  created: number | null;
  edited: number | null;
  tags: string[];
  incremental: boolean;
  dismissed: boolean;
  /** Card priority (0–100), when the Rem has one. */
  priority: number | null;
  incPriority: number | null;
  /** IncRem next date, in days from today. */
  incDue: number | null;
  /** Rem mode: how many cards. */
  cards?: number;
  /** Next review, in days from today (rem mode: its earliest card). */
  due: number | null;
  reps: number | null;
  lapses: number | null;
  ivl: number | null;
  /** Card mode. */
  kind?: 'forward' | 'backward' | 'cloze';
  ml?: string | null;
  learnNew?: boolean;
  /** Suppression causes of its cards (rem_search SUPPRESSED names). */
  suppressed: string[];
  /** FSRS memory state from the card's own scheduler (rem mode: its card with the
   *  lowest retrievability); null for SM-2 cards and cards never answered. */
  stability: number | null;
  difficulty: number | null;
  /** 0–1, now. */
  retrievability: number | null;
  /** The card's scheduler ('Global Default' or its name). */
  scheduler: string | null;
}

export type BrowseMode = 'rems' | 'cards';
export type BrowseSort =
  | 'relevance' | 'text' | 'created' | 'edited' | 'due' | 'priority' | 'incpriority' | 'reps' | 'lapses' | 'ivl'
  | 's' | 'd' | 'r';

export type HelperBrowseResult =
  | { status: 'ok'; rows: BrowseRow[]; total: number; ms: number }
  | { status: 'query-error'; error: HelperQueryError }
  | { status: 'unpaired' }
  | { status: 'unavailable' };

/** The helper's /search/browse answer → a result. */
export function parseBrowseResponse(body: any): HelperBrowseResult {
  if (!body || body.ok !== true) return { status: 'unavailable' };
  if (body.queryError && typeof body.queryError === 'object') {
    const e = body.queryError;
    return {
      status: 'query-error',
      error: { kind: String(e.kind ?? 'query'), message: String(e.message ?? 'The search could not run.'),
        ...(typeof e.at === 'number' ? { at: e.at } : {}) },
    };
  }
  if (!Array.isArray(body.rows)) return { status: 'unavailable' };
  const rows = body.rows.filter((r: any) => r && typeof r.remId === 'string') as BrowseRow[];
  for (const r of rows) {
    r.path = Array.isArray(r.path) ? r.path : [];
    r.tags = Array.isArray(r.tags) ? r.tags : [];
    r.suppressed = Array.isArray(r.suppressed) ? r.suppressed : [];
  }
  return { status: 'ok', rows, total: typeof body.total === 'number' ? body.total : rows.length,
    ms: typeof body.ms === 'number' ? body.ms : 0 };
}

/** The helper's /search/ai answer: a query for a plain-language request. */
export interface HelperAiQuery {
  query: string;
  mode: BrowseMode | null;
  /** False when even Claude's second try doesn't parse; `error` says why. */
  valid: boolean;
  error?: string;
}

export function parseAiResponse(body: any): HelperAiQuery | null {
  if (!body || body.ok !== true || typeof body.query !== 'string' || !body.query.trim()) return null;
  return {
    query: body.query.trim(),
    mode: body.mode === 'rems' || body.mode === 'cards' ? body.mode : null,
    valid: body.valid !== false,
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
  };
}

/**
 * Whether a query uses the helper's syntax (operators, quotes, brackets, keys), so
 * RemNote's word search can't stand in for it. Plain words return false.
 */
const SEARCH_KEYS = 'w|alias|in|parent|path|tag|is|has|source|refs|id|added|edited|prop|card|ml|rated|introduced|cid|suppressed|scheduler';
const SYNTAX_RE = new RegExp(
  // operators · quotes and brackets · key: · owner.name:value or owner.name<5 (a slot or property)
  `(^|\\s)(-\\S|or\\s|and\\s)|["()]|(^|\\s)-?(${SEARCH_KEYS}):|(^|\\s)-?[^\\s:]*[a-z*]\\.[a-z][^\\s:<>=]*(:|<|>|=)`,
  'i'
);

export function usesQuerySyntax(query: string): boolean {
  return SYNTAX_RE.test(query.trim() + ' ');
}
