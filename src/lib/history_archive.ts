/**
 * Client for the helper's review-history archive (scripts/history_archive.py,
 * served by scripts/ai_ocr_helper.py). See plans/implemented/HISTORY_ARCHIVE_PLAN.md.
 *
 * Reviews of deleted Rems drop out of everything the plugin can read: RemNote
 * moves the cards to a trash that no SDK call reaches, and purges it after two
 * weeks. The desktop helper reads remnote.db and keeps every rep it ever saw.
 * This module asks it for the "ghosts" (reps whose card or Rem is no longer
 * live) and keeps only those that no live history still holds.
 *
 * Rep identity is the timestamp in ms, across kinds: Preserve history & remove,
 * Dismiss and Transfer to parent all keep a rep's `date` while moving it to
 * another Rem or kind. So a ghost whose timestamp is in any live history is
 * already counted there and is dropped.
 *
 * Desktop only, and optional: when the helper is not running every call here
 * resolves to null and callers keep what they had.
 */

export const HISTORY_HELPER_URL = 'http://localhost:3457';

/** Synced, one key per KB: the ghost reps' day buckets, in the authoritative
 *  shard's compact format plus `at` (when they were computed) and `n` (reps). */
export const GHOST_AGGREGATES_KEY = 'ghostDailyAggregates';
export function ghostShardKey(kbId: string): string {
  return `${GHOST_AGGREGATES_KEY}_${kbId}`;
}

export type GhostKind = 'card' | 'inc' | 'dism';

export interface GhostRep {
  /** Rep timestamp, ms. The rep's identity. */
  date: number;
  kind: GhostKind;
  /** Card id, or the Rem id for inc/dism. */
  item: string;
  rem: string | null;
  /** Card score (QueueInteractionScore); null for inc/dism. */
  score: number | null;
  /** Raw ms: card responseTime (uncapped) or IncRem reviewTimeSeconds × 1000. */
  time: number | null;
  /** IncRem eventType; null for cards and for legacy reps without one. */
  event: string | null;
  deletedAt: number | null;
}

export interface GhostRem {
  id: string;
  text: string | null;
  state: 'live' | 'trash' | 'gone';
  deletedAt: number | null;
  parent: string | null;
}

export interface GhostPayload {
  reps: GhostRep[];
  rems: Record<string, GhostRem>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The helper's ghost reps for a KB, or null when it can't be reached or
 * answered with an error. `scan` asks it to scan remnote.db first (~4 s on a
 * large KB), so a Rem deleted since its last background scan is included.
 */
export async function fetchGhosts(
  kbId: string,
  opts?: {
    scan?: boolean;
    timeoutMs?: number;
    /** Must carry the pairing token (helper_client.helperHeaders): every POST route needs it. */
    headers?: Record<string, string>;
  }
): Promise<GhostPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${HISTORY_HELPER_URL}/history/ghosts`, {
      method: 'POST',
      headers: opts?.headers ?? { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kbId, scan: !!opts?.scan }),
      signal: controller.signal,
    });
    const body = await res.json();
    if (!body?.ok || !Array.isArray(body.reps)) {
      console.warn('[HistoryArchive] helper answered with an error:', body?.error ?? body);
      return null;
    }
    return { reps: body.reps as GhostRep[], rems: (body.rems || {}) as Record<string, GhostRem> };
  } catch {
    // Not running (the usual case on mobile, web and machines without it): quiet.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tree nodes for the Study Dashboard
// ---------------------------------------------------------------------------

/** Parent of deleted Rems that have no surviving ancestor. */
export const DELETED_ROOT_ID = '__deleted_rems__';
/** Prefix of the node that holds a live Rem's deleted cards. */
export const REMOVED_CARDS_PREFIX = '__removed_cards__:';

export interface GhostCardHistory {
  id: string;
  history: { date: number; score: number | undefined; responseTime: number }[];
}
export interface GhostIncRep {
  date: number;
  eventType: any;
  reviewTimeSeconds: number;
}

/** One deleted Rem (or a deleted ancestor holding none itself) for the tree. */
export interface GhostNode {
  id: string;
  /** A deleted parent, the nearest live ancestor, or DELETED_ROOT_ID. */
  parentId: string;
  text: string;
  deletedAt: number | null;
  cards: GhostCardHistory[];
  incHistory: GhostIncRep[];
  dismHistory: GhostIncRep[];
}

/**
 * Turn the ghosts into tree nodes, keeping deleted subtrees together.
 *
 * Each Rem holding a kept ghost rep becomes a node, and so does every deleted
 * Rem between it and its nearest live ancestor. A Rem whose ghosts were all
 * dropped (a tombstone's former descendants, say) is not drawn unless it is on
 * the way to one that holds some. A chain with no live ancestor ends at
 * DELETED_ROOT_ID. A card deleted while its Rem lives on gets a node of its own
 * under that Rem.
 */
export function buildGhostNodes(reps: GhostRep[], rems: Record<string, GhostRem>): GhostNode[] {
  const nodes = new Map<string, GhostNode>();
  const isLive = (id: string | null | undefined) => !!id && rems[id]?.state === 'live';

  const ensure = (id: string): GhostNode | null => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const r = rems[id];
    if (!r || r.state === 'live') return null;
    const parent = r.parent && rems[r.parent] ? r.parent : null;
    const node: GhostNode = {
      id,
      parentId: parent ?? DELETED_ROOT_ID,
      text: r.text || 'Untitled',
      deletedAt: r.deletedAt ?? null,
      cards: [],
      incHistory: [],
      dismHistory: [],
    };
    nodes.set(id, node);
    if (parent && !isLive(parent)) ensure(parent);
    return node;
  };

  for (const rep of reps) {
    let node: GhostNode | null = null;
    if (rep.rem && isLive(rep.rem)) {
      // The card went, the Rem stayed.
      const id = REMOVED_CARDS_PREFIX + rep.rem;
      node = nodes.get(id) ?? null;
      if (!node) {
        node = {
          id,
          parentId: rep.rem,
          text: 'Removed cards',
          deletedAt: rep.deletedAt ?? null,
          cards: [],
          incHistory: [],
          dismHistory: [],
        };
        nodes.set(id, node);
      }
    } else if (rep.rem) {
      node = ensure(rep.rem);
    }
    if (!node) continue;
    if (rep.kind === 'card') {
      let card = node.cards.find((c) => c.id === rep.item);
      if (!card) {
        card = { id: rep.item, history: [] };
        node.cards.push(card);
      }
      card.history.push({ date: rep.date, score: rep.score ?? undefined, responseTime: rep.time ?? 0 });
    } else {
      const entry: GhostIncRep = {
        date: rep.date,
        eventType: rep.event ?? undefined,
        reviewTimeSeconds: (rep.time ?? 0) / 1000,
      };
      (rep.kind === 'inc' ? node.incHistory : node.dismHistory).push(entry);
    }
  }
  return Array.from(nodes.values());
}

/**
 * Ghosts that no live history holds. The helper already returns one copy per
 * timestamp (the most recently live one); this drops the ones the plugin
 * itself still sees, e.g. a tombstone's `importedRep` copies or a card restored
 * from the trash since the last scan.
 */
export function filterGhosts(payload: GhostPayload, liveDates: Set<number>): GhostRep[] {
  const seen = new Set<number>();
  const out: GhostRep[] = [];
  for (const r of payload.reps) {
    if (!r || typeof r.date !== 'number') continue;
    if (liveDates.has(r.date) || seen.has(r.date)) continue;
    seen.add(r.date);
    out.push(r);
  }
  return out;
}
