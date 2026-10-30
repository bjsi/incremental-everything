import { QueueInteractionScore, RepetitionStatusInterface } from '@remnote/plugin-sdk';
import { computeFSRSState, computeFSRSStatesPerReview, countsForMainCard } from './fsrs';

// ---------------------------------------------------------------------------
// The items of a multi-line (list / set) card
//
// RemNote stores no schedule for an item, only its scores inside the card's
// history, and replays them when it needs a date. This does the same, using the
// rules read from RemNote's module 188814 (findings/MULTI_LINE_SUB_CARDS.md):
//
// - an item's history holds the reps that scored it, plus reps with no item scores
//   at all, such as Forgot all;
// - an item is "in trouble" while either of its last 2 scored reps was Forgot or
//   Partially Recalled, and only then can its date bring the card back;
// - the next showing tests the full card if the main card is due by the end of the
//   day, otherwise the troubled items with the lowest recent scores.
//
// The plugin can't read relearning steps, so a relearning item's date is treated
// as "now", and RemNote's fuzz is absent, so dates beyond a relearning step are
// approximate. Without a usable model (the card is on another scheduler), dates and
// stability are left out, and only what the scores alone decide is reported.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_REPS = 2;
/** RemNote's default for its "next day starts at" setting, which plugins can't read. */
const NEXT_DAY_STARTS_AT_HOUR = 4;
const MAX_NAME_CHARS = 40;

interface ItemScore {
  remId: string;
  score: QueueInteractionScore;
}

type MultiLineRep = RepetitionStatusInterface & {
  isFullMultiLineRep?: boolean;
  subCardScores?: ItemScore[];
};

export interface MultiLineItem {
  remId: string;
  /** Scores of the last 2 scored reps, oldest first. */
  lastScores: QueueInteractionScore[];
  troubled: boolean;
  /** Date of the most recent Forgot or Partially Recalled among `lastScores`. */
  lastTroubleDate: number | null;
  /** Null without a usable model. */
  stability: number | null;
  /** Null without a usable model. */
  nextDate: number | null;
}

export interface MultiLineSummary {
  /** Items to test next first, then weakest first. */
  items: MultiLineItem[];
  /** 'full', or the ids of the items the next showing tests. */
  nextTest: 'full' | string[];
  mainDue: boolean;
  /** Null without a usable model. */
  mainDate: number | null;
  /** Items whose date sets the card's due date. Empty when the main card does, or without a model. */
  driverIds: string[];
  nextRepetitionTime: number | null;
}

function isGradeable(score: QueueInteractionScore): boolean {
  return (
    score === QueueInteractionScore.AGAIN ||
    score === QueueInteractionScore.HARD ||
    score === QueueInteractionScore.GOOD ||
    score === QueueInteractionScore.EASY
  );
}

function isTroubleScore(score: QueueInteractionScore): boolean {
  return score === QueueInteractionScore.AGAIN || score === QueueInteractionScore.HARD;
}

function afterLastReset(history: MultiLineRep[]): MultiLineRep[] {
  const sorted = [...history].sort((a, b) => a.date - b.date);
  const reset = sorted.map((rep) => rep.score).lastIndexOf(QueueInteractionScore.RESET);
  return reset === -1 ? sorted : sorted.slice(reset + 1);
}

/** RemNote only tracks the items scored since the last full rep. */
function trackedItemIds(history: MultiLineRep[]): string[] {
  let lastFull = -1;
  history.forEach((rep, i) => {
    if (rep.isFullMultiLineRep) lastFull = i;
  });
  const ids = new Set<string>();
  for (const rep of lastFull === -1 ? history : history.slice(lastFull)) {
    for (const scored of rep.subCardScores ?? []) ids.add(scored.remId);
  }
  return [...ids];
}

/** Only `date` and `score`, so `countsForMainCard` doesn't drop an item's own partial reps. */
function itemHistory(history: MultiLineRep[], remId: string): RepetitionStatusInterface[] {
  const out: RepetitionStatusInterface[] = [];
  for (const rep of history) {
    if (rep.subCardScores?.length) {
      const scored = rep.subCardScores.find((s) => s.remId === remId);
      if (scored) out.push({ date: rep.date, score: scored.score });
    } else {
      out.push({ date: rep.date, score: rep.score });
    }
  }
  return out;
}

