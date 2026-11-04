/**
 * Rows for the three Priority Shield History charts (widgets/priority_shield_graph):
 *
 * - Priority Shield (IncRems + cards): read from `entry.unified` on the IncRem
 *   history keys. Days before it was recorded (v1.0.193) are REBUILT from the
 *   two older histories of the same scope: absolute = the lower of the IncRem
 *   and card sides (the same rule computeUnifiedShield applies live), universe =
 *   IncRems + cards. Relative and weighted need the whole distribution, so they
 *   are never rebuilt.
 * - Card Shield (cards only): the card history keys, as recorded.
 * - IncRem Shield (IncRems only): the IncRem history keys' own fields.
 *
 * Pure: runs under the ts-node tests.
 */
import type { UnifiedShieldEntry } from './unified_shield';

export interface GraphHistoryEntry {
  absolute: number | null;
  percentile: number | null;
  universeSize?: number;
  dismissedCount?: number;
  weightedShield?: number | null;
  unified?: UnifiedShieldEntry;
}

export type GraphHistory = Record<string, GraphHistoryEntry>;

export interface PriorityRow {
  originalDate: string;
  /** Recorded absolute (v1.0.193 on). */
  absolute: number | null;
  /** Rebuilt absolute; also set on a recorded day next to a rebuilt one, so the two lines meet. */
  absoluteRebuilt: number | null;
  relative: number | null;
  weightedShield: number | null;
  incRemAbsolute: number | null;
  cardAbsolute: number | null;
  /** Stacked universe, bottom to top: cards, IncRems, dismissed Rems. */
  cardUniverse: number;
  incRemUniverse: number;
  dismissedCount: number;
  /** IncRems + cards: the Priority Shield's universe (top of the IncRem band). */
  unifiedUniverse: number;
  rebuilt: boolean;
}

export interface CardRow {
  originalDate: string;
  absolute: number | null;
  relative: number | null;
  universeSize: number;
  weightedShield: number | null;
}

export interface IncRemRow {
  originalDate: string;
  absolute: number | null;
  universeSize: number;
  dismissedCount: number;
  totalUniverse: number;
  processingPercentage: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && !isNaN(v);
const byDate = (a: { originalDate: string }, b: { originalDate: string }) =>
  a.originalDate < b.originalDate ? -1 : a.originalDate > b.originalDate ? 1 : 0;

export function buildPriorityRows(
  incHistory: GraphHistory | null | undefined,
  cardHistory: GraphHistory | null | undefined
): PriorityRow[] {
  const inc = incHistory || {};
  const card = cardHistory || {};
  const rows: PriorityRow[] = [];

  for (const [date, e] of Object.entries(inc)) {
    if (!e) continue;
    const dismissedCount = e.dismissedCount || 0;
    const u = e.unified;
    if (u && isNum(u.universeSize)) {
      const cardUniverse = u.cardCount || 0;
      rows.push({
        originalDate: date,
        absolute: u.absolute ?? null,
        absoluteRebuilt: null,
        relative: u.percentile ?? null,
        weightedShield: u.weightedShield ?? null,
        incRemAbsolute: u.incRemAbsolute ?? null,
        cardAbsolute: u.cardAbsolute ?? null,
        cardUniverse,
        incRemUniverse: Math.max(0, u.universeSize - cardUniverse),
        dismissedCount,
        unifiedUniverse: u.universeSize,
        rebuilt: false,
      });
      continue;
    }
    // Rebuild only when both sides were recorded that day: with one side
    // missing, the other could have hidden a lower top missed priority.
    const c = card[date];
    if (!c || !isNum(e.absolute) || !isNum(c.absolute)) continue;
    const incRemUniverse = e.universeSize || 0;
    const cardUniverse = c.universeSize || 0;
    rows.push({
      originalDate: date,
      absolute: null,
      absoluteRebuilt: Math.min(e.absolute, c.absolute),
      relative: null,
      weightedShield: null,
      incRemAbsolute: e.absolute,
      cardAbsolute: c.absolute,
      cardUniverse,
      incRemUniverse,
      dismissedCount,
      unifiedUniverse: incRemUniverse + cardUniverse,
      rebuilt: true,
    });
  }

  rows.sort(byDate);
  // Bridge: a recorded day next to a rebuilt one also carries the rebuilt
  // series, so the thin line runs into the bold one instead of stopping short.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.rebuilt || r.absolute === null) continue;
    if (rows[i - 1]?.rebuilt || rows[i + 1]?.rebuilt) r.absoluteRebuilt = r.absolute;
  }
  return rows;
}

export function buildCardRows(cardHistory: GraphHistory | null | undefined): CardRow[] {
  return Object.entries(cardHistory || {})
    .filter(([, e]) => e && e.absolute !== null && e.absolute !== undefined)
    .map(([date, e]) => ({
      originalDate: date,
      absolute: e.absolute,
      relative: e.percentile,
      universeSize: e.universeSize || 0,
      weightedShield: e.weightedShield ?? null,
    }))
    .sort(byDate);
}

export function buildIncRemRows(incHistory: GraphHistory | null | undefined): IncRemRow[] {
  return Object.entries(incHistory || {})
    .filter(([, e]) => e && e.absolute !== null && e.absolute !== undefined)
    .map(([date, e]) => {
      const universeSize = e.universeSize || 0;
      const dismissedCount = e.dismissedCount || 0;
      const totalUniverse = universeSize + dismissedCount;
      return {
        originalDate: date,
        absolute: e.absolute,
        universeSize,
        dismissedCount,
        totalUniverse,
        processingPercentage: totalUniverse > 0 ? (dismissedCount / totalUniverse) * 100 : 0,
      };
    })
    .sort(byDate);
}
