/**
 * Reviews of deleted Rems (the helper's "ghosts") in the summary statistics.
 * Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueueInteractionScore as Q } from '@remnote/plugin-sdk';
import {
  buildGhostNodes,
  DELETED_ROOT_ID,
  filterGhosts,
  GhostPayload,
  GhostRem,
  GhostRep,
  REMOVED_CARDS_PREFIX,
} from './history_archive';
import {
  aggregatePeriodStatsCombined,
  bucketCardReviews,
  bucketGhostReps,
  encodeAuthoritativeAggregates,
  mergeGhostBuckets,
} from './authoritative_aggregates';
import { DailyAggregate } from './queue_aggregates';

const KB = 'kb000000000000000000000a';
const DAY = 24 * 60 * 60 * 1000;
const CAP = 180_000;
/** Local noon, so nothing here crosses midnight. */
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime();
const at = (days: number, ms = 0) => T0 + days * DAY + ms;

const card = (date: number, score: number, time: number, item = 'c1'): GhostRep => ({
  date, kind: 'card', item, rem: 'r1', score, time, event: null, deletedAt: at(20),
});
const inc = (date: number, seconds: number, event: string | null, kind: 'inc' | 'dism' = 'inc'): GhostRep => ({
  date, kind, item: 'r2', rem: 'r2', score: null, time: seconds * 1000, event, deletedAt: at(20),
});
const payload = (reps: GhostRep[]): GhostPayload => ({ reps, rems: {} });
const store = (buckets: DailyAggregate[], n = 0) => ({ ...encodeAuthoritativeAggregates(buckets), n, at: at(21) });

describe('filterGhosts', () => {
  it('drops a ghost whose timestamp a live history still holds (Preserve history & remove)', () => {
    // The tombstone's dismissedHistory holds the card rep as importedRep, same date.
    const live = new Set([at(1)]);
    const kept = filterGhosts(payload([card(at(1), Q.GOOD, 5000), card(at(2), Q.GOOD, 5000)]), live);
    assert.deepEqual(kept.map((r) => r.date), [at(2)]);
  });

  it('keeps one copy per timestamp', () => {
    const kept = filterGhosts(payload([card(at(1), Q.GOOD, 5000), inc(at(1), 9, 'importedRep', 'dism')]), new Set());
    assert.equal(kept.length, 1);
    assert.equal(kept[0].kind, 'card');
  });
});

describe('bucketGhostReps', () => {
  it('uses the live walk\'s rules: real scores only, card time capped, IncRem time not', () => {
    const b = bucketGhostReps(
      [
        card(at(1), Q.AGAIN, 400_000), // capped at 180 s, counts as forgotten
        card(at(1, 1000), Q.TOO_EARLY, 5000), // not a review
        card(at(1, 2000), Q.EASY, 3000),
        inc(at(1, 3000), 600, 'rep'), // 10 min, uncapped
        inc(at(1, 4000), 30, null, 'dism'), // legacy rep, no eventType: counts
        inc(at(1, 5000), 30, 'madeIncremental'), // not a review
      ],
      KB,
      CAP
    );
    assert.equal(b.length, 1);
    assert.equal(b[0].cardsCount, 2);
    assert.equal(b[0].cardsTime, CAP + 3000);
    assert.equal(b[0].forgotCount, 1);
    assert.equal(b[0].incRemsCount, 2);
    assert.equal(b[0].incRemsTime, 630_000);
    assert.equal(b[0].totalTime, CAP + 3000 + 630_000);
  });

  it('matches bucketCardReviews for the same reps', () => {
    const reps = [card(at(1), Q.GOOD, 7000), card(at(2), Q.HARD, 200_000), card(at(2, 9), Q.AGAIN, 1000)];
    const fromLive: DailyAggregate[] = [];
    bucketCardReviews(
      [{ repetitionHistory: reps.map((r) => ({ date: r.date, score: r.score, responseTime: r.time })) }],
      KB,
      CAP,
      fromLive
    );
    const strip = (bs: DailyAggregate[]) => bs.map(({ ids, ...rest }) => rest);
    assert.deepEqual(strip(bucketGhostReps(reps, KB, CAP)), strip(fromLive));
  });
});

