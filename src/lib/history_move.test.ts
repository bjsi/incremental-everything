/**
 * "Move to another Rem" (lib/history_edit.ts › moveHistoryEntryTime): the
 * review's time goes to the target as a stats-only 'movedRep', its queue
 * footprint stays on the source, and neither schedule moves. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IncrementalRep,
  entryCountsForStats,
  entryWasReviewHere,
  originalReviewSeconds,
} from './incremental_rem/types';
import { getCurrentInterval, sameDayRepeatIndexes } from './scheduler_core';
import { getRepsSinceLastMadeIncremental, removeLastInteraction } from './scheduler';
import { moveHistoryEntryTime, moveHistoryEntryTimeBack, moveRefusal } from './history_edit';
import { powerupCode, repHistorySlotCode } from './consts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 10, 1, 9, 0, 0).getTime();

const review = (day: number, over: Partial<IncrementalRep> = {}): IncrementalRep => ({
  date: T0 + day * DAY,
  scheduled: T0 + day * DAY,
  interval: 5,
  reviewTimeSeconds: 600,
  eventType: 'rep',
  ...over,
});

// ── A fake plugin: two IncRems whose History slots live in a map ──────────────

function fakePlugin(histories: Record<string, IncrementalRep[]>, opts: { failWritesTo?: string } = {}) {
  const slots: Record<string, string> = {};
  for (const [id, h] of Object.entries(histories)) slots[id] = JSON.stringify(h);
  const session: Record<string, unknown> = {};
  const rem = (id: string) => ({
    _id: id,
    text: [`Rem ${id}`],
    hasPowerup: async (code: string) => code === powerupCode && id in slots,
    getPowerupProperty: async (_code: string, slot: string) => (slot === repHistorySlotCode ? slots[id] : ''),
    setPowerupProperty: async (_code: string, slot: string, value: string[]) => {
      if (opts.failWritesTo === id) throw new Error('write failed');
      if (slot === repHistorySlotCode) slots[id] = value[0];
    },
    getParentRem: async () => undefined,
  });
  const plugin = {
    rem: { findOne: async (id: string) => (id in slots ? rem(id) : undefined) },
    storage: {
      getSession: async (k: string) => session[k],
      setSession: async (k: string, v: unknown) => {
        session[k] = v;
      },
    },
    richText: {
      normalize: async (t: unknown) => t,
      toString: async (t: unknown[]) => t.join(''),
    },
  } as any;
  const read = (id: string): IncrementalRep[] => JSON.parse(slots[id]);
  return { plugin, read, session };
}

describe('moved-time predicates', () => {
  it('a review whose time all went elsewhere stops counting for stats, but stays a review here', () => {
    const shell = review(0, { reviewTimeSeconds: undefined, context: { movedTo: [{ remId: 'B', seconds: 600, at: 1 }] } });
    assert.equal(entryCountsForStats(shell), false);
    assert.equal(entryWasReviewHere(shell), true);
    assert.equal(originalReviewSeconds(shell), 600);
  });

  it('a review that kept part of its time still counts', () => {
    const split = review(0, { reviewTimeSeconds: 200, context: { movedTo: [{ remId: 'B', seconds: 400, at: 1 }] } });
    assert.equal(entryCountsForStats(split), true);
    assert.equal(originalReviewSeconds(split), 600);
  });

  it("'movedRep' counts for stats and nowhere in scheduling", () => {
    const moved = review(3, { eventType: 'movedRep', interval: undefined });
    assert.equal(entryCountsForStats(moved), true);
    assert.equal(entryWasReviewHere(moved), false);
    const history = [review(0, { interval: 4 }), moved];
    assert.equal(getRepsSinceLastMadeIncremental(history).length, 1);
    assert.equal(getCurrentInterval(history), 4);
    // A same-day pair: the moved entry neither is a repeat nor makes one.
    const sameDay = [review(0), review(0, { eventType: 'movedRep', date: T0 + 3600_000, scheduled: T0 + 5 * DAY })];
    assert.equal(sameDayRepeatIndexes(sameDay).size, 0);
  });

  it('lookback mode redoes the last review, never a moved-in entry after it', () => {
    const history = [review(0), review(2), review(3, { eventType: 'movedRep' })];
    const redone = removeLastInteraction(history);
    assert.deepEqual(redone.map((r) => r.eventType), ['rep', 'movedRep']);
  });

  it('refuses markers, moved-in time, empty records and pending Companion hand-offs', () => {
    assert.match(moveRefusal(review(0, { eventType: 'madeIncremental' }))!, /Only reviews/);
    assert.match(moveRefusal(review(0, { eventType: 'movedRep' }))!, /move it back/);
    assert.match(moveRefusal(review(0, { reviewTimeSeconds: 0 }))!, /no time/);
    const now = T0 + 1000;
    assert.match(moveRefusal(review(0, { context: { companionHandoffAt: T0 } }), now)!, /Companion/);
    assert.equal(moveRefusal(review(0, { context: { companionHandoffAt: T0, companionSeconds: 5 } }), now), null);
    assert.equal(moveRefusal(review(0)), null);
  });
});

describe('moveHistoryEntryTime', () => {
  const source = () => [
    { date: T0 - DAY, scheduled: T0 - DAY, eventType: 'madeIncremental', interval: 1 } as IncrementalRep,
    review(0, { interval: 3, notes: 'p. 51 onward', context: { page: 51, pdfName: 'N311' } }),
    review(4, { interval: 6, nextRepMs: T0 + 10 * DAY }),
  ];
  const target = () => [review(1, { interval: 2 }), review(5, { interval: 4, nextRepMs: T0 + 9 * DAY })];

  it('moves all of a review: the target gets a stats-only entry, both schedules stay', async () => {
    const { plugin, read } = fakePlugin({ A: source(), B: target() });
    const before = { a: read('A'), b: read('B') };
    const result = await moveHistoryEntryTime(plugin, 'A', before.a[1], 'B');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.movedSeconds, 600);

    const a = read('A');
    const b = read('B');
    // Source: same length and place, same scheduling fields, no time.
    assert.equal(a.length, 3);
    assert.equal(a[1].eventType, 'rep');
    assert.equal(a[1].interval, 3);
    assert.equal(a[1].reviewTimeSeconds, undefined);
    assert.equal(a[1].context?.movedTo?.[0].remId, 'B');
    assert.equal(a[2].nextRepMs, T0 + 10 * DAY);
    assert.equal(getRepsSinceLastMadeIncremental(a).length, getRepsSinceLastMadeIncremental(before.a).length);
    assert.equal(getCurrentInterval(a), getCurrentInterval(before.a));

    // Target: inserted in date order, carries the reading context, not the schedule.
    assert.deepEqual(b.map((r) => r.eventType), ['movedRep', 'rep', 'rep']);
    const moved = b[0];
    assert.equal(moved.reviewTimeSeconds, 600);
    assert.equal(moved.interval, undefined);
    assert.equal(moved.nextRepMs, undefined);
    assert.equal(moved.notes, 'p. 51 onward');
    assert.equal(moved.context?.page, 51);
    assert.equal(moved.context?.movedFromId, 'A');
    assert.equal(b[2].nextRepMs, T0 + 9 * DAY);
    assert.equal(getRepsSinceLastMadeIncremental(b).length, getRepsSinceLastMadeIncremental(before.b).length);
    assert.equal(getCurrentInterval(b), getCurrentInterval(before.b));

    // Stats: the rep and its time are counted once, on the target.
    const stats = (h: IncrementalRep[]) => h.filter(entryCountsForStats);
    assert.equal(stats(a).length + stats(b).length, stats(before.a).length + stats(before.b).length);
    const time = (h: IncrementalRep[]) => stats(h).reduce((s, r) => s + (r.reviewTimeSeconds ?? 0), 0);
    assert.equal(time(a) + time(b), time(before.a) + time(before.b));
  });

  it('keeps the next-rep stamp on the last entry when the moved entry lands last', async () => {
    const { plugin, read } = fakePlugin({ A: [review(0), review(8)], B: [review(1, { nextRepMs: T0 + 9 * DAY })] });
    const result = await moveHistoryEntryTime(plugin, 'A', read('A')[1], 'B');
    assert.equal(result.ok, true, result.error);
    const b = read('B');
    assert.equal(b[1].eventType, 'movedRep');
    assert.equal(b[1].nextRepMs, T0 + 9 * DAY, "the target's own stamp, never the source's");
  });

  it('splits a review, then undoes each move from either side', async () => {
    const { plugin, read } = fakePlugin({ A: source(), B: target(), C: [review(2)] });
    assert.equal((await moveHistoryEntryTime(plugin, 'A', read('A')[1], 'B', 240)).ok, true);
    assert.equal((await moveHistoryEntryTime(plugin, 'A', read('A')[1], 'C')).ok, true);
    const shell = read('A')[1];
    assert.equal(shell.reviewTimeSeconds, undefined);
    assert.deepEqual(shell.context?.movedTo?.map((m) => [m.remId, m.seconds]), [['B', 240], ['C', 360]]);

    // Undo the C move from the source side, the B move from the target's entry.
    const toC = shell.context!.movedTo![1];
    assert.equal((await moveHistoryEntryTimeBack(plugin, 'A', 'C', toC.at)).ok, true);
    const movedB = read('B').find((r) => r.eventType === 'movedRep')!;
    assert.equal((await moveHistoryEntryTimeBack(plugin, 'A', 'B', movedB.context!.movedAt!)).ok, true);

    assert.deepEqual(read('A'), source());
    assert.deepEqual(read('B'), target());
    assert.deepEqual(read('C'), [review(2)]);
  });

  it('refuses a target that is not Incremental, the source itself, and too much time', async () => {
    const { plugin, read } = fakePlugin({ A: source(), B: target() });
    const entry = read('A')[1];
    assert.equal((await moveHistoryEntryTime(plugin, 'A', entry, 'A')).ok, false);
    assert.equal((await moveHistoryEntryTime(plugin, 'A', entry, 'nope')).ok, false);
    assert.equal((await moveHistoryEntryTime(plugin, 'A', entry, 'B', 9999)).ok, false);
    assert.deepEqual(read('A'), source());
    assert.deepEqual(read('B'), target());
  });

  it('refuses while a review of either Rem is still being saved', async () => {
    const { plugin, read, session } = fakePlugin({ A: source(), B: target() });
    session['pendingReviewJobQueue'] = [{ remId: 'B' }];
    const result = await moveHistoryEntryTime(plugin, 'A', read('A')[1], 'B');
    assert.equal(result.ok, false);
    assert.match(result.error!, /still being saved/);
  });

  it('rolls the target back when the source write fails', async () => {
    const { plugin, read } = fakePlugin({ A: source(), B: target() }, { failWritesTo: 'A' });
    const result = await moveHistoryEntryTime(plugin, 'A', read('A')[1], 'B');
    assert.equal(result.ok, false);
    assert.deepEqual(read('B'), target());
    assert.deepEqual(read('A'), source());
  });
});