function memoryOf(
  history: RepetitionStatusInterface[],
  weights: number[] | null,
  retention: number,
): { stability: number; nextDate: number } | null {
  const state = computeFSRSState(history, weights, retention);
  if (!state) return null;
  const steps = computeFSRSStatesPerReview(history, weights);
  const lastGraded = [...history].reverse().find((rep) => isGradeable(rep.score));
  if (!lastGraded) return null;
  const inSteps = ['learning', 'relearning'].includes(steps[steps.length - 1]?.state);
  const days = Math.max(1, Math.round(state.s * state.intervalFactor));
  return {
    stability: state.s,
    nextDate: inSteps ? lastGraded.date : lastGraded.date + days * MS_PER_DAY,
  };
}

/** The end of the RemNote day containing `now`, assuming the default day start. */
export function endOfRemNoteDay(now: number): number {
  const end = new Date(now);
  end.setHours(end.getHours() - NEXT_DAY_STARTS_AT_HOUR);
  end.setHours(23 + NEXT_DAY_STARTS_AT_HOUR, 59, 59, 999);
  return end.getTime();
}

/** Null for a card with no tracked items, which is every ordinary card. */
export function summarizeMultiLineCard({
  history,
  weights,
  retention,
  nextRepetitionTime,
  now,
  useModel,
}: {
  history: RepetitionStatusInterface[];
  weights: number[] | null;
  retention: number;
  nextRepetitionTime: number | null | undefined;
  now: number;
  /** False for a card on another scheduler, whose dates the plugin can't work out. */
  useModel: boolean;
}): MultiLineSummary | null {
  const sliced = afterLastReset(history as MultiLineRep[]);
  const ids = trackedItemIds(sliced);
  if (ids.length === 0) return null;

  const items = ids.map((remId) => {
    const own = itemHistory(sliced, remId);
    const graded = own.filter((rep) => isGradeable(rep.score)).slice(-RECENT_REPS);
    const trouble = graded.filter((rep) => isTroubleScore(rep.score));
    const memory = useModel ? memoryOf(own, weights, retention) : null;
    return {
      remId,
      lastScores: graded.map((rep) => rep.score),
      troubled: trouble.length > 0,
      lastTroubleDate: trouble.length > 0 ? trouble[trouble.length - 1].date : null,
      stability: memory?.stability ?? null,
      nextDate: memory?.nextDate ?? null,
    };
  });

  const recentSum = (item: MultiLineItem) => item.lastScores.reduce<number>((sum, s) => sum + s, 0);
  const troubled = items.filter((item) => item.troubled);
  const lowest = Math.min(...troubled.map(recentSum));
  const today = endOfRemNoteDay(now);

  const mainDate = useModel
    ? memoryOf(sliced.filter(countsForMainCard), weights, retention)?.nextDate ?? null
    : null;
  // Without a model, the stored date is the main card's only when nothing is in trouble.
  const mainDue = useModel
    ? mainDate !== null && mainDate <= today
    : troubled.length === 0 && (nextRepetitionTime ?? Infinity) <= today;

  const selected = items.filter(
    (item) =>
      troubled.length > 0 &&
      (recentSum(item) === lowest || (item.troubled && item.nextDate !== null && item.nextDate <= today)),
  );
  const nextTest =
    mainDue || selected.length === 0 || selected.length === items.length
      ? ('full' as const)
      : selected.map((item) => item.remId);

  let driverIds: string[] = [];
  if (useModel && mainDate !== null) {
    const earliest = Math.min(mainDate, ...troubled.map((item) => item.nextDate ?? Infinity));
    // The main card wins a tie.
    if (earliest < mainDate) driverIds = troubled.filter((item) => item.nextDate === earliest).map((item) => item.remId);
  }

  const isNext = (item: MultiLineItem) => nextTest !== 'full' && nextTest.includes(item.remId);
  const sorted = [...items].sort(
    (a, b) => Number(isNext(b)) - Number(isNext(a)) || recentSum(a) - recentSum(b),
  );

  return {
    items: sorted,
    nextTest,
    mainDue,
    mainDate,
    driverIds,
    nextRepetitionTime: nextRepetitionTime ?? null,
  };
}

// --- Wording ---------------------------------------------------------------

