/**
 * Shared time-period type + resolvers. Used by the Study Dashboard and the
 * Card Priority × Memory Analytics tab to express "filter stats to this
 * date range" consistently. Resolvers return [startMs, endMs) — endMs is
 * exclusive (matches the half-open convention used by the existing
 * card-history iteration loops).
 *
 * The picker UI in study_dashboard.tsx remains there for now; only the type
 * and the date math live here so both widgets agree on what "This Year" or
 * "Last Week" means down to the millisecond.
 */

export type Period =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'thisWeek'
  | 'lastWeek'
  | 'month'
  | 'thisMonth'
  | 'lastMonth'
  | 'year'
  | 'thisYear'
  | 'lastYear'
  | 'all'
  | 'custom';

export function getStartOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getStartOfWeek(date: Date): number {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getStartOfMonth(date: Date): number {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getStartOfYear(date: Date): number {
  const d = new Date(date);
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function resolvePeriod(
  p: Period,
  customStart: string,
  customEnd: string,
): { startMs: number; endMs: number } {
  const now = new Date();
  const sodToday = getStartOfDay(now);
  const sodTomorrow = sodToday + 86400000;
  const sodYesterday = sodToday - 86400000;
  const sow = getStartOfWeek(now);
  const sowLast = sow - 7 * 86400000;
  const som = getStartOfMonth(now);
  const lastMonth = new Date(now);
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const somLast = getStartOfMonth(lastMonth);
  const soy = getStartOfYear(now);
  const lastYear = new Date(now);
  lastYear.setFullYear(lastYear.getFullYear() - 1);
  const soyLast = getStartOfYear(lastYear);

  switch (p) {
    case 'today':
      return { startMs: sodToday, endMs: sodTomorrow };
    case 'yesterday':
      return { startMs: sodYesterday, endMs: sodToday };
    case 'week':
      return { startMs: now.getTime() - 7 * 86400000, endMs: now.getTime() };
    case 'thisWeek':
      return { startMs: sow, endMs: now.getTime() };
    case 'lastWeek':
      return { startMs: sowLast, endMs: sow };
    case 'month':
      return { startMs: now.getTime() - 30 * 86400000, endMs: now.getTime() };
    case 'thisMonth':
      return { startMs: som, endMs: now.getTime() };
    case 'lastMonth':
      return { startMs: somLast, endMs: som };
    case 'year':
      return { startMs: now.getTime() - 365 * 86400000, endMs: now.getTime() };
    case 'thisYear':
      return { startMs: soy, endMs: now.getTime() };
    case 'lastYear':
      return { startMs: soyLast, endMs: soy };
    case 'all':
      return { startMs: 0, endMs: now.getTime() + 86400000 };
    case 'custom': {
      const s = new Date(customStart);
      const e = new Date(customEnd);
      const sMs = isNaN(s.getTime()) ? 0 : getStartOfDay(s);
      const eMs = isNaN(e.getTime()) ? now.getTime() + 86400000 : getStartOfDay(e) + 86400000;
      return { startMs: sMs, endMs: eMs };
    }
  }
}