describe('mergeGhostBuckets', () => {
  const authoritative = bucketGhostReps([card(at(1), Q.GOOD, 10_000)], KB, CAP); // stands in for live reps
  const ghosts = bucketGhostReps([card(at(1, 60_000), Q.GOOD, 20_000), card(at(3), Q.GOOD, 30_000)], KB, CAP);

  it('adds ghost days to the authoritative ones', () => {
    const merged = mergeGhostBuckets(authoritative, store(ghosts, 2), KB, at(10));
    const s = aggregatePeriodStatsCombined(merged, [], [], at(10), 0);
    assert.equal(s.cardsCount, 3);
    assert.equal(s.cardsTime, 60_000);
  });

  it('leaves out ghost days after the authoritative compute (listener sessions count those)', () => {
    const merged = mergeGhostBuckets(authoritative, store(ghosts, 2), KB, at(2));
    const s = aggregatePeriodStatsCombined(merged, [], [], at(2), 0);
    assert.equal(s.cardsCount, 2);
  });

  it('adds nothing without authoritative data, or without a ghost key', () => {
    assert.deepEqual(mergeGhostBuckets([], store(ghosts), KB, at(10)), []);
    assert.equal(mergeGhostBuckets(authoritative, null, KB, at(10)), authoritative);
  });

  it('ignores another KB\'s ghosts', () => {
    const other = bucketGhostReps([card(at(1), Q.GOOD, 1)], 'kb000000000000000000000b', CAP);
    const merged = mergeGhostBuckets(authoritative, store(other), KB, at(10));
    assert.equal(aggregatePeriodStatsCombined(merged, [], [], at(10), 0).cardsCount, 1);
  });

  it('pre-cutoff IncRem days still take the larger of archive and listener, not their sum', () => {
    // 2025: before INCREM_AUTHORITATIVE_CUTOFF_DATE. The listener saw the session
    // live (2 reps, 120 s); the archive holds the same 2 reps of a deleted IncRem.
    const day = new Date(2025, 5, 2, 12).getTime();
    const auth = bucketGhostReps([card(day, Q.GOOD, 1000)], KB, CAP);
    const ghost = bucketGhostReps([inc(day, 60, 'rep'), inc(day + 1, 60, 'rep')], KB, CAP);
    const listener: DailyAggregate[] = [
      { ...ghost[0], cardsCount: 0, cardsTime: 0, forgotCount: 0, ids: [] },
    ];
    const s = aggregatePeriodStatsCombined(mergeGhostBuckets(auth, store(ghost), KB, at(10)), [], listener, at(10), 0);
    assert.equal(s.incRemsCount, 2);
    assert.equal(s.incRemsTime, 120_000);
  });
});

describe('buildGhostNodes', () => {
  const rem = (id: string, parent: string | null, state: GhostRem['state'] = 'trash'): GhostRem => ({
    id, text: id.toUpperCase(), state, deletedAt: at(20), parent,
  });
  const onRem = (date: number, remId: string, item = 'c-' + remId): GhostRep => ({
    ...card(date, Q.GOOD, 1000, item), rem: remId,
  });

  it('keeps a deleted subtree under its nearest live ancestor', () => {
    // live L > deleted A > deleted B (holds the reps)
    const rems = { L: rem('L', 'X', 'live'), A: rem('A', 'L'), B: rem('B', 'A') };
    const nodes = buildGhostNodes([onRem(at(1), 'B'), onRem(at(2), 'B')], rems);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    assert.deepEqual(Object.keys(byId).sort(), ['A', 'B']);
    assert.equal(byId.B.parentId, 'A');
    assert.equal(byId.A.parentId, 'L');
    assert.equal(byId.B.cards[0].history.length, 2);
    assert.equal(byId.A.cards.length, 0);
  });

  it('puts chains with no live ancestor under the Deleted Rems root', () => {
    const nodes = buildGhostNodes([onRem(at(1), 'B')], { A: rem('A', null), B: rem('B', 'A') });
    assert.equal(nodes.find((n) => n.id === 'A')!.parentId, DELETED_ROOT_ID);
  });

  it('gives a live Rem\'s deleted cards a node of their own under it', () => {
    const nodes = buildGhostNodes([onRem(at(1), 'L')], { L: rem('L', null, 'live') });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, REMOVED_CARDS_PREFIX + 'L');
    assert.equal(nodes[0].parentId, 'L');
  });

  it('files IncRem and Dismissed reps on the Rem, with times in seconds', () => {
    const nodes = buildGhostNodes(
      [{ ...inc(at(1), 90, 'rep'), rem: 'R', item: 'R' }, { ...inc(at(2), 30, null, 'dism'), rem: 'R', item: 'R' }],
      { R: rem('R', null) }
    );
    const r = nodes.find((n) => n.id === 'R')!;
    assert.deepEqual(r.incHistory, [{ date: at(1), eventType: 'rep', reviewTimeSeconds: 90 }]);
    assert.deepEqual(r.dismHistory, [{ date: at(2), eventType: undefined, reviewTimeSeconds: 30 }]);
  });

  it('draws no node for a Rem whose ghosts were all filtered out', () => {
    const rems = { L: rem('L', null, 'live'), A: rem('A', 'L'), B: rem('B', 'L') };
    const reps = filterGhosts(payload([onRem(at(1), 'A'), onRem(at(2), 'B')]), new Set([at(1)]));
    assert.deepEqual(buildGhostNodes(reps, rems).map((n) => n.id), ['B']);
  });
});