function formatDate(ms: number, now: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function quoted(name: string): string {
  return `"${name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS).trimEnd()}…` : name}"`;
}

/** Why the card is due when it is, and what it tests next. */
export function describeMultiLineCard(
  summary: MultiLineSummary,
  nameOf: (remId: string) => string,
  now: number,
): { reason: string | null; next: string } {
  const byId = new Map(summary.items.map((item) => [item.remId, item]));

  let reason: string | null = null;
  if (summary.driverIds.length > 0) {
    const named = (score: QueueInteractionScore) =>
      summary.driverIds
        .filter((id) => {
          const last = byId.get(id)!.lastScores;
          return last.length > 0 && last[last.length - 1] === score;
        })
        .map((id) => quoted(nameOf(id)));
    const forgot = named(QueueInteractionScore.AGAIN);
    const partial = named(QueueInteractionScore.HARD);
    const parts = [
      ...(forgot.length ? [`forgot ${joinNames(forgot)}`] : []),
      ...(partial.length ? [`partially recalled ${joinNames(partial)}`] : []),
    ];
    const because = parts.length
      ? `you ${parts.join(' and ')}`
      : `${joinNames(summary.driverIds.map((id) => quoted(nameOf(id))))} still needs another good answer`;
    const lastDate = Math.max(...summary.driverIds.map((id) => byId.get(id)!.lastTroubleDate ?? 0));
    const on = parts.length && lastDate > 0 ? ` on ${formatDate(lastDate, now)}` : '';
    const due = summary.nextRepetitionTime;
    reason =
      due !== null && due > now
        ? `Coming back early, around ${formatDate(due, now)}, because ${because}${on}.`
        : `Back early because ${because}${on}.`;
  } else if (summary.mainDate !== null) {
    reason = 'On its normal schedule.';
  }

  const returns =
    summary.mainDate !== null
      ? `The full card returns around ${formatDate(summary.mainDate, now)}.`
      : 'The full card returns when the main card is due.';

  let next: string;
  if (summary.mainDue) {
    next = 'Due for the full card.';
  } else if (summary.nextTest === 'full') {
    next = returns;
  } else {
    const names = summary.nextTest.map((id) => quoted(nameOf(id)));
    next = `Next time it tests only ${joinNames(names)}. ${returns}`;
  }
  return { reason, next };
}

/**
 * Whether an item is changing what the card does. Pressing Partially Recalled on a
 * whole set card puts every item in trouble, but they replay to the main card's own
 * date and all get tested together, so being in trouble alone changes nothing.
 */
export function itemAffectsCard(item: MultiLineItem, summary: MultiLineSummary): boolean {
  if (!item.troubled) return false;
  if (summary.nextTest !== 'full' && summary.nextTest.includes(item.remId)) return true;
  return item.nextDate !== null && summary.mainDate !== null && item.nextDate < summary.mainDate;
}

/** The "Next test" cell for one item. */
export function nextTestLabel(item: MultiLineItem, summary: MultiLineSummary, now: number): string {
  if (summary.mainDue) return 'Next time';
  if (summary.nextTest !== 'full' && summary.nextTest.includes(item.remId)) return 'Next time';
  const mainDate = summary.mainDate;
  if (mainDate === null) return 'Full card';
  if (item.troubled && item.nextDate !== null && item.nextDate < mainDate) {
    return `~${formatDate(item.nextDate, now)}`;
  }
  return `Full card, ~${formatDate(mainDate, now)}`;
}

/** What one rep says about the items, for the history table. Null when it scored none. */
export function repItemMarks(
  rep: RepetitionStatusInterface,
  summary: MultiLineSummary,
): { partial: boolean; tested: number; marks: { remId: string; score: QueueInteractionScore | null }[] } | null {
  if (!isGradeable(rep.score)) return null;
  const scores = (rep as MultiLineRep).subCardScores;
  const marks = summary.items.map(({ remId }) => ({
    remId,
    // A rep with no item scores, such as Forgot all, counts for every item.
    score: scores?.length ? scores.find((s) => s.remId === remId)?.score ?? null : rep.score,
  }));
  return {
    partial: !countsForMainCard(rep),
    tested: marks.filter((mark) => mark.score !== null).length,
    marks,
  };
}
