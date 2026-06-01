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
  | 'since'   // From a user-picked start date through "now". customStart holds the start.
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

/**
 * Parse a flexible user-typed date string into the canonical "YYYY-MM-DD"
 * format that `resolvePeriod` expects. Accepted formats:
 *   - "DD/MM/YYYY"  e.g. "01/01/2024"
 *   - "DDMMYYYY"    e.g. "01012024"
 *   - "DDMMYY"      e.g. "010124"  → 20YY
 *   - "YYYY-MM-DD"  e.g. "2024-01-01" (native date-input format, passthrough)
 *   - "D/M/YYYY"    e.g. "1/1/2024"
 * Returns "" if the input cannot be parsed into a valid date.
 */
export function parseDateInput(raw: string): string {
  const s = raw.trim();
  if (!s) return '';

  let m: number | undefined;
  let d: number | undefined;
  let y: number | undefined;

  // YYYY-MM-DD (ISO / native date input)
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    y = parseInt(iso[1], 10);
    m = parseInt(iso[2], 10);
    d = parseInt(iso[3], 10);
  }

  // DD/MM/YYYY or D/M/YYYY
  if (y === undefined) {
    const slashed = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slashed) {
      d = parseInt(slashed[1], 10);
      m = parseInt(slashed[2], 10);
      y = parseInt(slashed[3], 10);
      if (y < 100) y += 2000;
    }
  }

  // DDMMYYYY (8 digits)
  if (y === undefined && /^\d{8}$/.test(s)) {
    d = parseInt(s.slice(0, 2), 10);
    m = parseInt(s.slice(2, 4), 10);
    y = parseInt(s.slice(4, 8), 10);
  }

  // DDMMYY (6 digits)
  if (y === undefined && /^\d{6}$/.test(s)) {
    d = parseInt(s.slice(0, 2), 10);
    m = parseInt(s.slice(2, 4), 10);
    y = 2000 + parseInt(s.slice(4, 6), 10);
  }

  if (y === undefined || m === undefined || d === undefined) return '';
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1970 || y > 2100) return '';

  // Validate the date actually exists (e.g. reject Feb 30)
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return '';

  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/**
 * Convert a "YYYY-MM-DD" canonical string to "DD/MM/YYYY" for display, or
 * return the raw string if it doesn't match the expected format.
 */
export function formatDateForDisplay(canonical: string): string {
  const m = canonical.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return canonical;
  return `${m[3]}/${m[2]}/${m[1]}`;
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
    case 'since': {
      // "From this day on" — start = picked date, end = now (open-ended).
      // We reuse customStart for the date; customEnd is ignored.
      const s = new Date(customStart);
      const sMs = isNaN(s.getTime()) ? 0 : getStartOfDay(s);
      return { startMs: sMs, endMs: now.getTime() + 86400000 };
    }
    case 'custom': {
      const s = new Date(customStart);
      const e = new Date(customEnd);
      const sMs = isNaN(s.getTime()) ? 0 : getStartOfDay(s);
      const eMs = isNaN(e.getTime()) ? now.getTime() + 86400000 : getStartOfDay(e) + 86400000;
      return { startMs: sMs, endMs: eMs };
    }
  }
}
